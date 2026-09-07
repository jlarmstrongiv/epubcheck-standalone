#!/usr/bin/env node
// epubcheck-standalone-cli -- a zero-Java command-line EPUB validator that mirrors the
// official epubcheck 5.3.0 CLI (com.adobe.epubcheck.tool.EpubChecker /
// Checker) byte-for-byte, on top of the epubcheck-standalone engine.
//
// The behavior here is a faithful re-implementation of epubcheck 5.3.0's
// EpubChecker.processArguments / run / validateFile / processFile and
// DefaultReportImpl (see the source files named in the package README). Flags
// that change what the engine validates or which locale it speaks (--mode,
// --profile, --locale, -u/--usage) are passed straight through to the engine via
// the `args` option on the library's single `validate(source, options)` call; the
// console text is still reconstructed here from the engine's report so the
// reporting-level filtering, report files, and exit codes stay byte-identical to
// the jar. Every input runs through that same `validate()` call, differing only in
// the source handed to it: a packaged `.epub` (`fs`), an expanded directory
// (`fsDir`, for `--mode exp` and directory inputs), or an http(s) URL (`url`).
// Custom message overrides (`-c/--customMessages`) ride through the
// `customMessages` option (or, for a missing overrides file, straight through
// `args` so the engine emits CHK-001 like the jar). The one capability the engine
// still cannot provide is an unshipped locale, which the CLI refuses loudly rather
// than silently diverging -- see `unsupportedReason` and the README "Unsupported
// flags" table.

import { writeFile, readFile, realpath, stat, unlink } from "node:fs/promises";
import { resolve as pathResolve, dirname, basename, join as pathJoin } from "node:path";
import { fileURLToPath } from "node:url";
import { validate } from "epubcheck-standalone";
import { fs as fsSource, fsDir, url as urlSource } from "epubcheck-standalone/plugins";
import type { EpubCheckResult } from "epubcheck-standalone";
import type { ReportMessage } from "epubcheck-standalone/formatters";
// The console line/summary formatting lives in the LIBRARY (one implementation,
// shared with the library's batch `formatConsoleReport`); the CLI drives these
// same primitives from the engine's live per-message/-feature stream so its
// stdout/stderr stay byte-identical to the jar while still printing during the
// run. CLI-specific concerns (flag/--quiet handling, reporting-level selection,
// locale wiring, stream routing) stay here.
import {
  type ConsoleCounts,
  renderConsoleMessageLine,
  countConsoleSeverities,
  displayedConsoleCounts,
  renderConsoleSummaryLine,
  renderValidatingLine,
  severityReportingLevel,
  formatTemplate,
} from "epubcheck-standalone/formatters";
import type { RangeSource } from "epubcheck-standalone/plugins";
import {
  M,
  type Messages,
  messagesFor,
  resolveLocale,
  EPUBCHECK_VERSION,
  ReportingLevel,
} from "./messages.js";
import { HELP_OUTPUT } from "./help-text.js";
import { createArchive } from "./archive.js";
import { LIST_CHECKS_TSV } from "./list-checks-data.js";
import { LIST_CHECKS_TSV_BY_LOCALE } from "./list-checks-locale-data.js";

/** Exit code used when a flag is valid epubcheck syntax but unsupportable here. */
const EXIT_UNSUPPORTED = 2;

const KNOWN_PROFILES = new Set(["DEFAULT", "IDX", "DICT", "EDUPUB", "PREVIEW"]);

/** Options this CLI hands to the library's validate(). */
interface EngineOpts {
  args?: string[];
  customMessages?: string;
  customMessagesName?: string;
  reports?: Array<"json" | "xml" | "xmp">;
  dirMode?: "exp" | "direct";
  /** Live per-message stream (see run()'s streaming console driver). */
  onMessage?: (message: ReportMessage) => void;
  /** Live per-feature stream (drives the "Validating using..." line in order). */
  onFeature?: (feature: import("epubcheck-standalone/formatters").ReportFeature) => void;
}

// Polyfill-safe well-known dispose key (the same key the library's plugins use).
const DISPOSE: typeof Symbol.dispose =
  Symbol.dispose ?? (Symbol.for("Symbol.dispose") as typeof Symbol.dispose);

/** Async existsSync: stat the path and report success, false on any error --
 *  behavior-identical to fs.existsSync (which is itself stat-based) but without
 *  blocking the event loop (async law). */
async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Reproduce Java's FileNotFoundException.getMessage() ("<path> (<strerror>)")
 *  for a Node write error, so the --listChecks write-failure stderr matches the
 *  jar byte-for-byte. The path is the ORIGINAL argument (as the jar's `new
 *  File(arg)` carries it), and the OS strerror is keyed off the errno code. */
function javaIoErrorMessage(err: unknown, originalPath: string): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  const strerror: Record<string, string> = {
    ENOENT: "No such file or directory",
    EACCES: "Permission denied",
    EISDIR: "Is a directory",
    ENOTDIR: "Not a directory",
    EEXIST: "File exists",
    EROFS: "Read-only file system",
  };
  const text = code && strerror[code] ? strerror[code] : String((err as Error)?.message ?? err);
  return `${originalPath} (${text})`;
}

interface State {
  path: string | null;
  mode: string | null;
  version: string; // "2.0" | "3.0"
  profile: string | null; // uppercased enum name, or "__INVALID__"
  expanded: boolean;
  jsonOutput: boolean;
  xmlOutput: boolean;
  xmpOutput: boolean;
  /** undefined = not requested; null = console ("-"); string = explicit path. */
  fileOut: string | null | undefined;
  listChecks: boolean;
  listChecksOut: string | null;
  /** -c/--customMessages target (path, or env-var override); null = no overrides. */
  customMessagesPath: string | null;
  displayHelp: boolean;
  displayVersion: boolean;
  failOnWarnings: boolean;
  /** -s/--save: epubcheck's `keep` -- keep the .epub packaged by `--mode exp`. */
  save: boolean;
  reportingLevel: number;
  quiet: boolean;
  localeTag: string | null;
}

class ParseError extends Error {}

export async function run(args: string[]): Promise<number> {
  const st: State = {
    path: null,
    mode: null,
    version: "3.0",
    profile: null,
    expanded: false,
    jsonOutput: false,
    xmlOutput: false,
    xmpOutput: false,
    fileOut: undefined,
    listChecks: false,
    listChecksOut: null,
    customMessagesPath: null,
    displayHelp: false,
    displayVersion: false,
    failOnWarnings: false,
    save: false,
    reportingLevel: ReportingLevel.Info,
    quiet: false,
    localeTag: null,
  };

  // Emit helpers. Everything that epubcheck routes through `outWriter` (stdout)
  // is suppressed under --quiet; System.err and report bodies are not.
  const outln = (s: string): void => {
    if (!st.quiet) process.stdout.write(s + "\n");
  };
  const errln = (s: string): void => {
    process.stderr.write(s + "\n");
  };
  // USAGE messages route to stdout and, unlike everything else on stdout, ignore
  // --quiet: DefaultReportImpl.message() pushes the out writer to the report's own
  // (never-quiet) setting just for USAGE before printing.
  const usageln = (s: string): void => {
    process.stdout.write(s + "\n");
  };
  const displayHelp = (): void => outln(HELP_OUTPUT.slice(0, -1)); // HELP_OUTPUT ends with the println newline
  const displayVersion = (): void =>
    outln(formatTemplate(M.epubcheck_version_text, EPUBCHECK_VERSION));

  // --- processArguments -------------------------------------------------------
  let parsedOk = true;
  try {
    parsedOk = await processArguments(args, st, { outln, errln, displayHelp, displayVersion });
  } catch (e) {
    // Mirrors run()'s `catch (Exception ignored) { returnValue = 1 }` for the
    // -v / -mode / -profile "argument expected/invalid" throw paths (which have
    // already printed `-help displays help` to stdout).
    if (e instanceof ParseError) return 1;
    throw e;
  }
  if (!parsedOk) return 1;

  // Early returns (before any report is created -> no summary block printed).
  if (st.displayHelp || (st.displayVersion && st.path === null)) return 0;

  // The (possibly localized) message table for every string the CLI formats
  // itself from here on. English unless a shipped non-English locale was named.
  const msgs = messagesFor(st.localeTag);

  // --listChecks: dump the (embedded) message dictionary, no validation.
  //
  // The jar localizes the Message/Suggestion columns from the report's localized
  // MessageBundle (MessageDictionaryDumper), so `--listChecks --locale <tag>`
  // emits the dictionary in that locale (ID/Severity columns stay locale-
  // invariant). It does NOT validate/refuse the locale on this path (an unshipped
  // tag simply falls back to English, exit 0), so the listChecks branch runs
  // BEFORE the unsupportedReason gate -- matching the jar exactly. Select the
  // localized dump the SAME way a run resolves the locale (resolveLocale): a shipped
  // non-English key -> its dump; English / an English-fallback tag -> the default.
  if (st.listChecks) {
    const listZero: ConsoleCounts = { fatal: 0, error: 0, warning: 0, info: 0, usage: 0 };
    const listKey = st.localeTag !== null ? resolveLocale(st.localeTag) : null;
    const listTsv =
      (listKey !== null && LIST_CHECKS_TSV_BY_LOCALE[listKey]) || LIST_CHECKS_TSV;
    if (st.listChecksOut === null) {
      // Written straight to System.out; the trailing summary is swallowed
      // because epubcheck's dumper closes the stdout stream.
      process.stdout.write(listTsv);
    } else {
      // EpubChecker.dumpMessageDictionary SWALLOWS a write failure: it prints the
      // absolute path (listChecksOut.getAbsoluteFile()) + the IOException message
      // to stderr, but run() still returns 0 on the listChecks branch and its
      // finally still prints the completion summary. So a write failure exits 0
      // with the summary, NOT 1 without it.
      try {
        await writeFile(st.listChecksOut, listTsv);
      } catch (e) {
        errln(formatTemplate(msgs.error_creating_config_file, pathResolve(process.cwd(), st.listChecksOut)));
        errln(javaIoErrorMessage(e, st.listChecksOut));
      }
      printCompleted(st, listZero, outln, msgs);
    }
    return 0;
  }

  // Anything the engine cannot faithfully reproduce -> fail loudly.
  const reason = unsupportedReason(st);
  if (reason !== null) {
    errln(`epubcheck-standalone-cli: unsupported option: ${reason}`);
    errln("  This capability is not available in the epubcheck-standalone engine.");
    errln("  See the \"Unsupported flags\" section of the epubcheck-standalone-cli README.");
    return EXIT_UNSUPPORTED;
  }

  const path = st.path as string;
  const cwd = process.cwd();
  // An http(s) URL input runs the engine's jar-parity URL mode (the URL itself
  // is epubcheck's input path), not read from disk, so the on-disk
  // existence/expanded routing is skipped.
  const isUrl = path.startsWith("http://") || path.startsWith("https://");
  const absPath = isUrl ? path : pathResolve(cwd, path);
  const exists = !isUrl && (await pathExists(absPath));
  const isDir = exists && (await stat(absPath)).isDirectory();
  const zeroCounts: ConsoleCounts = { fatal: 0, error: 0, warning: 0, info: 0, usage: 0 };

  // Expanded (directory / --mode exp) vs packaged/single-file routing, mirroring
  // epubcheck 5.3.0's EpubChecker: `-mode exp` (st.expanded) always means expanded
  // validation, and a directory input with no single-file `-mode` is auto-detected
  // as expanded too (a `.epub`-named directory, or a directory validated under a
  // `--profile`). A single-file `-mode` (xhtml/opf/svg/mo/nav) is never expanded.
  const useExpanded = !isUrl && (st.expanded || (st.mode === null && isDir));

  // The EPUB name epubcheck's DefaultReportImpl.formatMessage prefixes onto every
  // message location -- the same name the engine validated under (computed HERE,
  // before the run, so the live console stream can prefix each message as it
  // arrives): the URL itself for a URL input; the freshly packaged
  // `./<name>.epub` for an explicit `--mode exp` directory (the jar reports the
  // temp archive it built, relative to the working directory, so the prefix keeps
  // the leading `./`); else the bare input basename (a packaged file, a
  // single-file mode, or an auto-detected expanded directory validated in place).
  const reportedName = isUrl
    ? path
    : useExpanded && st.expanded
      ? `./${basename(absPath)}.epub`
      : basename(absPath);
  const formatActive = st.jsonOutput || st.xmlOutput || st.xmpOutput;

  // Live console streaming (DefaultReportImpl). With NO report format, the CLI
  // writes each console line AS THE ENGINE EMITS IT, exactly like the jar prints
  // during a run: per-message lines via the engine's live `onMessage`, and the
  // "Validating using EPUB version X rules." line via `onFeature` the moment the
  // FORMAT_VERSION feature arrives. The line/summary FORMATTING is the library's
  // shared console renderer (renderConsoleMessageLine / renderValidatingLine),
  // the same primitives the library's batch `formatConsoleReport` uses -- one
  // implementation, streamed here and batched there. Stream ROUTING stays a CLI
  // concern: USAGE goes to stdout (ignoring --quiet, like DefaultReportImpl's
  // pushQuiet), every other severity to stderr, both filtered by the reporting
  // level; the validating line is out-writer output (gated by level <= Info and
  // suppressed by --quiet via outln). A report format suppresses all per-message
  // console output, so no stream is installed then.
  const attachConsoleStream = (opts: EngineOpts): EngineOpts => {
    if (formatActive) return opts;
    opts.onFeature = (feature): void => {
      if (feature.feature === "FORMAT_VERSION" && st.reportingLevel <= ReportingLevel.Info) {
        const vline = renderValidatingLine(feature.value, msgs);
        if (vline !== null) outln(vline);
      }
    };
    opts.onMessage = (m): void => {
      if (severityReportingLevel(m.severity) < st.reportingLevel) return;
      const line = renderConsoleMessageLine(m, reportedName);
      if (m.severity === "USAGE") usageln(line);
      else errln(line);
    };
    return opts;
  };

  // --- validate() (the real work, via the engine) -----------------------------
  // The newly unlocked flags (--mode, --profile, --locale, -u) ride through to the
  // engine here; everything else stays a JS-layer concern (see buildEngineArgs).
  // Every branch just produces `result`; message rendering reproduces the jar's
  // console formatting from result.messages' raw location fields, prefixing the
  // reported EPUB name derived per branch below. Report documents come from the library rendering
  // the run's live report-event stream (result.reports), byte-identical to
  // epubcheck's own writers and already embedding the right filename.
  let result: EpubCheckResult;

  // -s/--save: the path of the packaged .epub this run wrote (expanded mode
  // only), so the post-run tail can delete it when the check found errors.
  let savedEpubPath: string | null = null;

  if (isUrl) {
    // Jar-parity URL mode: the URL is handed to
    // epubcheck as the input path, the engine suspends mid-run while the
    // library's async http bridge downloads it, and message locations carry
    // the URL exactly like the jar's. Download/connection failures no longer throw here: the
    // engine prints the jar's exception headline to stderr and exits 1, so
    // `result` comes back normally; the catch stays as a net for bridge-level
    // failures (e.g. url() rejecting a malformed URL).
    try {
      result = await validate(
        await urlSource(path),
        attachConsoleStream(await buildEngineOpts(st, cwd, false)),
      );
    } catch (e) {
      process.stderr.write(String((e as Error)?.stack ?? e) + "\n");
      printCompleted(st, zeroCounts, outln, msgs);
      return 1;
    }
  } else if (useExpanded) {
    // `--mode exp` requested but the input is not a directory. Mirrors epubcheck's
    // expanded path: "Directory not found" when the path is missing; otherwise no
    // messages are produced and the run finishes with errors (exit 1). Any
    // `-mode`/`-v`-ignored notice for a `.epub` path was already printed above.
    if (!isDir) {
      if (!exists) {
        errln(formatTemplate(msgs.directory_not_found, path));
      } else {
        errln(msgs.there_were_errors);
      }
      printCompleted(st, zeroCounts, outln, msgs);
      return 1;
    }
    // -s/--save with an EXPLICIT `--mode exp`: epubcheck packages the directory
    // into `<canonical-parent>/<dir-name>.epub` BEFORE validating (overwriting
    // any file already there) and deletes it again after a failing check. The
    // jar builds its Archive only on the explicit exp path, so an auto-detected
    // `.epub`-named directory never saves; and a packaging failure aborts with
    // "Check finished with errors" + the completion summary, exit 1, exactly
    // like EpubChecker.processFile's RuntimeException catch (which may leave a
    // partial file behind -- so does this).
    if (st.expanded && st.save) {
      try {
        savedEpubPath = await createArchive(absPath);
      } catch {
        errln(msgs.there_were_errors);
        printCompleted(st, zeroCounts, outln, msgs);
        return 1;
      }
    }
    try {
      const dirOpts = await buildEngineOpts(st, cwd, true);
      if (st.expanded) {
        // EXPLICIT `--mode exp`: the jar packages the directory tree into a
        // temp `<name>.epub` and validates that, so message locations carry
        // the packaged name. The library default is 'direct', so set 'exp'
        // explicitly to keep packaging (byte-identical to the jar's `--mode
        // exp`).
        dirOpts.dirMode = "exp";
      } else {
        // AUTO-DETECTED expanded book (a `.epub`-named directory, or a
        // directory under --profile, with no explicit `--mode exp`): the jar
        // never packages here -- EpubChecker leaves `expanded` false and
        // EpubCheck validates the directory IN PLACE, so message locations
        // carry the directory name itself (`junk.epub/mimetype`), not a
        // doubled `<name>.epub.epub` package name. The library's 'direct'
        // dirMode is exactly that path (and is now the library default).
        dirOpts.dirMode = "direct";
      }
      result = await validate(await fsDir(absPath), attachConsoleStream(dirOpts));
    } catch (e) {
      process.stderr.write(String((e as Error)?.stack ?? e) + "\n");
      printCompleted(st, zeroCounts, outln, msgs);
      return 1;
    }
  } else {
    // Missing file -> file_not_found (stderr) + summary block (stdout), exit 1.
    if (!exists) {
      errln(formatTemplate(msgs.file_not_found, path));
      printCompleted(st, zeroCounts, outln, msgs);
      return 1;
    }
    try {
      // A single-file `--mode` pointed at a DIRECTORY: epubcheck reads the
      // directory as a file and fails with FATAL(PKG-008) "Unable to read
      // file <abs>", the location carrying the trailing-slash directory form.
      // Hand the engine a directory placeholder (mounted as an empty VFS dir
      // at the host path) so it reproduces that byte-for-byte, rather than a
      // byte source whose read merely throws. A regular (possibly unreadable)
      // file goes straight through fs(), which now DEFERS an unreadable-file
      // error into the run itself -- FATAL(PKG-008) byte-for-byte like the jar.
      const source: RangeSource = isDir
        ? {
            name: basename(absPath),
            hostDir: dirname(absPath),
            isDirectory: true,
            size: 0,
            read: () => {
              throw new Error("epubcheck-standalone-cli: a directory has no file bytes");
            },
            [DISPOSE]() {},
          }
        : await fsSource(absPath);
      result = await validate(source, attachConsoleStream(await buildEngineOpts(st, cwd, false)));
    } catch (e) {
      // Mirrors the top-level `catch` -> exit 1, then the completion summary.
      process.stderr.write(String((e as Error)?.stack ?? e) + "\n");
      printCompleted(st, zeroCounts, outln, msgs);
      return 1;
    }
  }

  // A run that returned normally but FAILED before producing any structured
  // message -- e.g. a URL download error (404 / connection refused) -- mirrors
  // EpubChecker.run's catch/finally: the engine already carries the jar-identical
  // exception headline on result.stderr and the jar-parity exit code on
  // result.exitCode. The count-derived tail below never fires (no messages), so
  // it would otherwise print a bogus "No errors or warnings detected." and exit
  // 0; instead surface the engine's failure output verbatim (headline to stderr,
  // completion summary to stdout) and exit with its jar-parity code. System.err
  // ignores --quiet, exactly like the jar.
  if ((result.exitCode ?? 0) !== 0 && result.messages.length === 0) {
    if (result.stderr.length > 0) process.stderr.write(result.stderr);
    printCompleted(st, zeroCounts, outln, msgs);
    return result.exitCode as number;
  }

  const actual = countConsoleSeverities(result.messages);
  const shown = displayedConsoleCounts(actual, st.reportingLevel);
  const reportToConsole = formatActive && st.fileOut === null;

  // 1) The report document (JSON/XML/XMP), if requested. A report format
  //    suppresses all per-message console output, so nothing was streamed during
  //    the run (attachConsoleStream installs no stream when a format is active).
  if (formatActive) {
    const reportText = renderReport(st, result);
    if (st.fileOut === null) {
      process.stdout.write(reportText); // straight to System.out, ignores --quiet
    } else {
      const outPath = st.fileOut as string;
      try {
        await writeFile(outPath, reportText);
      } catch {
        // JSON writer prints this to stdout and returns 1 on IO failure.
        if (st.jsonOutput) outln("Incorrect path to save JsonFile.");
        else errln("Error while generating the report.");
        printCompleted(st, shown, outln, msgs);
        return 1;
      }
    }
  }

  // 2 & 3) The "Validating using EPUB version X rules." line and the per-message
  //    console lines (DefaultReportImpl) were STREAMED LIVE during validate() by
  //    attachConsoleStream -- each written to stdout/stderr the instant the
  //    engine emitted it, byte-identical to the jar and printed AS the checker
  //    produced it (not batched at the end). Only the run-completion chrome
  //    below (validateFile's tail + printEpubCheckCompleted) is emitted here.

  // 4) validateFile's tail: no_errors / there_were_warnings / there_were_errors,
  //    computed from the reporting-level-filtered counts.
  let exitCode: number;
  if (shown.fatal === 0 && shown.error === 0 && shown.warning === 0) {
    if (!reportToConsole) outln(msgs.no_errors__or_warnings);
    exitCode = 0;
  } else if (shown.warning > 0 && shown.fatal === 0 && shown.error === 0) {
    errln(msgs.there_were_warnings);
    exitCode = st.failOnWarnings ? 1 : 0;
  } else {
    errln(msgs.there_were_errors);
    exitCode = 1;
  }

  // 4b) -s/--save deletion (EpubChecker.processFile): the packaged file this run
  //     wrote is deleted again, with the announcement on stderr, when the check
  //     found errors or fatals -- judged on the same reporting-level-filtered
  //     counts as the exit code, so `-f` on an error-only book keeps the file
  //     (verified against the jar). Warnings keep it too, even with
  //     --failonwarnings. The delete-failure text is the jar's hardcoded
  //     Archive.deleteEpubFile string (never localized).
  if (savedEpubPath !== null && (shown.fatal > 0 || shown.error > 0)) {
    errln(msgs.deleting_archive);
    try {
      await unlink(savedEpubPath);
    } catch {
      errln("Unable to delete generated archive.");
    }
  }

  // 5) The "Messages: ... / EPUBCheck completed" summary (printEpubCheckCompleted).
  //    Suppressed when the report went to the console (epubcheck closes stdout).
  if (!reportToConsole) {
    printCompleted(st, shown, outln, msgs);
  }

  return exitCode;
}

/** printEpubCheckCompleted: the summary counters + "EPUBCheck completed". */
function printCompleted(
  st: State,
  counts: ConsoleCounts,
  outln: (s: string) => void,
  msgs: Messages,
): void {
  // The "Messages: ..." line is the library's shared summary renderer (the same
  // one the batch formatConsoleReport uses); the CLI supplies its own localized
  // label table (Messages structurally satisfies ConsoleLabels).
  const line = renderConsoleSummaryLine(counts, st.reportingLevel, msgs);
  if (line.length > 0) {
    // messageCount.append("\n"); outWriter.println(messageCount) -> "...\n\n"
    outln(line + "\n");
  }
  outln(msgs.epubcheck_completed);
}

function renderReport(st: State, result: EpubCheckResult): string {
  // The report content (result.reports) is rendered by the library's formatters
  // from the run's live report-event stream -- byte-identical to epubcheck's
  // own --json/--out/--xmp writers, from ONE validation run.
  const reports = result.reports ?? {};
  if (st.xmlOutput) return reports.xml ?? "";
  if (st.xmpOutput) return reports.xmp ?? "";
  return reports.json ?? "";
}

/** The shipped locale tags, in the order epubcheck's help lists them, for the
 *  unsupported-locale message. */
const SUPPORTED_LOCALE_LIST = "da, de, en, es, fr, it, ja, ko-KR, nl, pt-BR, zh-TW";

/** Returns a human description of the first unsupported flag, or null. */
function unsupportedReason(st: State): string | null {
  // A locale is supportable when it resolves to a shipped bundle through its own
  // ResourceBundle candidate chain (region -> language), independently of the host
  // default locale. A tag that would need Java's host-dependent default-locale
  // fallback (bare ko/pt/zh, or an unshipped language like pl/ru) is refused: its
  // jar output is not provably byte-identical across hosts.
  if (st.localeTag !== null && resolveLocale(st.localeTag) === null) {
    return `--locale ${st.localeTag} (the engine image only ships these locales: ${SUPPORTED_LOCALE_LIST})`;
  }
  return null;
}

/**
 * The epubcheck CLI arguments to hand to the engine, placed before the input path
 * exactly as on the stock CLI. Only flags the CLI cannot reproduce post-hoc from a
 * default INFO-level run are passed through: `-u` (USAGE is below INFO, so the
 * engine must run at that level for the tap to carry usage messages), `--mode`
 * with its `-v` version (single-file checking), a non-default `--profile`, and
 * `--locale` (localized message text + locale-sensitive validation). Everything
 * else (severity filtering, --quiet, report files, --save, --failonwarnings) stays
 * a JS-layer concern so its byte-identical behavior is preserved.
 *
 * `forDirectory` builds the args for expanded mode (a directory source): the
 * engine injects `--mode exp` itself and rejects a conflicting `--mode`/`-v`, so
 * the single-file mode/version pair is omitted while `-u`, `--profile`, and
 * `--locale` still ride through.
 */
function buildEngineArgs(st: State, forDirectory = false): string[] {
  const args: string[] = [];
  if (st.reportingLevel === ReportingLevel.Usage) {
    args.push("-u");
  }
  if (!forDirectory && st.mode !== null) {
    args.push("--mode", st.mode, "-v", st.version);
  }
  if (st.profile !== null && st.profile !== "DEFAULT" && KNOWN_PROFILES.has(st.profile)) {
    args.push("--profile", st.profile.toLowerCase());
  }
  if (st.localeTag !== null) {
    args.push("--locale", st.localeTag);
  }
  return args;
}

/** The epubcheck engine options for a run: the passthrough args plus, when
 *  -c/--customMessages named a file, the custom-message overrides. An EXISTING
 *  overrides file rides through the `customMessages` option (the engine mounts it
 *  and points -c at the mounted copy, so the CHK-00x locations print ./<name>);
 *  a MISSING one is left on `args` verbatim so the engine emits CHK-001 exactly
 *  like the jar does for a missing cwd-relative file. */
async function buildEngineOpts(
  st: State,
  cwd: string,
  forDirectory: boolean,
): Promise<EngineOpts> {
  const args = buildEngineArgs(st, forDirectory);
  const opts: EngineOpts = { args };
  if (st.customMessagesPath !== null) {
    const cmAbs = pathResolve(cwd, st.customMessagesPath);
    // An EXISTING overrides file is fed by CONTENT under its basename (the engine
    // mounts it and points -c at that name); a MISSING one is left on args
    // verbatim so the engine emits CHK-001 like the jar does for a missing file.
    if (await pathExists(cmAbs)) {
      opts.customMessages = await readFile(cmAbs, "utf8");
      opts.customMessagesName = basename(st.customMessagesPath);
    } else {
      args.push("-c", st.customMessagesPath);
    }
  }
  // Report output comes via the library's reports option (writer-identical
  // documents rendered from the run's live report-event stream).
  const reports: Array<"json" | "xml" | "xmp"> = [];
  if (st.jsonOutput) reports.push("json");
  if (st.xmlOutput) reports.push("xml");
  if (st.xmpOutput) reports.push("xmp");
  if (reports.length > 0) opts.reports = reports;
  return opts;
}

interface Emit {
  outln: (s: string) => void;
  errln: (s: string) => void;
  displayHelp: () => void;
  displayVersion: () => void;
}

/** Faithful port of EpubChecker.processArguments (returns false == exit 1). */
async function processArguments(args: string[], st: State, e: Emit): Promise<boolean> {
  if (args.length < 1) {
    e.errln(M.argument_needed);
    return false;
  }

  // Env var pre-load (setCustomMessageFileFromEnvironment).
  const envFile = process.env["ePubCheckCustomMessageFile"];
  if (envFile && envFile.length > 0 && (await pathExists(envFile))) {
    st.customMessagesPath = envFile;
  }

  const argPattern = /^--?(.*)$/;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    const match = argPattern.exec(arg);
    if (match) {
      const key = match[1] as string;
      switch (key) {
        case "v":
          if (i + 1 < args.length) {
            ++i;
            const v = args[i] as string;
            if (v === "2.0" || v === "2") st.version = "2.0";
            else if (v === "3.0" || v === "3") st.version = "3.0";
            else {
              e.outln(M.display_help);
              throw new ParseError("unsupported version");
            }
          } else {
            e.outln(M.display_help);
            throw new ParseError("version argument expected");
          }
          break;
        case "m":
        case "mode":
          if (i + 1 < args.length) {
            st.mode = args[++i] as string;
            st.expanded = st.mode === "exp";
          } else {
            e.outln(M.display_help);
            throw new ParseError("mode argument expected");
          }
          break;
        case "p":
        case "profile":
          if (i + 1 < args.length) {
            const profileStr = args[++i] as string;
            const up = profileStr.toUpperCase();
            if (KNOWN_PROFILES.has(up)) {
              st.profile = up;
            } else {
              // epubcheck prints the (mis-keyed) mode_version_ignored text and
              // falls back to the default profile.
              e.errln(M.mode_version_ignored);
              st.profile = "DEFAULT";
            }
          } else {
            e.outln(M.display_help);
            throw new ParseError("profile argument expected");
          }
          break;
        case "s":
        case "save":
          // epubcheck's `keep` flag: with an explicit `--mode exp`, keep the
          // packaged .epub the expanded check builds beside the input directory
          // (it is deleted again when the check finds errors or fatals).
          st.save = true;
          break;
        case "o":
        case "out":
          i += await consumeOutputArg(args, i, st, "xml");
          st.xmlOutput = true;
          break;
        case "j":
        case "json":
          i += await consumeOutputArg(args, i, st, "json");
          st.jsonOutput = true;
          break;
        case "x":
        case "xmp":
          i += await consumeOutputArg(args, i, st, "xmp");
          st.xmpOutput = true;
          break;
        case "i":
        case "info":
          st.reportingLevel = ReportingLevel.Info;
          break;
        case "f":
        case "fatal":
          st.reportingLevel = ReportingLevel.Fatal;
          break;
        case "e":
        case "error":
          st.reportingLevel = ReportingLevel.Error;
          break;
        case "w":
        case "warn":
          st.reportingLevel = ReportingLevel.Warning;
          break;
        case "u":
        case "usage":
          st.reportingLevel = ReportingLevel.Usage;
          break;
        case "q":
        case "quiet":
          st.quiet = true;
          break;
        case "failonwarnings":
          st.failOnWarnings = true;
          break;
        case "r":
        case "redir":
          if (i + 1 < args.length) {
            st.fileOut = args[++i] as string;
          }
          break;
        case "c":
        case "customMessages":
          if (i + 1 < args.length) {
            const fileName = args[i + 1] as string;
            if (fileName.toLowerCase() === "none") {
              st.customMessagesPath = null;
              ++i;
            } else if (!fileName.startsWith("-")) {
              st.customMessagesPath = fileName;
              ++i;
            } else {
              e.errln(formatTemplate(M.expected_message_filename, fileName));
              e.displayHelp();
              return false;
            }
          }
          break;
        case "l":
        case "listChecks":
          if (i + 1 < args.length) {
            if (!(args[i + 1] as string).startsWith("-")) {
              st.listChecksOut = args[++i] as string;
            } else {
              st.listChecksOut = null;
            }
          }
          st.listChecks = true;
          break;
        case "locale":
          if (i + 1 < args.length) {
            if ((args[i + 1] as string).startsWith("-")) {
              e.errln(formatTemplate(M.incorrect_locale, args[i + 1] as string));
              e.displayHelp();
              return false;
            } else {
              st.localeTag = args[++i] as string;
            }
          } else {
            e.errln(formatTemplate(M.missing_locale));
            e.displayHelp();
            return false;
          }
          break;
        case "h":
        case "?":
        case "help":
          e.displayHelp();
          st.displayHelp = true;
          break;
        case "version":
          e.displayVersion();
          st.displayVersion = true;
          break;
        default:
          e.errln(formatTemplate(M.unrecognized_argument, arg));
          e.displayHelp();
          return false;
      }
    } else {
      if (st.path === null) {
        st.path = arg;
      } else {
        e.errln(formatTemplate(M.unrecognized_argument, arg));
        e.displayHelp();
        return false;
      }
    }
  }

  if (
    (st.xmlOutput && st.xmpOutput) ||
    (st.xmlOutput && st.jsonOutput) ||
    (st.xmpOutput && st.jsonOutput)
  ) {
    e.errln(M.output_type_conflict);
    return false;
  }

  if (st.path !== null) {
    st.path = st.path.replace(/\\/g, "/");
  }

  if (st.path === null) {
    if (st.listChecks || st.displayHelp || st.displayVersion) {
      return true;
    }
    e.errln(M.no_file_specified);
    return false;
  } else if (/^.+\.[Ee][Pp][Uu][Bb]$/.test(st.path)) {
    if (st.mode !== null || st.version !== "3.0") {
      e.errln(M.mode_version_ignored);
      st.mode = null;
    }
  } else if (st.mode === null && st.profile === null) {
    e.outln(M.mode_required);
    return false;
  }

  return true;
}

/**
 * The -o/-j/-x value rule (EpubChecker lines 570-647): explicit filename, "-"
 * for console (fileOut=null), or auto-derive the report filename. Sets
 * st.fileOut and returns how many extra args were consumed (0 or 1).
 */
async function consumeOutputArg(
  args: string[],
  i: number,
  st: State,
  kind: "xml" | "json" | "xmp",
): Promise<number> {
  const next = args[i + 1];
  if (next !== undefined && !next.startsWith("-")) {
    st.fileOut = next;
    return 1;
  } else if (next !== undefined && next.toLowerCase() === "-") {
    st.fileOut = null;
    return 1;
  } else {
    // Auto-derive. epubcheck's own rule (EpubChecker.processArguments): when the
    // input is a directory it writes the report beside it, at
    // <absolute-parent>/<basename>check.<ext>; otherwise it appends
    // "check.<ext>" to the raw path.
    //
    // `path` may still be null here if the flag preceded the positional (e.g.
    // `-o -q`, `-o` last, `-j -x`, or even `-o -q book.epub` -- the positional
    // is seen only later in the loop). The jar builds `new File(path)` at THIS
    // point, so a null path is `new File((String)null)` -> NullPointerException,
    // thrown inside processArguments and swallowed by run()'s
    // `catch (Exception ignored){returnValue=1}` -> exit 1 with NO stdout/stderr.
    // Reproduce that exactly: a silent ParseError (run() returns 1, nothing
    // printed), NOT our former "No file specified in the arguments." text.
    if (st.path === null) {
      throw new ParseError("-o/-j/-x auto-derive with no input path (jar NPE)");
    }
    if ((await pathExists(st.path)) && (await stat(st.path)).isDirectory()) {
      const abs = pathResolve(st.path);
      st.fileOut = pathJoin(dirname(abs), basename(abs) + "check." + kind);
    } else {
      st.fileOut = st.path + "check." + kind;
    }
    return 0;
  }
}

// --- Entry point ------------------------------------------------------------
// Run only when invoked as the CLI binary (not when imported by tests). Compare
// resolved real paths so it also fires through the `node_modules/.bin` symlink.
async function isMainModule(): Promise<boolean> {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return (await realpath(argv1)) === (await realpath(fileURLToPath(import.meta.url)));
  } catch {
    return false;
  }
}

// Top-level await is available (this is an ES module); resolving the two
// realpaths asynchronously keeps the bootstrap guard off the event loop like
// every other fs touch (async law). Importers (the tests) just await the
// module's evaluation as they already do for any ESM; isMainModule() is false
// for them so run() is never invoked.
if (await isMainModule()) {
  run(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      process.stderr.write(String((err as Error)?.stack ?? err) + "\n");
      process.exitCode = 1;
    },
  );
}
