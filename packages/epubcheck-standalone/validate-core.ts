// epubcheck-standalone -- the shared isomorphic validate() (internal).
//
// The public `validate(source, options)` is the SAME in Node and the browser;
// the only difference is the platform engine driver, which each entry point
// injects. This module holds the one implementation both wrap, so the two
// environments cannot drift.

import { runToResult } from './run-core.js';
import type { CoreRunOptions, RunEngine } from './run-core.js';
import { memory, isDirectorySource } from './plugins.js';
import type { RangeSource, DirectorySource, UrlSource } from './plugins.js';
import type { EpubCheckResult } from './result-types.js';
import type { ReportMessage, ReportFeature } from './formatters/index.js';

/**
 * Anything `validate` accepts as the thing to validate: a range source, a
 * directory source, raw bytes, or a URL input source (`await url(...)` -- the
 * jar-parity remote-input mode, where the URL itself is epubcheck's input).
 */
export type ValidateSource = RangeSource | DirectorySource | Uint8Array | UrlSource;

/** Options for `validate()`. Isomorphic: identical in Node and the browser. */
export interface ValidateOptions {
  /**
   * Reported EPUB name (used in message locations and report file names).
   * Defaults to the source's own `name` when it carries one (a picked File, an
   * `fs`/`fsDir` path), else "book.epub" (or "book" for a directory). A URL
   * input ignores this: the URL itself is the reported input, like the jar.
   */
  name?: string;
  /**
   * Extra epubcheck CLI arguments, placed before the input path exactly as on
   * the stock CLI (e.g. `['--profile', 'edupub']`, `['--locale', 'fr']`,
   * `['--mode', 'xhtml', '-v', '3.0']`). A directory source's mode is set by
   * the `dirMode` option (default 'direct', or 'exp' to package first), not via
   * args; passing a conflicting `--mode`/`-m` then throws.
   */
  args?: string[];
  /**
   * Custom message overrides -- epubcheck's `-c/--customMessages`. The override
   * file's bytes (`Uint8Array`) or its text content (`string`). It is mounted in
   * the engine's filesystem and `-c` is pointed at it, so promoting, demoting,
   * suppressing, and rewording messages behaves exactly like the jar's `-c`.
   */
  customMessages?: Uint8Array | string;
  /**
   * The file name the override file is reported under (the name `-c` prints in
   * CHK-00x messages). Defaults to "messages.txt".
   */
  customMessagesName?: string;
  /**
   * Also produce JSON/XML/XMP report output for this run. The result gains a
   * `reports` field with the requested formats, byte-identical to the stock
   * CLI's `--json`/`--out`/`--xmp` writers -- rendered from the run's live
   * report-event stream, so one single validation produces any/all formats.
   */
  reports?: Array<'json' | 'xml' | 'xmp'>;
  /** IANA time zone id for report timestamps (defaults to the host zone). */
  tz?: string;
  /**
   * How a DIRECTORY source is validated (ignored for every other source).
   * 'direct' (the default) mirrors handing the jar a directory path with NO
   * --mode (the jar's auto-detected expanded book -- a directory named
   * `*.epub`, or any directory under a `--profile`): epubcheck validates the
   * tree in place and message locations carry the directory name itself. 'exp'
   * mirrors the jar's explicit `--mode exp`: epubcheck packages the tree into a
   * temporary `<name>.epub` beside it and validates that package, so message
   * locations carry the packaged name. The two differ only in how epubcheck
   * labels and traverses the input; both stream the directory through the same
   * feed.
   */
  dirMode?: 'exp' | 'direct';
  /**
   * Per-message callback, fired LIVE during validation: the engine streams
   * each message out as the checker produces it, and this callback runs at
   * that moment (synchronously on the validating thread), in emission order.
   * Each message is the SAME `ReportMessage` object that lands in
   * `result.messages` (same field set, same order). A throw from the callback
   * does not disturb the run; the first such error rejects the validate()
   * promise after the run completes.
   */
  onMessage?: (message: ReportMessage) => void;
  /**
   * Per-feature callback, fired LIVE during validation, symmetric to
   * `onMessage`: the engine streams each feature/info event (`Report.info`) out
   * as it is produced, and this callback runs at that moment (synchronously, in
   * emission order) with the SAME `ReportFeature` object that lands in
   * `result.features`. It lets a live console consumer emit the chrome that is
   * derived from a feature -- notably the "Validating using EPUB version X
   * rules." line, which epubcheck prints from the FORMAT_VERSION feature the
   * instant it arrives (before any content message). A throw from the callback
   * does not disturb the run; the first such error rejects the validate()
   * promise after the run completes.
   */
  onFeature?: (feature: ReportFeature) => void;
  /**
   * Cooperative cancellation. When the signal aborts, the run stops the next
   * time the engine asks the host for bytes (a book or directory range read,
   * or a URL download), and the returned promise rejects with the signal's
   * reason (an `AbortError` `DOMException` unless the aborter chose another).
   * A signal that is already aborted rejects before any engine work starts.
   * Best effort by nature: the engine can only observe the signal at those
   * byte boundaries, so a compute-only stretch between reads runs on until
   * the next one -- and an abort never reclaims the memory or CPU the run is
   * already using. The one guaranteed hard stop is terminating a worker you
   * own that runs validate() (the library spawns no workers itself). Once the
   * run settles either way, the signal is ignored; aborting after a
   * successful validation does nothing.
   */
  signal?: AbortSignal;
  /**
   * Cooperative time limit in milliseconds: sugar for
   * `signal: AbortSignal.timeout(timeoutMs)`, combined with any `signal` you
   * also pass (whichever aborts first wins). On timeout the promise rejects
   * with a `TimeoutError` `DOMException`. Same best-effort semantics as
   * `signal` -- and because a same-thread timer cannot fire while the engine
   * holds the thread, the timeout is only observed while the engine is
   * suspended waiting on the host (async source reads, URL downloads); a run
   * that computes synchronously start to finish outruns it. For a guaranteed
   * time limit, run validate() in a worker you own and terminate that worker
   * on your own timer.
   */
  timeoutMs?: number;
}

/** Resolve customMessages (bytes|string) to the run driver's { bytes, name }. */
function resolveCustomMessages(
  customMessages: Uint8Array | string,
  name: string,
): { bytes: Uint8Array; name: string } {
  if (typeof customMessages === 'string') {
    return { bytes: new TextEncoder().encode(customMessages), name };
  }
  if (customMessages instanceof Uint8Array) {
    return { bytes: customMessages, name };
  }
  throw new Error('validate: customMessages must be a Uint8Array or a string');
}

/**
 * Resolve the run's effective abort signal from the `signal` and `timeoutMs`
 * options: the caller's signal alone, a fresh `AbortSignal.timeout` alone, or
 * the two combined so that whichever aborts first wins (native
 * `AbortSignal.any` where it exists, else a manual combiner that removes its
 * listeners once either side fires -- the timeout side always eventually
 * fires, so no listener outlives a long-lived caller signal).
 */
function resolveSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): AbortSignal | undefined {
  if (timeoutMs === undefined) return signal;
  const timeout = AbortSignal.timeout(timeoutMs);
  if (signal === undefined) return timeout;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([signal, timeout]);
  if (signal.aborted) return signal;
  const controller = new AbortController();
  const onAbort = (event: Event): void => {
    signal.removeEventListener('abort', onAbort);
    timeout.removeEventListener('abort', onAbort);
    controller.abort((event.target as AbortSignal).reason);
  };
  signal.addEventListener('abort', onAbort);
  timeout.addEventListener('abort', onAbort);
  return controller.signal;
}

/**
 * The shared validate(): normalize the source, resolve options, and delegate to
 * the one run driver with the platform `runEngine`. Takes ownership of the
 * source's disposal (success or throw).
 */
export function validateWith(
  runEngine: RunEngine,
  source: ValidateSource,
  options: ValidateOptions = {},
): Promise<EpubCheckResult> {
  const rangeOrDir: RangeSource | DirectorySource | UrlSource =
    source instanceof Uint8Array ? memory(source) : source;

  const core: CoreRunOptions = { source: rangeOrDir };
  if (options.name !== undefined) core.name = options.name;
  if (options.args !== undefined && options.args.length > 0) core.args = options.args;
  if (options.customMessages !== undefined) {
    core.customMessages = resolveCustomMessages(
      options.customMessages,
      options.customMessagesName ?? 'messages.txt',
    );
  }
  if (options.reports !== undefined && options.reports.length > 0) core.reports = options.reports;
  if (options.tz !== undefined) core.tz = options.tz;
  if (options.dirMode !== undefined) core.dirMode = options.dirMode;
  if (options.onMessage !== undefined) core.onMessage = options.onMessage;
  if (options.onFeature !== undefined) core.onFeature = options.onFeature;
  const signal = resolveSignal(options.signal, options.timeoutMs);
  if (signal !== undefined) core.signal = signal;

  return runToResult(runEngine, core);
}

export { isDirectorySource };
