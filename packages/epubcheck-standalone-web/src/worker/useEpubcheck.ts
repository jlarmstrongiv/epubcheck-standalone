import { useCallback, useEffect, useRef, useState } from "react";
import { proxy } from "comlink";
import { spawnWorker } from "./spawnWorker";
import type { RemoteWorker } from "./spawnWorker";
import type { EpubcheckInterface } from "./epubcheck.worker";
import { validateUrl as validateUrlMainThread } from "./validateUrlMainThread";
import { prewarmBookBytes, PREWARM_BOOK_NAME } from "./prewarmBook";
import type { ReportMessage } from "./vendor";
import type { ValidationResult } from "./types";
// Vite gives us the bundled worker script URL. Loaded as a MODULE worker
// (see astro.config vite.worker.format = "es").
import epubcheckWorkerUrl from "./epubcheck.worker?worker&url";

export type EpubcheckStatus =
  | "idle"
  | "validating"
  | "done"
  | "error"
  | "cancelled";

const workerOptions: WorkerOptions = {
  name: "epubcheck",
  type: "module",
};

// A busy main thread can starve requestIdleCallback indefinitely; this cap makes
// the warm-up eventually fire even under sustained load, so the feature still
// helps in exactly the loaded conditions where a warm engine matters most.
const PREWARM_IDLE_TIMEOUT_MS = 3000;

export interface UseEpubcheck {
  status: EpubcheckStatus;
  /**
   * True from page load (and during a post-crash re-warm) until the engine
   * pre-warm completes. The engine emits no progress, so this is an indeterminate
   * "engine is starting up" signal, distinct from a `status === "validating"`
   * run. A real run started while this is true queues behind the warm-up, so the
   * UI stays truthfully "initializing" until the warm-up resolves.
   */
  initializing: boolean;
  result: ValidationResult | null;
  error: string | null;
  /**
   * Cancel the in-flight run and return to a non-running state (never `error` —
   * a user cancel is not a failure). For a worker run this terminates + disposes
   * the worker (the README's one guaranteed hard stop; the disposed worker's
   * replacement is re-warmed in the background); for the main-thread URL run it
   * aborts the library's `signal`. A no-op when nothing is running.
   */
  cancel: () => void;
  /**
   * Surface a pre-run failure (e.g. a sample fixture that failed to fetch)
   * through the same error channel a failed validation uses, without having
   * started a run.
   */
  reportError: (message: string) => void;
  /**
   * Checker messages streamed live from the worker's report tap, in emission
   * order. Populated AS the run proceeds so the table fills in live; the same
   * set is also on `result.messages` once validate() resolves.
   */
  liveMessages: ReportMessage[];
  /**
   * Validate a picked file. `args` is the epubcheck CLI argument list the demo's
   * options row builds (profile, locale, usage, single-file mode); it is placed
   * before the input path exactly like the stock CLI. Omit or pass an empty
   * array for the plain default container validation. `customMessages`, when
   * supplied, is the EPUBCheck message-override file's text content forwarded
   * to the library's `-c/--customMessages`.
   */
  validate: (
    file: File,
    args?: string[],
    customMessages?: string,
  ) => Promise<ValidationResult>;
  /**
   * Validate a packaged EPUB fetched from an http(s) URL. `args` is the same
   * options-row argument list as `validate` (single-file `--mode`/`-v` is never
   * part of it, since a URL is always a whole container). `customMessages` is
   * the optional message-override text. This runs on the main thread (the
   * engine suspends mid-run for the library's async fetch, so no worker is
   * needed); the download is subject to the target server's CORS policy.
   */
  validateUrl: (
    url: string,
    args?: string[],
    customMessages?: string,
  ) => Promise<ValidationResult>;
  /**
   * Validate an expanded (unzipped) EPUB directory. `files` are the File objects
   * gathered on the main thread (a folder drop or an `<input webkitdirectory>`
   * picker); `paths` is a parallel array of relative '/'-separated paths with
   * the folder root already stripped; `name` is the folder's own name (the
   * reported name and report basename). `args` is the same options-row argument
   * list as `validate` (single-file `--mode`/`-v` is never part of it); the
   * library validates a directory source in place by default (dirMode
   * 'direct') and rejects a conflicting user-supplied `--mode`/`-m`.
   */
  validateDirectory: (
    files: File[],
    paths: string[],
    name: string,
    args?: string[],
    customMessages?: string,
  ) => Promise<ValidationResult>;
}

// The library's engine REUSES its runtime across validations (warm runs skip the
// runtime rebuild + JIT warmup entirely), and that warm scope lives in the
// worker's module state. So the worker is PERSISTENT: it is spawned lazily on the
// first File/directory validation and kept alive across validations, so repeat
// runs land on the warm-engine fast path automatically. It is torn down only on
// component unmount (page teardown) or when the worker context itself dies (a
// watchdog replaces it on the next run). A rejected validate() is an engine-scope
// error the library already cleans up internally (see engine-run.ts SCOPE REUSE):
// the worker context stays reusable, so we never throw the worker away per run.
// Same typed-worker pattern as fontquant-pyodide.
export function useEpubcheck(): UseEpubcheck {
  const [status, setStatus] = useState<EpubcheckStatus>("idle");
  const [initializing, setInitializing] = useState(false);
  const [result, setResult] = useState<ValidationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [liveMessages, setLiveMessages] = useState<ReportMessage[]>([]);

  // The persistent worker (null until the first File/directory validation spawns
  // it). `spawningRef` holds the in-flight handshake so concurrent getWorker
  // calls share one spawn; `aliveRef` is flipped false by the post-handshake
  // watchdog when the worker context dies, so the next run replaces it.
  const workerRef = useRef<RemoteWorker<EpubcheckInterface> | null>(null);
  const spawningRef = useRef<Promise<
    RemoteWorker<EpubcheckInterface>
  > | null>(null);
  const aliveRef = useRef(true);
  // Holds the in-flight (or settled) warm-up run for the CURRENT worker, so the
  // warm-up fires at most once per worker even under React strict-mode double
  // effects and remounts. Cleared in disposeWorker so a replacement worker gets
  // warmed again — and runValidation re-schedules the warm-up right after it
  // drops a dead worker, so a crash-replaced worker actually gets re-warmed
  // (not merely eligible to be).
  const prewarmRef = useRef<Promise<void> | null>(null);

  // Canceller for the in-flight run (worker terminate, or URL abort), or null
  // when nothing is running. Set by whichever run path is active; cleared once
  // the run settles or is cancelled.
  const cancelRef = useRef<(() => void) | null>(null);
  // Monotonic run token. `cancel` bumps it so a run whose promise settles AFTER
  // it was cancelled (or a terminated worker's forever-pending comlink call that
  // can never settle) can never write stale status/result back into the UI.
  const runTokenRef = useRef(0);

  // Terminate and forget the current worker. Called on unmount (page teardown)
  // and when a dead worker must be dropped before spawning its replacement —
  // NEVER per run on the happy path (that would discard the warm engine).
  const disposeWorker = useCallback(() => {
    spawningRef.current = null;
    prewarmRef.current = null;
    const spawned = workerRef.current;
    workerRef.current = null;
    if (spawned) spawned.worker.terminate();
  }, []);

  // Return the live persistent worker, spawning it lazily on first use. A worker
  // whose context has died (aliveRef flipped false) is dropped and replaced. A
  // concurrent call in flight shares the same spawn promise.
  const getWorker = useCallback((): Promise<
    RemoteWorker<EpubcheckInterface>
  > => {
    const existing = workerRef.current;
    if (existing && aliveRef.current) return Promise.resolve(existing);
    if (existing) disposeWorker();
    if (spawningRef.current) return spawningRef.current;

    aliveRef.current = true;
    const abortController = new AbortController();
    const promise = spawnWorker<EpubcheckInterface>({
      scriptUrl: epubcheckWorkerUrl,
      options: workerOptions,
      abortController,
    }).then(
      (spawned) => {
        // Watchdog: a worker-level crash AFTER the handshake (an uncaught error
        // or the JS context dying) takes the cached warm engine with it and
        // leaves the comlink remote unusable, so mark it dead — the next run
        // replaces it. spawnWorker removed its own handshake listeners on READY,
        // so these are the only post-handshake error listeners.
        const markDead = (): void => {
          aliveRef.current = false;
        };
        spawned.worker.addEventListener("error", markDead);
        spawned.worker.addEventListener("messageerror", markDead);
        workerRef.current = spawned;
        spawningRef.current = null;
        return spawned;
      },
      (err) => {
        spawningRef.current = null;
        throw err;
      },
    );
    spawningRef.current = promise;
    return promise;
  }, [disposeWorker]);

  // Tear the worker down when the demo unmounts (page teardown). This is the
  // only lifecycle-driven termination; per-run termination is gone.
  useEffect(() => disposeWorker, [disposeWorker]);

  // Pre-warm on page load: eagerly spawn the persistent worker and have it
  // silently validate a tiny embedded VALID EPUB. That runs the library's
  // engine main() once to a clean completion inside the worker, so its reused
  // runtime scope is cached warm — the user's first File/directory validation
  // then skips the ~5-8 s cold engine parse and lands on the warm fast path.
  //
  // This is COMPLETELY invisible: it reuses the same getWorker() + remote
  // validate path real runs use (so the library's per-thread run queue simply
  // serializes a real run that starts mid-warm-up behind it, and it still
  // benefits), but it never touches any React state — no result, no live
  // messages (onMessage is omitted), no status change, no log lines. A failure
  // is swallowed (logged at most) so it can never break the first real
  // validation, and it cannot wrongly trip the death watchdog: a library engine
  // error is returned as a rejected promise we catch here, not a worker-context
  // crash. The URL path stays cold on purpose (its runtime is download-bound).
  const prewarm = useCallback((): Promise<void> => {
    if (prewarmRef.current) return prewarmRef.current;
    // The engine is initializing until this warm-up settles; surfacing that lets
    // the UI show a truthful "preparing the engine" state (the warmup() promise
    // resolving is the signal). schedulePrewarm also sets it so the window
    // between page load and the idle callback firing already reads as init.
    setInitializing(true);
    const promise = (async () => {
      try {
        const spawned = await getWorker();
        const file = new File([prewarmBookBytes()], PREWARM_BOOK_NAME, {
          type: "application/epub+zip",
        });
        // Dedicated warm-up remote: no report files (so a single engine pass,
        // not the three a report-mode run would do) and no onMessage sink, so
        // nothing streams anywhere. The run is discarded — it exists only to
        // prime the reused engine scope.
        await spawned.remote.warmup(file);
      } catch (err) {
        // Never let a warm-up failure surface or block a real run.
        console.debug?.("epubcheck warm-up skipped:", err);
      } finally {
        setInitializing(false);
      }
    })();
    prewarmRef.current = promise;
    return promise;
  }, [getWorker]);

  // Schedule the warm-up on an idle callback so it never delays the page
  // becoming interactive. It is given a timeout so a persistently busy main
  // thread cannot starve it forever (see PREWARM_IDLE_TIMEOUT_MS).
  // requestIdleCallback is absent on some browsers (notably Safari), so fall
  // back to a short timeout. Returns a canceller for a not-yet-fired warm-up:
  // the mount effect uses it as cleanup, which is what makes strict-mode's
  // mount/unmount/mount fire the warm-up exactly once; prewarmRef guards any
  // residual double-invocation. The crash-replacement re-warm ignores the
  // canceller (best effort).
  const schedulePrewarm = useCallback((): (() => void) => {
    if (typeof window === "undefined") return () => {};
    // Reflect "initializing" from the moment the warm-up is scheduled (page load
    // or a post-crash re-warm), not only once the idle callback fires; prewarm()
    // clears it when the warm-up settles.
    setInitializing(true);
    let cancelled = false;
    const kick = (): void => {
      if (!cancelled) void prewarm();
    };
    const idle = window.requestIdleCallback;
    if (idle) {
      const id = idle.call(window, kick, { timeout: PREWARM_IDLE_TIMEOUT_MS });
      return () => {
        cancelled = true;
        window.cancelIdleCallback?.(id);
      };
    }
    const id = window.setTimeout(kick, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(id);
    };
  }, [prewarm]);

  // Fire the initial warm-up after mount.
  useEffect(() => schedulePrewarm(), [schedulePrewarm]);

  // Shared run-state scaffold: reset state, run, then record the outcome. `run`
  // gets an onMessage sink that appends each parsed message so the table renders
  // live. This is the piece every entry point shares regardless of WHERE the
  // engine runs — a spawned worker (file/directory) or the main thread (URL).
  const withRunState = useCallback(
    async (
      run: (
        onMessage: (message: ReportMessage) => void,
      ) => Promise<ValidationResult>,
    ): Promise<ValidationResult> => {
      const token = ++runTokenRef.current;
      setStatus("validating");
      setResult(null);
      setError(null);
      setLiveMessages([]);

      try {
        const res = await run((message: ReportMessage) => {
          setLiveMessages((prev) => [...prev, message]);
        });
        cancelRef.current = null;
        // A cancel (or a superseding run) bumped the token: the UI state it set
        // is authoritative, so this settled run must not overwrite it.
        if (runTokenRef.current !== token) return res;
        setResult(res);
        setStatus("done");
        return res;
      } catch (err) {
        cancelRef.current = null;
        if (runTokenRef.current !== token) throw err; // cancelled: leave UI as-is
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        setStatus("error");
        throw err;
      }
    },
    [],
  );

  // Cancel the in-flight run. Bumps the run token FIRST so the (about-to-settle
  // or forever-pending) run promise can never write stale state back, then runs
  // the active path's canceller (worker terminate / URL abort), then returns the
  // UI to a non-running, non-error "cancelled" state. A user cancel is not a
  // failure, so no error alert. No-op when nothing is running.
  const cancel = useCallback(() => {
    const doCancel = cancelRef.current;
    if (!doCancel) return;
    cancelRef.current = null;
    runTokenRef.current++;
    doCancel();
    setStatus("cancelled");
    setResult(null);
    setError(null);
    setLiveMessages([]);
  }, []);

  // Surface a pre-run failure through the same error channel a failed run uses.
  // Used for failures that happen BEFORE a run starts (e.g. a sample fixture
  // fetch failing), so the user sees the standard error alert rather than a
  // silent no-op or a misleading "invalid" verdict.
  const reportError = useCallback((message: string) => {
    setStatus("error");
    setError(message);
    setResult(null);
    setLiveMessages([]);
  }, []);

  // Worker scaffold: reuse the persistent worker (spawning it lazily on the first
  // run), hand the remote the shared live-message sink, and KEEP it alive after
  // the run so the next validation hits the library's warm-engine fast path.
  // `invoke` performs the actual remote call (single file or directory). URL
  // validation does NOT use this path — it runs on the main thread (see
  // validateUrl below).
  const runValidation = useCallback(
    (
      invoke: (
        remote: RemoteWorker<EpubcheckInterface>["remote"],
        onMessage: (message: ReportMessage) => void,
      ) => Promise<ValidationResult>,
    ): Promise<ValidationResult> =>
      withRunState(async (onMessage) => {
        const spawned = await getWorker();
        // Worker cancel = terminate + dispose the worker (the README's one
        // guaranteed hard stop; a cooperative signal cannot cross the worker
        // boundary), then re-warm the replacement in the background. The pending
        // comlink call can never settle after termination, so the run token
        // (bumped in cancel) is what keeps this run from writing stale state.
        cancelRef.current = () => {
          disposeWorker();
          schedulePrewarm();
        };
        try {
          // The worker calls onMessage back across the thread boundary for each
          // parsed message; `invoke` wraps it in comlink's proxy() at the actual
          // remote call site.
          return await invoke(spawned.remote, onMessage);
        } finally {
          // Keep the worker warm for the next validation. Replace it only when
          // the worker context itself died (the watchdog flipped aliveRef): an
          // engine-scope error the library already cleaned up internally leaves
          // the worker reusable, so it must NOT be terminated per run. When we
          // do drop a dead worker, re-schedule the warm-up so its replacement
          // is primed in the background before the next real run (disposeWorker
          // cleared prewarmRef, so this warms the NEW worker, not the dead one).
          if (!aliveRef.current) {
            disposeWorker();
            schedulePrewarm();
          }
        }
      }),
    [withRunState, getWorker, disposeWorker, schedulePrewarm],
  );

  const validate = useCallback(
    (
      file: File,
      args: string[] = [],
      customMessages?: string,
    ): Promise<ValidationResult> =>
      runValidation((remote, onMessage) =>
        remote.validate(file, args, customMessages, proxy(onMessage)),
      ),
    [runValidation],
  );

  // URL validation runs on the main thread, not in a worker: the library's
  // url() source suspends the engine mid-run for its async fetch, so no worker
  // is needed. onMessage is a direct callback here (no comlink proxy). The
  // shared withRunState scaffold gives it the same status/result/error/live
  // states — and, because every input is disabled while a run is in flight, the
  // same effective single-run-at-a-time behavior the worker route had.
  const validateUrl = useCallback(
    (
      url: string,
      args: string[] = [],
      customMessages?: string,
    ): Promise<ValidationResult> =>
      withRunState((onMessage) => {
        // URL cancel is a genuine cooperative abort: the engine suspends on this
        // thread for the async download, so an AbortSignal actually stops it.
        const controller = new AbortController();
        cancelRef.current = () => controller.abort();
        return validateUrlMainThread(
          url,
          args,
          customMessages,
          onMessage,
          controller.signal,
        );
      }),
    [withRunState],
  );

  const validateDirectory = useCallback(
    (
      files: File[],
      paths: string[],
      name: string,
      args: string[] = [],
      customMessages?: string,
    ): Promise<ValidationResult> =>
      runValidation((remote, onMessage) =>
        remote.validateDirectory(
          files,
          paths,
          name,
          args,
          customMessages,
          proxy(onMessage),
        ),
      ),
    [runValidation],
  );

  return {
    status,
    initializing,
    cancel,
    reportError,
    result,
    error,
    liveMessages,
    validate,
    validateUrl,
    validateDirectory,
  };
}
