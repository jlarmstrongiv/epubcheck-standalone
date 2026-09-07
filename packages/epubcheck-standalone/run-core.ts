// epubcheck-standalone -- shared run driver (internal).
//
// Both platform entry points (index.ts for Node, validate-browser.ts for the
// browser) build a run through THIS one function, injecting only their platform
// `runEngine` (which knows how to load the engine source and yield a macrotask).
// Everything else -- wiring the source's range read into the engine feed
// (packaged-book and expanded-directory alike), composing the CLI feed,
// materializing the custom-messages file, capturing output, consuming the
// engine's live report-event tap, rendering the requested report documents,
// and assembling the shared EpubCheckResult -- is platform-neutral and lives
// here, so the Node and browser results cannot drift.
//
// ONE ENGINE RUN PER VALIDATION. The engine's message tap (ecshim.ReportTap +
// the shadowed DefaultReportImpl) streams every level-filtered checker message
// and every feature/info event out DURING the run, so:
//  - `onMessage` fires live, mid-validation, as each message is emitted;
//  - `result.messages` / `result.features` carry the full checker-message and
//    feature-event streams of every run (the complete tap data);
//  - the JSON/XML/XMP report documents are rendered host-side by the
//    formatters (./formatters/index.js) from that live stream -- byte-identical
//    to epubcheck's own writers, with no per-format re-validation.

import { parseConsoleReport } from './parse.js';
import type {
  EpubCheckResult,
  EpubCheckReports,
} from './result-types.js';
import { isDirectorySource, isUrlSource, toBase64 } from './plugins.js';
import type { RangeSource, DirectorySource, UrlSource, HttpBridge } from './plugins.js';
import type { EngineRun, EngineResult } from './engine-run.js';
import {
  formatJsonReport,
  formatXmlReport,
  formatXmpReport,
} from './formatters/index.js';
import type { ReportData, ReportFeature, ReportMessage, ReportSeverity } from './formatters/index.js';

/** The platform engine driver run-core delegates a single run to. */
export type RunEngine = (run: EngineRun) => Promise<EngineResult>;

/** Custom-messages override, already resolved to bytes + a reported file name. */
export interface ResolvedCustomMessages {
  bytes: Uint8Array;
  name: string;
}

/** A run's inputs, normalized by whichever platform entry built it. */
export interface CoreRunOptions {
  /**
   * A range, directory, or URL source. A RANGE source is streamed: the engine
   * pulls byte ranges from it mid-run, so it stays open for the whole run and
   * is DISPOSED when the run ends (success or throw). A DIRECTORY source is
   * streamed the same way (expanded-directory mode): only its listing crosses
   * up front, the engine pulls each file's bytes on demand mid-run, and the
   * source is disposed when the run ends. A URL source is not a byte feed at
   * all: the URL itself becomes epubcheck's input path and the engine
   * downloads it mid-run through the async http bridge this driver installs
   * for the run (jar-parity URL mode; the engine suspends while the host
   * fetches).
   */
  source: RangeSource | DirectorySource | UrlSource;
  /** Reported epub name (defaults from the source's own name, else a fallback). */
  name?: string;
  /** Extra epubcheck CLI arguments, placed before the input path. */
  args?: string[];
  /** Custom message overrides (-c), already resolved to bytes + name. */
  customMessages?: ResolvedCustomMessages;
  /** Report formats to render from the run's live report-event stream. */
  reports?: Array<'json' | 'xml' | 'xmp'>;
  /** IANA time zone id for report timestamps (defaults to the host zone). */
  tz?: string;
  /**
   * Directory-source validation flavor (see ValidateOptions.dirMode): 'direct'
   * (default) passes the directory name as a bare input path with no mode, the
   * jar's auto-detected expanded book (locations carry the directory name
   * itself); 'exp' injects `--mode exp` so epubcheck packages the tree first
   * (locations carry `<name>.epub`). Ignored for non-directory sources.
   */
  dirMode?: 'exp' | 'direct';
  /**
   * Per-message callback, fired LIVE during validation: the engine's message
   * tap emits each level-filtered message as the checker produces it, and this
   * callback runs synchronously at that moment with the SAME `ReportMessage`
   * object that lands in `result.messages` (same field set, same order), so the
   * live stream is byte-for-byte the eventual `result.messages`. A throw from
   * the callback does not disturb the run; the first such error rejects the
   * validate() promise after the run completes.
   */
  onMessage?: (message: ReportMessage) => void;
  /**
   * Per-feature callback, fired LIVE during validation, symmetric to
   * `onMessage`: the info tap emits each feature/info event as it is produced,
   * with the SAME `ReportFeature` object that lands in `result.features`. A
   * throw from the callback does not disturb the run; the first such error
   * rejects the validate() promise after the run completes.
   */
  onFeature?: (feature: ReportFeature) => void;
  /**
   * Cooperative cancellation signal, already combined with any timeout signal
   * by the caller (validate-core). Handed to the engine driver, which samples
   * it at the mid-run host seams and rejects the run with the signal's reason
   * once it aborts -- see EngineRun.signal for the exact semantics. The source
   * and the http bridge are still disposed on the aborted path (the finally
   * below owns both).
   */
  signal?: AbortSignal;
}

// Polyfill-safe well-known dispose key -- the same key the plugins register under.
const DISPOSE: typeof Symbol.dispose =
  Symbol.dispose ?? (Symbol.for('Symbol.dispose') as typeof Symbol.dispose);

function disposeSource(source: RangeSource | DirectorySource | UrlSource): void {
  const dispose = source[DISPOSE];
  if (typeof dispose === 'function') dispose.call(source);
}

/** Default reported name for a source without one. */
function defaultName(source: RangeSource | DirectorySource): string {
  if (typeof source.name === 'string' && source.name.length > 0) return source.name;
  return isDirectorySource(source) ? 'book' : 'book.epub';
}

const REPORT_SEVERITIES: readonly ReportSeverity[] =
  ['SUPPRESSED', 'USAGE', 'INFO', 'WARNING', 'ERROR', 'FATAL'];

/**
 * Drive one validation to completion and return the structured result. Takes
 * ownership of the source's disposal (success or throw). `runEngine` is the
 * platform engine driver.
 */
export async function runToResult(
  runEngine: RunEngine,
  opts: CoreRunOptions,
): Promise<EpubCheckResult> {
  const { source } = opts;
  // URL-input mode: the async http bridge lives exactly as long as the run
  // (the finally below closes it -- Node releases the disk spool; the browser
  // drops the fetched bodies).
  let bridge: HttpBridge | null = null;
  try {
    const isUrl = isUrlSource(source);
    const isDir = !isUrl && isDirectorySource(source);
    // In URL mode the reported "name" IS the URL (epubcheck prints message
    // locations under it, like the jar); a name option would not reach the
    // engine anyway (there is no __epubName feed in URL mode).
    const name = isUrl
      ? source.url
      : opts.name && opts.name.length > 0
        ? opts.name
        : defaultName(source);
    const userArgs = opts.args ? [...opts.args] : [];
    const extraFiles: Array<{ path: string; b64: string }> = [];

    // Custom messages (-c): mount the override file in the VFS and point -c at it
    // by its reported name (cwd is /work, so a bare name resolves).
    if (opts.customMessages) {
      const cm = opts.customMessages;
      extraFiles.push({ path: cm.name, b64: toBase64(cm.bytes) });
      userArgs.push('-c', cm.name);
    }

    const wantReports = opts.reports && opts.reports.length > 0 ? opts.reports : null;

    // The run is ALWAYS a plain console run (plain=true: the wrapper injects no
    // report flag), which yields the jar-identical per-message console text the
    // parity suites compare and the console reader parses. Report documents are
    // rendered host-side below from the tap's live event stream.
    const run: EngineRun = {
      args: userArgs,
      extraFiles,
      plain: true,
      relArg: true,
      tz: opts.tz ?? hostTimeZone(),
    };
    if (opts.signal !== undefined) run.signal = opts.signal;

    // The live report-event tap: collect the complete stream that becomes
    // result.messages / result.features (and feeds the report formatters), and
    // fire onMessage as each message arrives -- with the SAME ReportMessage
    // object that lands in result.messages, so the live stream IS the eventual
    // result.messages. Callback errors are DEFERRED (a throw inside the engine's
    // synchronous call chain would abort the run as an engine error and discard
    // the warm scope); the first one rejects the returned promise after the run.
    const tapMessages: ReportMessage[] = [];
    const tapFeatures: ReportFeature[] = [];
    const onMessage = opts.onMessage;
    const onFeature = opts.onFeature;
    let callbackError: unknown = null;
    let callbackFailed = false;
    // ONE counter shared across both tap callbacks: the engine's shadowed
    // DefaultReportImpl fires message() and info() synchronously from the same
    // single-threaded run (see teavm .../DefaultReportImpl.java), so a single
    // 0-based index bumped on each call records the TRUE global emission order
    // of every message AND feature. It lets a consumer -- notably the console
    // formatter -- interleave result.messages and result.features back into one
    // program-ordered stream.
    let sequence = 0;
    run.tap = {
      message: (id, severity, message, suggestion, path, line, column, context) => {
        const sev = (severity ?? '') as ReportSeverity;
        const reportMessage: ReportMessage = {
          id,
          severity: REPORT_SEVERITIES.includes(sev) ? sev : 'INFO',
          message: message ?? '',
          suggestion: suggestion ?? '',
          path: path ?? '',
          line,
          column,
          context,
          sequence: sequence++,
        };
        tapMessages.push(reportMessage);
        if (onMessage) {
          try {
            onMessage(reportMessage);
          } catch (e) {
            if (!callbackFailed) {
              callbackFailed = true;
              callbackError = e;
            }
          }
        }
      },
      info: (resource, feature, value) => {
        const reportFeature: ReportFeature = {
          resource,
          feature: feature ?? '',
          value,
          sequence: sequence++,
        };
        tapFeatures.push(reportFeature);
        if (onFeature) {
          try {
            onFeature(reportFeature);
          } catch (e) {
            if (!callbackFailed) {
              callbackFailed = true;
              callbackError = e;
            }
          }
        }
      },
    };

    if (isUrlSource(source)) {
      // URL input: the URL string is the CLI input path (the stock URL branch
      // runs -- locations carry the URL, failures keep the jar's headlines)
      // and the download happens inside the engine, which SUSPENDS on the
      // async http bridge installed here. No name and no byte feed.
      bridge = await source.openBridge();
      run.inputArg = source.url;
      run.httpGet = bridge.get;
      run.httpRead = bridge.read;
    } else if (isDirectorySource(source)) {
      // Expanded (unzipped) EPUB directory: validated IN PLACE by default
      // ('direct'), or packaged first when dirMode is 'exp'. Only the
      // LISTING (relative paths + sizes) crosses up front: the engine mounts
      // the tree's shape under /work/<name> and pulls each file's bytes on
      // demand through the directory feed (a synchronous fill is consumed
      // inline; a promise makes the engine SUSPEND until it resolves), so the
      // tree's contents are never materialized whole on either side. The
      // source stays open for the whole run; the finally below disposes it.
      if (userArgs.includes('--mode') || userArgs.includes('-m')) {
        throw new Error(
          "validate: a directory source's mode is controlled by the dirMode option " +
            '(default direct, or exp to package first); do not also pass --mode/-m in args',
        );
      }
      const root = name;
      const entries = source.list();
      run.name = name;
      run.inputArg = root;
      // Real host parent directory (Node fs sources): relocates the engine's
      // mount + user.dir off "/work" so no-container paths print the host path
      // (see EngineRun.hostDir). Absent for browser/injected sources -> "/work".
      if (source.hostDir !== undefined) run.hostDir = source.hostDir;
      // 'direct' (default) hands epubcheck the bare directory path with NO mode
      // flag -- the jar's auto-detect path (EpubCheck validates the tree in
      // place); 'exp' is the jar's explicit `--mode exp` (epubcheck packages
      // the tree into a temp `<name>.epub` and validates that).
      run.args = opts.dirMode === 'exp' ? ['--mode', 'exp', ...userArgs] : userArgs;
      run.dir = {
        paths: entries.map((entry) => entry.path),
        sizes: entries.map((entry) => entry.size),
        read: (path, offset, length) => source.read(path, offset, length),
      };
    } else {
      // Packaged .epub: hand the range source's `read` straight to the engine
      // as the random-access feed (a synchronous fill is consumed inline; a
      // promise makes the engine SUSPEND until it resolves -- how File/Blob
      // sources validate on the browser main thread). The engine pulls byte
      // ranges MID-RUN (8 MiB max per pull, through its own 64 MiB block cache), so
      // the book is never materialized whole on either side -- this is what
      // lets multi-GB ZIP64 books validate at flat memory. The source stays
      // open for the whole run; the finally below disposes it afterwards.
      run.name = name;
      // Real host parent directory (Node fs sources): see the directory branch
      // and EngineRun.hostDir. Absent for browser/injected sources -> "/work".
      if (source.hostDir !== undefined) run.hostDir = source.hostDir;
      if (source.isDirectory) {
        // A DIRECTORY handed to the single-file path (e.g. the CLI's
        // `--mode xhtml <dir>`): no byte feed -- the engine mounts an empty VFS
        // directory so epubcheck's read fails with FATAL(PKG-008) and the
        // jar's trailing-slash directory location (see EngineRun.inputIsDir).
        run.inputIsDir = true;
      } else {
        run.size = source.size;
        run.read = (offset, length) => source.read(offset, length);
      }
    }

    // Run-varying report fields, measured around the single engine run like
    // epubcheck's own writers measure theirs: checkDate is the validation
    // start, elapsedTime the wall duration, generationDate the render time.
    const startDate = new Date();
    const engineResult = await runEngine(run);
    const elapsedTime = Date.now() - startDate.getTime();

    let reports: EpubCheckReports | undefined;
    if (wantReports) {
      // TOOL_* info events flow on every run; a run that produced NONE means
      // the loaded engine build predates the tap -- fail loudly rather than
      // render empty report documents.
      if (tapFeatures.length === 0) {
        throw new Error(
          'epubcheck-standalone: the loaded engine emitted no report events; the engine ' +
            'build predates the message tap. Run `npm run build` in ' +
            'packages/epubcheck-standalone to rebuild dist/epubcheck-engine.js.',
        );
      }
      // The filename every report path field derives from, exactly as native
      // epubcheck derives it: the bare book name for a packaged .epub (the run
      // passes the bare relative name, cwd /work), the synthetic
      // "<dir-name>.epub" container name for expanded-directory 'exp' mode
      // (epubcheck zips the tree to that sibling temp name and validates it),
      // the directory name AS-IS for 'direct' mode -- the default for a
      // directory source (no packaging -- verified against the jar's --json
      // fields on a directory input), and the URL itself in URL mode.
      const filename = isDir && opts.dirMode === 'exp' ? `${name}.epub` : name;
      const reportData: ReportData = { messages: tapMessages, features: tapFeatures };
      const generationDate = new Date();
      reports = {};
      for (const fmt of wantReports) {
        if (fmt === 'json') {
          reports.json = formatJsonReport(reportData, {
            filename,
            checkDate: startDate,
            elapsedTime,
          });
        } else if (fmt === 'xml') {
          reports.xml = formatXmlReport(reportData, { filename, generationDate });
        } else {
          reports.xmp = formatXmpReport(reportData, { filename, generationDate });
        }
      }
    }

    const result = assembleResult(engineResult, tapMessages, tapFeatures, reports);
    if (callbackFailed) throw callbackError;
    return result;
  } finally {
    // close() may be async (Node closes and deletes the disk spools through
    // fs/promises); awaiting it keeps teardown ordered before disposal and
    // never blocks the event loop.
    if (bridge) await bridge.close();
    disposeSource(source);
  }
}

function hostTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function assembleResult(
  engine: EngineResult,
  tapMessages: ReportMessage[],
  tapFeatures: ReportFeature[],
  reports: EpubCheckReports | undefined,
): EpubCheckResult {
  const exitCode = engine.exitCode;
  const stdout = engine.stdout;
  const stderr = engine.stderr;

  // result.messages is the COMPLETE tap-sourced list (raw text, suggestion,
  // context, flat path/line/column, id) -- the same data every report writer
  // sees. The count SUMMARY still comes from the run's console "Messages:" line
  // (parseConsoleReport): the tap fires this.message() from the SAME
  // reporting-level-filtered code path that prints each console line and bumps
  // epubcheck's own counters, so the tap messages and the summary counts are
  // consistent by construction (verified across the full corpus by
  // test/tap-coverage.ts: per-severity tap counts == summary counts, and the
  // live onMessage stream == result.messages).
  const { summary } = parseConsoleReport(stdout + '\n' + stderr);

  const result: EpubCheckResult = {
    valid: exitCode === 0,
    exitCode,
    messages: tapMessages,
    features: tapFeatures,
    summary,
    stdout,
    stderr,
  };
  if (reports) result.reports = reports;
  return result;
}
