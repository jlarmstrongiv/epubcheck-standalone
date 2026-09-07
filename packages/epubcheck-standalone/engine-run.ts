// epubcheck-standalone -- isomorphic engine driver (internal).
//
// The engine is the TeaVM JS-backend build of the real epubcheck 5.3.0
// (com.adobe.epubcheck.tool.EpubChecker). It ships as ONE big UMD JavaScript
// file (~21 MB) that exposes a single `main(args, callback)` entry, and it talks
// to the host through a set of globalThis feed/callback names (see
// teavm/src/main/java/EpubCheckTeaVM.java for the Java side):
//
//   feed   __ecSize / __ecRead / __epubName       the packaged epub: total size
//          / __epubArgs                           plus a SYNCHRONOUS range read
//                                                 (the engine pulls byte ranges
//                                                 mid-run -- the book is never
//                                                 materialized whole on either
//                                                 side), the reported name, and
//                                                 the CLI args
//          __ecExtraPaths / __ecExtraB64          extra VFS files (custom
//                                                 messages)
//          __ecDirPaths / __ecDirSizes            expanded-directory listing
//          / __ecDirRead                          (relative paths + sizes) plus
//                                                 a per-file range read served
//                                                 on demand (sync or promise),
//                                                 the directory sibling of
//                                                 __ecSize/__ecRead
//          __ecInputArg                           input path when there is no
//                                                 range-fed epub (directory mode)
//          __ecPlain / __ecRelArg / __ecTZ        run toggles
//   out    __ecExit(code)  __ecJson(json)  __ecFile(name, content)
//          __ecTapMessage(...) / __ecTapInfo(...) the LIVE report-event tap:
//                                                 one call per level-filtered
//                                                 checker message / feature
//                                                 event, mid-run, in emission
//                                                 order (ecshim.ReportTap)
//          plus epubcheck's stdout -> console.info, stderr -> console.error
//
// __ecRead(target, offset, length) fills `target` -- an Int8Array view over the
// requesting Java byte[]'s backing store (TeaVM's JS backend backs byte[] with
// an Int8Array and passes it by reference) -- with exactly the bytes
// [offset, offset + length) and returns the count written. The Java side asks
// for at most 8 MiB at a time (its block-cache size, matching the RangeSource
// contract's documented maximum single read) and never reads past EOF.
//
// SCOPE REUSE: the engine builds its Java runtime as module-load state inside
// a scope created by calling `createEngine()` -- a BUILD-TIME artifact:
// teavm/fix-generated.ts wraps the engine's UMD body in an exported
// `createEngine()` factory (a plain function whose body IS the UMD body), so
// CALLING createEngine() runs the body in a brand-new function scope and
// returns the module, with NO eval / new Function / string-to-code anywhere in
// the shipped library (the page's CSP needs no 'unsafe-eval').
//
// One scope can run `main` MORE THAN ONCE: the Java wrapper resets every
// piece of cross-run state at the start of each main() (HostBook/HostDir
// statics and block caches, the /work and /tmp VFS trees -- see
// EpubCheckTeaVM.java), so this driver REUSES one scope across validations. A
// warm run skips the runtime rebuild + JIT warmup entirely. Safety rails:
//  - reuse only after a run whose main() COMPLETED normally (any exit code);
//    a run that rejected or threw may leave torn state (half-flushed console
//    buffers, suspended green threads), so its scope is DISCARDED and the
//    next run calls createEngine() fresh -- the engine-error-cleanup suite
//    exercises exactly this path;
//  - the cached scope is keyed to the factory that made it (a swapped
//    factory, e.g. via the browser's configureEngine, invalidates it);
//  - runs stay serialized through the queue below, so the one cached scope is
//    never entered concurrently.
// Between runs we still clear every feed global and yield ONE macrotask (the
// host injects the yield: Node `setImmediate`, browser `setTimeout(0)`), the
// same discipline as ever. Reused-scope output is byte-identical to
// fresh-scope output -- guarded by the reuse suite and the whole battery,
// which all run through this driver.

// The host-provided way to obtain (and cache) the engine factory, plus the
// one-macrotask yield, are injected so this module stays environment-neutral.

/** One validation run's inputs, already lowered to the engine's feed contract. */
export interface EngineRun {
  /**
   * Total size in bytes of the packaged .epub (globalThis.__ecSize). Set
   * together with `read`; omitted for expanded-directory mode.
   */
  size?: number;
  /**
   * Range read for the packaged .epub: return exactly the bytes
   * [offset, offset + length) -- synchronously (the fast path, consumed
   * inline exactly as before) or as a promise of them (the engine's Java
   * green thread SUSPENDS at its TeaVM @Async seam in ecshim.HostBook until
   * it resolves, the same pause mechanism the URL http bridge uses). Called
   * by the engine MID-RUN (never past EOF, never more than 8 MiB at once),
   * so the backing source must stay open for the whole run. The returned
   * view only needs to stay valid until the next call (the driver copies it
   * into the engine's buffer before the read completes).
   */
  read?: (offset: number, length: number) => Uint8Array | Promise<Uint8Array>;
  /** Reported epub name (globalThis.__epubName). */
  name?: string;
  /** CLI args placed BEFORE the input path (the input path itself is appended by
   *  the Java wrapper). */
  args: string[];
  /**
   * Input path argument used when there is no range-fed epub
   * (globalThis.__ecInputArg): the directory root in expanded-directory mode,
   * or the http(s) URL itself in URL-input mode (the stock CLI's URL branch
   * then downloads it through the async http bridge below, so message
   * locations carry the URL exactly like the jar's).
   */
  inputArg?: string;
  /**
   * Host parent directory (globalThis.__ecHostDir): the REAL directory the
   * input lives in on the host. When set, the engine mounts the input, its
   * feeds, extra files and user.dir under this directory instead of the
   * hardcoded "/work", so epubcheck absolutizes the bare input arg against the
   * real host cwd and prints the host path in its no-container single-file
   * error text (FATAL PKG-008 "Unable to read file") -- byte-identical to the
   * native jar run with cwd=<book dir>, arg=<book name>. Omitted for the
   * library/browser paths that carry no host dir (GRACEFUL DEGRADATION: the
   * engine keeps its "/work" behavior byte-for-byte).
   */
  hostDir?: string;
  /**
   * The input is a DIRECTORY validated in single-file mode
   * (globalThis.__ecInputIsDir; e.g. `--mode xhtml <dir>`). No byte feed is
   * supplied: the engine mounts an empty VFS directory at the input path, so
   * epubcheck's single-file read fails with FATAL(PKG-008) and its location
   * carries the trailing-slash directory form, matching the jar. Set together
   * with `name` and `hostDir` (never with `size`/`read`).
   */
  inputIsDir?: boolean;
  /**
   * Expanded-directory feed (globalThis.__ecDirPaths / __ecDirSizes /
   * __ecDirRead), set together with `inputArg` naming the directory root:
   * the tree's listing (relative '/'-separated paths with sizes) plus a
   * per-file range read. Only the listing crosses up front -- the engine
   * mounts zero-byte placeholders for the tree's shape and pulls each file's
   * bytes MID-RUN through `read` (never past a file's listed size, never
   * more than 8 MiB at once, through the same bounded 64 MiB block cache as
   * the packaged-book feed), so the tree's contents are never materialized
   * whole on either side. `read` may fill synchronously (the fast path) or
   * return a promise (the engine's Java green thread SUSPENDS at its TeaVM
   * @Async seam in ecshim.HostDir until it resolves -- the same pause
   * mechanism as the packaged-book and http feeds). The source must stay
   * open for the whole run.
   */
  dir?: {
    paths: string[];
    sizes: number[];
    read: (path: string, offset: number, length: number) => Uint8Array | Promise<Uint8Array>;
  };
  /**
   * URL-input mode http bridge (globalThis.__epubHttpGet): start an ASYNC GET
   * and call `done` exactly once -- always from a later task/microtask, never
   * re-entrantly -- with the NUL-joined response header string
   * ("S" NUL status NUL handle NUL byteLength, or "E" NUL kind NUL message
   * with kind connect|unknownhost|io). While the GET runs, the engine's Java
   * green thread is SUSPENDED at its TeaVM @Async seam (ecshim.HostHttp) and
   * `main`'s completion callback has not fired yet. Set together with
   * `httpRead`.
   */
  httpGet?: (url: string, done: (response: string) => void) => void;
  /**
   * URL-input mode http bridge (globalThis.__epubHttpRead): fill `target`
   * (an Int8Array view over the requesting Java byte[]) with exactly the body
   * bytes [offset, offset + length) of the fetched response `handle`; return
   * the count written -- synchronously (the fast path, consumed inline) or as
   * a promise of it (the engine's Java green thread SUSPENDS at its TeaVM
   * @Async read seam in ecshim.HostHttp until it settles -- the same pause
   * mechanism as the __ecRead/__ecDirRead feeds, at most once per 8 MiB
   * block). An async fill must write into `target` before resolving; the
   * view stays valid across the suspension.
   */
  httpRead?: (
    target: Int8Array,
    handle: number,
    offset: number,
    length: number,
  ) => number | Promise<number>;
  /**
   * Report-event tap (globalThis.__ecTapMessage / __ecTapInfo): when set, the
   * engine's shadowed DefaultReportImpl mirrors every level-filtered checker
   * message and every feature/info event to these callbacks LIVE, mid-run, in
   * emission order (see ecshim.ReportTap for the contract). `message` receives
   * the structured fields the report writers store (raw text, suggestion,
   * location, context) plus `consoleText`, the exact console line the engine
   * prints for the message. Callbacks run synchronously on the engine's
   * thread with the host console RESTORED (anything they log goes to the real
   * console, not into this run's captured stdout/stderr); a throw would
   * surface inside the engine as this run's failure, so hosts should catch
   * their own callback errors (run-core does).
   */
  tap?: {
    message: (
      id: string,
      severity: string | null,
      message: string | null,
      suggestion: string | null,
      path: string | null,
      line: number,
      column: number,
      context: string | null,
      consoleText: string | null,
    ) => void;
    info: (resource: string | null, feature: string | null, value: string | null) => void;
  };
  /** Extra files to materialize under /work before the run. */
  extraFiles?: { path: string; b64: string }[];
  /** __ecPlain: no --json injection, so stdout/stderr are the plain CLI text. */
  plain: boolean;
  /** __ecRelArg: pass the bare relative input path (cwd is /work). */
  relArg: boolean;
  /** __ecTZ: IANA zone id for report timestamps (defaults to the host zone). */
  tz?: string;
  /**
   * Cooperative cancellation. The driver samples the signal at the host seams
   * that run mid-flight -- the book range read (__ecRead), the directory range
   * read (__ecDirRead), and the http bridge (__epubHttpGet/__epubHttpRead) --
   * and on abort makes the engine experience an IO error there, so the run
   * unwinds at the next seam it touches. Whatever the engine then does with
   * that IO error (swallow it into a FATAL result, or fail the run), the
   * driver's own aborted flag forces the run's promise to REJECT with the
   * signal's reason, and the engine scope is NOT reused (the next run builds
   * fresh). A pure-compute stretch that touches no seam cannot be interrupted;
   * the run finishes on its own and the post-settle check still rejects if the
   * signal aborted before it settled.
   */
  signal?: AbortSignal;
}

/** One validation run's raw outputs, straight off the engine callbacks. */
export interface EngineResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** The --json report string (__ecJson), when the run produced one. */
  json: string | null;
  /** Report files the CLI wrote under /work (__ecFile), e.g. out.json/xml/xmp. */
  files: Record<string, string>;
}

/** The engine module shape we depend on: a single `main(args, cb)` export. */
interface EngineModule {
  main(args: string[], callback: (err: unknown) => void): void;
}

/**
 * The engine factory: calling it executes the engine's UMD body in a FRESH
 * closure scope and returns a fresh module. It is emitted at build time by
 * teavm/fix-generated.ts as `export function createEngine()`, so the
 * fresh-scope seam is a real function -- no eval, no new Function. The host
 * loader supplies it (Node: a dynamic import of the engine module file;
 * browser: a dynamic import of the engine asset URL, or a factory handed to
 * configureEngine). Loaders import the factory ONCE and reuse it; the driver
 * CALLS it only when it has no reusable scope (first run, or the previous
 * run's scope was discarded after an engine error).
 */
export type EngineFactory = () => EngineModule;

// The reusable engine scope (see SCOPE REUSE above): the module from the last
// run whose main() completed normally, keyed to the factory that made it.
// null between a failed run and the next run's fresh createEngine() call.
let cachedModule: EngineModule | null = null;
let cachedModuleFactory: EngineFactory | null = null;

// Serialize runs on this thread: the engine reads shared globalThis feeds and we
// swap console.info/error around each run, so two concurrent runs would collide.
// A promise chain makes concurrent validate() calls queue instead (thread policy
// stays the caller's -- run on your own worker to parallelize).
let runQueue: Promise<unknown> = Promise.resolve();

const FEED_KEYS = [
  '__ecSize',
  '__ecRead',
  '__epubName',
  '__epubArgs',
  '__ecExtraPaths',
  '__ecExtraB64',
  '__ecInputArg',
  '__ecHostDir',
  '__ecInputIsDir',
  '__ecDirPaths',
  '__ecDirSizes',
  '__ecDirRead',
  // Set by the ENGINE side (ecshim.HostBook / ecshim.HostDir), not the host:
  // the transient stashes for an async read's promise between the sync probe
  // and the suspend. They are consumed-and-deleted in the same synchronous
  // stretch, so clearing them here is purely defensive.
  '__ecReadPending',
  '__ecDirReadPending',
  // Engine-side transient stashes for a SYNC read throw's message between the
  // -3 sentinel and the IOException rethrow (consumed-and-deleted in the same
  // synchronous stretch; clearing here is purely defensive).
  '__ecReadError',
  '__ecDirReadError',
  '__epubHttpGet',
  '__epubHttpRead',
  // Engine-side transient stashes for the http read seam (ecshim.HostHttp),
  // the exact siblings of __ecReadPending/__ecReadError above: the pending
  // promise between the sync probe and the suspend, and a sync throw's
  // message between the -3 sentinel and the IOException rethrow. Both are
  // consumed-and-deleted in the same synchronous stretch; clearing here is
  // purely defensive.
  '__epubHttpReadPending',
  '__epubHttpReadError',
  // The report-event tap. MUST be cleared on every exit path: a lingering tap
  // would stream the NEXT run's messages into an old caller's callbacks.
  '__ecTapMessage',
  '__ecTapInfo',
  '__ecPlain',
  '__ecRelArg',
  '__ecTZ',
  '__ecJson',
  '__ecExit',
  '__ecFile',
] as const;

function clearFeeds(g: Record<string, unknown>): void {
  for (const k of FEED_KEYS) delete g[k];
}

/**
 * The rejection value for an aborted run: the signal's reason (an AbortError
 * DOMException unless the aborter chose one; AbortSignal.timeout's is a
 * TimeoutError DOMException), with a defensive AbortError fallback for a
 * nonstandard signal whose reason is unset.
 */
function abortReasonOf(signal: AbortSignal): unknown {
  return signal.reason !== undefined
    ? (signal.reason as unknown)
    : new DOMException('The validation was aborted', 'AbortError');
}

// The NUL-joined __epubHttpGet error response an aborted URL download resumes
// the engine with (see http-bridge.ts for the "E" NUL kind NUL message
// contract): the engine unwinds it as an IOException, and the driver's aborted
// flag then forces the run's promise to reject with the abort reason.
const HTTP_ABORTED_RESPONSE = ['E', 'io', 'the validation was aborted'].join(
  String.fromCharCode(0),
);

/**
 * Drive ONE validation to completion, returning the raw engine outputs.
 * `getFactory` returns the (cached) engine factory; the run reuses the last
 * run's engine scope when it ended cleanly, else calls the factory for a
 * fresh one. `yieldMacrotask` yields exactly one macrotask after the run.
 */
export function driveEngine(
  run: EngineRun,
  getFactory: () => Promise<EngineFactory>,
  yieldMacrotask: () => Promise<void>,
): Promise<EngineResult> {
  const task = runQueue.then(() => runOnce(run, getFactory, yieldMacrotask));
  // Keep the chain alive regardless of this run's outcome.
  runQueue = task.then(
    () => undefined,
    () => undefined,
  );
  return task;
}

async function runOnce(
  run: EngineRun,
  getFactory: () => Promise<EngineFactory>,
  yieldMacrotask: () => Promise<void>,
): Promise<EngineResult> {
  // An already-aborted signal short-circuits BEFORE any engine work (no module
  // load, no scope, no feeds -- there is nothing to clean up and the cached
  // warm scope stays cached for the next run). This is not an engine run, so
  // the between-runs macrotask yield does not apply.
  const signal = run.signal;
  if (signal !== undefined && signal.aborted) {
    throw abortReasonOf(signal);
  }
  const createEngine = await getFactory();
  const g = globalThis as unknown as Record<string, unknown>;

  // Cooperative-cancellation bookkeeping (see EngineRun.signal). The seams
  // sample the signal through throwIfAborted (or hand the engine an IO-error
  // response, for the http bridge) and record the observation in `aborted`;
  // after main() settles -- by EITHER path, because epubcheck may swallow the
  // injected IO error into a FATAL result and complete normally -- the driver
  // re-checks and forces a deterministic rejection with the abort reason.
  let aborted = false;
  const throwIfAborted = (): void => {
    if (signal !== undefined && signal.aborted) {
      aborted = true;
      throw abortReasonOf(signal);
    }
  };

  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const files: Record<string, string> = {};
  let json: string | null = null;

  // Console originals are captured outside the try so the finally can restore
  // them even if feed-setting or factory() throws before the swap.
  const origInfo = console.info;
  const origError = console.error;

  // Every feed the engine reads must be dropped on EVERY exit path, success or
  // engine error. driveEngine swallows the rejection to keep the queue alive,
  // so a leaked feed (__ecSize/__ecRead, __ecExtraPaths, ...) would silently
  // feed the NEXT run and validate the wrong book. The single finally below is
  // the airtight seam: it clears feeds, settles the scope cache (keep on clean
  // completion, discard on error), and yields one macrotask regardless of how
  // this run ends.
  let mod: EngineModule | null = null;
  let completed = false;
  try {
    // The engine hands over an Int8Array VIEW of its own Java byte[] backing
    // store; copy the requested range straight into it through a same-buffer
    // Uint8Array (a byte-wise memcpy regardless of signedness) and report
    // the count written. Any thrown error propagates into the engine as an
    // IOException on the read.
    const fill = (target: Int8Array, offset: number, length: number, chunk: Uint8Array): number => {
      if (chunk.length < length) {
        throw new Error(
          `epubcheck-standalone: source read returned ${chunk.length} of ${length} bytes at offset ${offset}`,
        );
      }
      new Uint8Array(target.buffer, target.byteOffset, length).set(
        chunk.length === length ? chunk : chunk.subarray(0, length),
      );
      return length;
    };
    // A source may read synchronously (returned Uint8Array -- the fast path,
    // consumed inline exactly as before) or asynchronously (returned
    // promise -- the engine SUSPENDS at its TeaVM @Async seam until the
    // returned promise settles; a rejection resumes the engine as an
    // IOException on the read). The async branch scopes the console capture
    // OUT of the suspension window, exactly like __epubHttpGet below: while
    // the engine is suspended, unrelated host tasks run, and their
    // console.info/error must not be captured into this run's output.
    // Shared by the packaged-book feed (__ecRead) and the directory feed
    // (__ecDirRead) -- both suspend through the same TeaVM pattern.
    const consume = (
      target: Int8Array,
      offset: number,
      length: number,
      chunk: Uint8Array | Promise<Uint8Array>,
    ): number | Promise<number> => {
      // Duck-typed thenable check, matching the engine-side probes in
      // HostBook's / HostDir's feedReadTry (a cross-realm or userland
      // promise counts).
      if (typeof (chunk as Promise<Uint8Array>).then !== 'function') {
        return fill(target, offset, length, chunk as Uint8Array);
      }
      const capturedInfo = console.info;
      const capturedError = console.error;
      console.info = origInfo;
      console.error = origError;
      return Promise.resolve(chunk).then(
        (bytes) => {
          console.info = capturedInfo;
          console.error = capturedError;
          // Re-sample the signal at the resume boundary: an abort that fired
          // while this read was in flight is observed HERE (the rejection
          // resumes the engine as an IOException on the read), not one whole
          // read later.
          throwIfAborted();
          return fill(target, offset, length, bytes);
        },
        (err) => {
          console.info = capturedInfo;
          console.error = capturedError;
          throw err;
        },
      );
    };

    // Feed the run. Each read seam samples the abort signal FIRST: on abort it
    // throws the abort reason into the engine, which experiences an IOException
    // on the read and unwinds (throwIfAborted also records the observation for
    // the post-settle check below).
    if (run.size !== undefined && run.read !== undefined) {
      const read = run.read;
      g.__ecSize = run.size;
      g.__ecRead = (target: Int8Array, offset: number, length: number): number | Promise<number> => {
        throwIfAborted();
        return consume(target, offset, length, read(offset, length));
      };
    }
    // Expanded-directory feed: the listing (paths + sizes) crosses up front;
    // file CONTENTS are pulled on demand -- the engine asks by listing index,
    // so the path lookup stays host-side.
    if (run.dir !== undefined) {
      const dir = run.dir;
      g.__ecDirPaths = dir.paths;
      g.__ecDirSizes = dir.sizes;
      g.__ecDirRead = (
        target: Int8Array,
        index: number,
        offset: number,
        length: number,
      ): number | Promise<number> => {
        throwIfAborted();
        return consume(target, offset, length, dir.read(dir.paths[index] as string, offset, length));
      };
    }
    if (run.name !== undefined) g.__epubName = run.name;
    g.__epubArgs = run.args;
    if (run.inputArg !== undefined) g.__ecInputArg = run.inputArg;
    if (run.hostDir !== undefined) g.__ecHostDir = run.hostDir;
    if (run.inputIsDir) g.__ecInputIsDir = true;
    // URL-input mode: the async http bridge the engine's HostHttp suspends on
    // mid-run (see teavm/shims/src-teavm/ecshim/HostHttp.java). While the
    // engine is suspended, OTHER event-loop tasks run -- so the console swap
    // below is scoped OUT of the suspension window: the host console comes
    // back when the engine suspends into the GET and the capture resumes just
    // before the completion callback resumes the engine. Without this, any
    // unrelated console.info/error the host app logs during the download
    // would be captured into (and vanish from) this run's stdout/stderr.
    if (run.httpGet !== undefined && run.httpRead !== undefined) {
      const hostGet = run.httpGet;
      const hostRead = run.httpRead;
      g.__epubHttpGet = (url: string, done: (response: string) => void): void => {
        const capturedInfo = console.info;
        const capturedError = console.error;
        console.info = origInfo;
        console.error = origError;
        // Exactly-once completion for this GET: the engine resumes on the
        // FIRST of {the host's fetch settling, the signal aborting}; the
        // loser's call is dropped here. An aborted GET resumes the engine
        // with an IO-error response (it cannot be left suspended forever on
        // a download nobody wants), always from a later task/microtask per
        // the __epubHttpGet contract, and the abandoned fetch is released by
        // the bridge's close() when the run's owner tears it down.
        let settled = false;
        const finish = (response: string): void => {
          if (settled) return;
          settled = true;
          if (signal !== undefined) signal.removeEventListener('abort', onAbort);
          console.info = capturedInfo;
          console.error = capturedError;
          done(response);
        };
        const onAbort = (): void => {
          aborted = true;
          queueMicrotask(() => finish(HTTP_ABORTED_RESPONSE));
        };
        if (signal !== undefined) {
          if (signal.aborted) {
            onAbort();
            return;
          }
          signal.addEventListener('abort', onAbort, { once: true });
        }
        hostGet(url, finish);
      };
      g.__epubHttpRead = (
        target: Int8Array,
        handle: number,
        offset: number,
        length: number,
      ): number | Promise<number> => {
        // On abort, report a SHORT read (0 bytes): HostBook/HostHttp turn a
        // short http range deterministically into an IOException on the Java
        // side, unwinding the run without throwing through the bridge.
        if (signal !== undefined && signal.aborted) {
          aborted = true;
          return 0;
        }
        const r = hostRead(target, handle, offset, length);
        // Sync host count: the fast path, consumed inline (the engine never
        // touches its pause machinery). Duck-typed thenable check, matching
        // the engine-side probe in HostHttp.feedReadTry.
        if (typeof (r as Promise<number>).then !== 'function') {
          return r as number;
        }
        // Async host read: the engine SUSPENDS at HostHttp's @Async read seam
        // until this settles. Scope the console capture OUT of the suspension
        // window (exactly like `consume` and __epubHttpGet above), and
        // re-sample the abort signal at the resume boundary -- an abort that
        // fired while the read was in flight is observed HERE as the same
        // deterministic short read, not one whole block later. A rejection
        // resumes the engine as an IOException on the read.
        const capturedInfo = console.info;
        const capturedError = console.error;
        console.info = origInfo;
        console.error = origError;
        return Promise.resolve(r).then(
          (count) => {
            console.info = capturedInfo;
            console.error = capturedError;
            if (signal !== undefined && signal.aborted) {
              aborted = true;
              return 0;
            }
            return count;
          },
          (err) => {
            console.info = capturedInfo;
            console.error = capturedError;
            throw err;
          },
        );
      };
    }
    // Report-event tap: the engine calls these synchronously mid-run, once per
    // level-filtered message / info event. The host console is restored for
    // the duration of each callback -- user code inside (e.g. an onMessage
    // handler that logs) must hit the REAL console, not this run's capture --
    // and the capture is re-armed before the engine continues.
    if (run.tap !== undefined) {
      const tap = run.tap;
      const restored = <A extends unknown[]>(fn: (...a: A) => void) =>
        (...a: A): void => {
          const capturedInfo = console.info;
          const capturedError = console.error;
          console.info = origInfo;
          console.error = origError;
          try {
            fn(...a);
          } finally {
            console.info = capturedInfo;
            console.error = capturedError;
          }
        };
      g.__ecTapMessage = restored(tap.message);
      g.__ecTapInfo = restored(tap.info);
    }
    if (run.extraFiles && run.extraFiles.length > 0) {
      g.__ecExtraPaths = run.extraFiles.map((f) => f.path);
      g.__ecExtraB64 = run.extraFiles.map((f) => f.b64);
    }
    if (run.plain) g.__ecPlain = true;
    if (run.relArg) g.__ecRelArg = true;
    if (run.tz !== undefined) g.__ecTZ = run.tz;
    g.__ecJson = (s: string) => {
      json = s;
    };
    g.__ecFile = (name: string, content: string) => {
      files[name] = content;
    };

    // Capture epubcheck's console output (TeaVM routes stdout -> console.info and
    // stderr -> console.error). The finally restores the originals no matter what.
    console.info = (...a: unknown[]) => stdoutLines.push(a.join(' '));
    console.error = (...a: unknown[]) => stderrLines.push(a.join(' '));

    // Reuse the previous run's scope when it ended cleanly and came from this
    // same factory (its main() resets all cross-run state on entry); else
    // build a fresh one.
    if (cachedModule !== null && cachedModuleFactory === createEngine) {
      mod = cachedModule;
      cachedModule = null;
      cachedModuleFactory = null;
    } else {
      // Fresh build. If a prior factory's scope is still cached (a factory swap
      // via configureEngine), release it now: this run's else branch will not
      // reuse it, and if this run errors the finally leaves cachedModule
      // untouched, so a stale ~21 MB scope would otherwise be retained until
      // some later run under the new factory completes cleanly.
      cachedModule = null;
      cachedModuleFactory = null;
      mod = createEngine();
    }
    try {
      await new Promise<void>((resolve, reject) => {
        (mod as EngineModule).main([], (err: unknown) =>
          err ? reject(err instanceof Error ? err : new Error(String(err))) : resolve(),
        );
      });
    } catch (err) {
      // An aborted run rejects with the ABORT REASON, deterministically, even
      // when the injected IO error surfaced as an engine error instead.
      if (aborted || (signal !== undefined && signal.aborted)) throw abortReasonOf(signal as AbortSignal);
      throw err;
    }
    // The post-settle abort check (the deterministic half of cancellation):
    // epubcheck may have swallowed the injected IO error into a FATAL result
    // and completed main() normally -- or the signal may have aborted during a
    // stretch that touched no seam at all. Either way, a signal that aborted
    // before the run settled means the caller gets the abort reason, never the
    // engine's result. `completed` stays false, so the finally DISCARDS this
    // scope: an aborted run is not presumed clean, and the next validation
    // cold-starts from a fresh createEngine() scope.
    if (aborted || (signal !== undefined && signal.aborted)) {
      throw abortReasonOf(signal as AbortSignal);
    }
    completed = true;

    const exit = g.__ecExit;
    const exitCode = typeof exit === 'number' ? exit : null;

    // epubcheck prints a trailing blank line; join preserves the exact bytes the
    // console reader and the byte-parity suites compare (each console.info/error
    // call is one line).
    const stdout = stdoutLines.length ? stdoutLines.join('\n') + '\n' : '';
    const stderr = stderrLines.length ? stderrLines.join('\n') + '\n' : '';
    return { exitCode, stdout, stderr, json, files };
  } finally {
    console.info = origInfo;
    console.error = origError;
    // Dispose/settle: a cleanly-completed scope is kept for the next run (the
    // wrapper's per-run reset makes it as good as fresh, minus the rebuild
    // cost); a failed run's scope is dropped so its runtime can be collected
    // and the next run starts fresh. Feeds are cleared and one macrotask is
    // yielded on every path, exactly as before.
    if (completed && mod !== null) {
      cachedModule = mod;
      cachedModuleFactory = createEngine;
    }
    mod = null;
    clearFeeds(g);
    await yieldMacrotask();
  }
}
