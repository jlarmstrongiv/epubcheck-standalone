// epubcheck-standalone -- the CONSOLE report renderer, byte-identical to
// epubcheck's own human-readable console output (`java -jar epubcheck.jar
// <book>`), fed by the same `ReportData` the json/xml/xmp formatters consume.
//
// This is the SINGLE implementation of epubcheck's console line/summary
// formatting. Two consumers share it:
//   - the CLI (packages/epubcheck-standalone-cli) drives these primitives from
//     the engine's LIVE `onMessage`/`onFeature` stream, writing each line to
//     stdout/stderr as the checker produces it (jar-identical streaming), and
//   - `formatConsoleReport()` here is the BATCH convenience: it loops the same
//     primitives over a whole `ReportData` and returns the complete console text
//     as one string (for offline re-render from a saved `ReportData`, and for
//     the web demo's console-format download). Both produce identical bytes.
//
// Ported from epubcheck 5.3.0's DefaultReportImpl (formatMessage / fixMessage /
// info) and EpubChecker (validateFile tail + printEpubCheckCompleted summary):
//   - per-message line:  SEVERITY(ID): <epubName><fileName>(line,col): message
//   - the "Validating using EPUB version X rules." line is DefaultReportImpl.info
//     printing the FORMAT_VERSION feature value (gated by reporting level <= Info
//     and !quiet) -- so it is reproduced from `ReportData.features`, no faking;
//   - the "No errors or warnings detected." / "Check finished with warnings" /
//     "Check finished with errors" tail (validateFile), and
//   - the "Messages: N fatals / ..." summary + "EPUBCheck completed" footer
//     (printEpubCheckCompleted), both gated by the reporting level.
//
// LOCALE: message TEXT is already localized inside `ReportData.messages[].message`
// (the engine tap localizes it). Only the CHROME wording (validating line, the
// tail, the summary counters, the footer) needs a message table; the caller
// supplies it via `options.labels` (the CLI passes its own localized table --
// see packages/epubcheck-standalone-cli/src/messages.ts + locale-messages.ts --
// so no locale table is reinvented here). English is the default.

import type { ReportData, ReportMessage, ReportSeverity } from './index.js';

// ---------------------------------------------------------------------------
// reporting levels (com.adobe.epubcheck.util.ReportingLevel)
// ---------------------------------------------------------------------------

/** Reporting levels, mirroring com.adobe.epubcheck.util.ReportingLevel. */
export const ReportingLevel = {
  Fatal: 5,
  Error: 4,
  Warning: 3,
  Info: 2,
  Usage: 1,
  Suppressed: 0,
} as const;

/** The reporting level a given message severity is gated by. */
export function severityReportingLevel(severity: ReportSeverity): number {
  switch (severity) {
    case 'FATAL':
      return ReportingLevel.Fatal;
    case 'ERROR':
      return ReportingLevel.Error;
    case 'WARNING':
      return ReportingLevel.Warning;
    case 'INFO':
      return ReportingLevel.Info;
    case 'USAGE':
      return ReportingLevel.Usage;
    default:
      return ReportingLevel.Suppressed;
  }
}

// ---------------------------------------------------------------------------
// per-message line (DefaultReportImpl.formatMessage + fixMessage)
// ---------------------------------------------------------------------------

/** DefaultReportImpl.fixMessage: collapse Java whitespace runs to one space. */
export function fixConsoleMessage(message: string): string {
  if (message === null || message === undefined) return '';
  return message.replace(/[ \t\n\f\r]+/g, ' ');
}

/**
 * Render ONE message line exactly like DefaultReportImpl.formatMessage:
 *   SEVERITY(ID): <epubName><fileName>(line,col): fixMessage(text)
 * where `fileName` is "" when `epubName` already ends with the message's `path`
 * (the location IS the EPUB itself), else "/" + `path`. The raw message text
 * (message.message) is run through fixConsoleMessage at render, matching the
 * jar's own composition byte-for-byte (the custom-message override annotation
 * arrives already inside the raw text with its leading space).
 */
export function renderConsoleMessageLine(message: ReportMessage, epubName: string): string {
  const fileName = epubName.endsWith(message.path) ? '' : '/' + message.path;
  return (
    `${message.severity}(${message.id}): ${epubName}${fileName}` +
    `(${message.line},${message.column}): ${fixConsoleMessage(message.message)}`
  );
}

// ---------------------------------------------------------------------------
// counts + summary (EpubChecker.printEpubCheckCompleted)
// ---------------------------------------------------------------------------

export interface ConsoleCounts {
  fatal: number;
  error: number;
  warning: number;
  info: number;
  usage: number;
}

/** Count messages by severity (the raw, pre-level-filter tallies). */
export function countConsoleSeverities(messages: readonly ReportMessage[]): ConsoleCounts {
  const c: ConsoleCounts = { fatal: 0, error: 0, warning: 0, info: 0, usage: 0 };
  for (const m of messages) {
    if (m.severity === 'FATAL') c.fatal++;
    else if (m.severity === 'ERROR') c.error++;
    else if (m.severity === 'WARNING') c.warning++;
    else if (m.severity === 'INFO') c.info++;
    else if (m.severity === 'USAGE') c.usage++;
  }
  return c;
}

/** The counts as DISPLAYED after applying the reporting-level filter. */
export function displayedConsoleCounts(actual: ConsoleCounts, reportingLevel: number): ConsoleCounts {
  return {
    fatal: reportingLevel <= ReportingLevel.Fatal ? actual.fatal : 0,
    error: reportingLevel <= ReportingLevel.Error ? actual.error : 0,
    warning: reportingLevel <= ReportingLevel.Warning ? actual.warning : 0,
    info: reportingLevel <= ReportingLevel.Info ? actual.info : 0,
    usage: reportingLevel <= ReportingLevel.Usage ? actual.usage : 0,
  };
}

/**
 * The CHROME/summary strings the console renderer formats itself (everything
 * that is NOT the already-localized per-message text). The CLI's message table
 * (packages/epubcheck-standalone-cli/src/messages.ts) structurally satisfies
 * this, so it is passed straight through; `DEFAULT_CONSOLE_LABELS` is the
 * English fallback for a standalone caller.
 */
export interface ConsoleLabels {
  validating_version_message: string;
  no_errors__or_warnings: string;
  there_were_warnings: string;
  there_were_errors: string;
  messages: string;
  counter_fatal_zero: string;
  counter_fatal_one: string;
  counter_fatal_many: string;
  counter_error_zero: string;
  counter_error_one: string;
  counter_error_many: string;
  counter_warn_zero: string;
  counter_warn_one: string;
  counter_warn_many: string;
  counter_info_zero: string;
  counter_info_one: string;
  counter_info_many: string;
  counter_usage_zero: string;
  counter_usage_one: string;
  counter_usage_many: string;
  epubcheck_completed: string;
}

/** The English (default resource-bundle) chrome strings, verbatim from epubcheck. */
export const DEFAULT_CONSOLE_LABELS: ConsoleLabels = {
  validating_version_message: 'Validating using EPUB version %1$s rules.',
  no_errors__or_warnings: 'No errors or warnings detected.',
  there_were_warnings: '\nCheck finished with warnings',
  there_were_errors: '\nCheck finished with errors',
  messages: 'Messages',
  counter_fatal_zero: '0 fatals',
  counter_fatal_one: '1 fatal',
  counter_fatal_many: '%1$d fatals',
  counter_error_zero: '0 errors',
  counter_error_one: '1 error',
  counter_error_many: '%1$d errors',
  counter_warn_zero: '0 warnings',
  counter_warn_one: '1 warning',
  counter_warn_many: '%1$d warnings',
  counter_info_zero: '0 infos',
  counter_info_one: '1 info',
  counter_info_many: '%1$d infos',
  counter_usage_zero: '0 usages',
  counter_usage_one: '1 usage',
  counter_usage_many: '%1$d usages',
  epubcheck_completed: 'EPUBCheck completed',
};

/**
 * Java printf-style substitution for the positional placeholders (`%1$s`,
 * `%1$d`) the epubcheck chrome strings use.
 */
export function formatTemplate(template: string, ...args: Array<string | number>): string {
  return template.replace(/%(\d+)\$[sd]/g, (_m, idx: string) => {
    const v = args[Number(idx) - 1];
    return v === undefined ? '' : String(v);
  });
}

function counter(
  kind: 'fatal' | 'error' | 'warn' | 'info' | 'usage',
  count: number,
  labels: ConsoleLabels,
): string {
  const variant = count === 0 ? 'zero' : count === 1 ? 'one' : 'many';
  const key = `counter_${kind}_${variant}` as keyof ConsoleLabels;
  return formatTemplate(labels[key], count);
}

/**
 * The "Validating using EPUB version X rules." line (DefaultReportImpl.info on
 * a FORMAT_VERSION feature), or null when the version is absent/blank. Gating by
 * reporting level / quiet is the caller's concern.
 */
export function renderValidatingLine(version: string | null, labels: ConsoleLabels): string | null {
  if (version === null || version === undefined || version.length === 0) return null;
  return formatTemplate(labels.validating_version_message, version);
}

/**
 * The "Messages: N fatals / N errors / ..." summary line exactly like
 * EpubChecker.printEpubCheckCompleted, gated by the reporting level. `counts`
 * are the DISPLAYED counts (already level-filtered). Returns "" when the level
 * is Suppressed (no counters emitted).
 */
export function renderConsoleSummaryLine(
  counts: ConsoleCounts,
  reportingLevel: number,
  labels: ConsoleLabels,
): string {
  let s = '';
  if (reportingLevel <= ReportingLevel.Fatal) {
    s += labels.messages + ': ' + counter('fatal', counts.fatal, labels);
  }
  if (reportingLevel <= ReportingLevel.Error) {
    s += ' / ' + counter('error', counts.error, labels);
  }
  if (reportingLevel <= ReportingLevel.Warning) {
    s += ' / ' + counter('warn', counts.warning, labels);
  }
  if (reportingLevel <= ReportingLevel.Info) {
    s += ' / ' + counter('info', counts.info, labels);
  }
  if (reportingLevel <= ReportingLevel.Usage) {
    s += ' / ' + counter('usage', counts.usage, labels);
  }
  return s;
}

// ---------------------------------------------------------------------------
// batch console report (formatConsoleReport)
// ---------------------------------------------------------------------------

export interface ConsoleFormatterOptions {
  /**
   * The reported EPUB name that prefixes every message location (the same name
   * epubcheck validated under). For a packaged book this is its file name
   * (e.g. "book.epub").
   */
  filename: string;
  /**
   * Reporting level (see `ReportingLevel`); defaults to Info -- the stock CLI
   * default (fatals + errors + warnings + infos, plus the validating line).
   */
  reportingLevel?: number;
  /**
   * epubcheck's `-q/--quiet`: suppress the stdout chrome the out-writer emits
   * (the validating line, USAGE message lines, the "No errors..." line, and the
   * summary/footer). System.err message lines are unaffected. Defaults to false.
   */
  quiet?: boolean;
  /** Chrome/summary wording; defaults to English (`DEFAULT_CONSOLE_LABELS`). */
  labels?: ConsoleLabels;
}

/**
 * Render the COMPLETE human-readable console output of one validation run from
 * its `ReportData`, byte-identical to `java -jar epubcheck.jar <book>` with both
 * streams captured together (stdout + stderr in program order). This is the
 * batch counterpart of the CLI's live-streamed console: it loops the shared
 * primitives above over `reportData` and returns one string.
 *
 * The lines, in epubcheck's own emission order:
 *   1. "Validating using EPUB version X rules." (from the FORMAT_VERSION
 *      feature), when level <= Info and not quiet;
 *   2. one line per message, in emission order, filtered by the reporting level
 *      (USAGE lines are also suppressed under --quiet, matching the out-writer);
 *   3. the validateFile tail -- "No errors or warnings detected." when clean
 *      (level-filtered), else "Check finished with warnings"/"...errors";
 *   4. the "Messages: ..." summary + "EPUBCheck completed" footer, when not
 *      quiet.
 */
export function formatConsoleReport(reportData: ReportData, options: ConsoleFormatterOptions): string {
  const epubName = options && options.filename;
  if (typeof epubName !== 'string' || epubName.length === 0) {
    throw new Error('formatConsoleReport: options.filename (string) is required -- the EPUB name');
  }
  const level = options.reportingLevel ?? ReportingLevel.Info;
  const quiet = options.quiet ?? false;
  const labels = options.labels ?? DEFAULT_CONSOLE_LABELS;

  const lines: string[] = [];

  // 1+2) The validating line(s) and the per-message lines share ONE emission
  //    stream in epubcheck: the "Validating using EPUB version X rules." line is
  //    DefaultReportImpl.info printing a FORMAT_VERSION feature the instant it
  //    arrives, interleaved with the messages in true program order. A
  //    container/OCF-level message (e.g. WARNING(PKG-010)) can be emitted BEFORE
  //    the version is determined, so the validating line is NOT always first.
  //    We reconstruct that single order by merging the two lists on `sequence`
  //    (the global emission index stamped on every message and feature), rather
  //    than always emitting the validating line ahead of the messages.
  interface OrderedLine {
    sequence: number;
    text: string;
  }
  const ordered: OrderedLine[] = [];

  // Validating line -- one per FORMAT_VERSION feature (there is one per
  //    full-EPUB run; single-file checks and fatal containers emit none, so none
  //    is printed), gated exactly like DefaultReportImpl.info.
  if (level <= ReportingLevel.Info && !quiet) {
    for (const f of reportData.features) {
      if (f.feature === 'FORMAT_VERSION') {
        const vline = renderValidatingLine(f.value, labels);
        if (vline !== null) ordered.push({ sequence: f.sequence, text: vline });
      }
    }
  }

  // Per-message lines, filtered by the reporting level. USAGE routes through the
  //    out-writer (so --quiet drops it); every other severity routes through
  //    System.err (unaffected by --quiet).
  for (const m of reportData.messages) {
    if (severityReportingLevel(m.severity) < level) continue;
    if (m.severity === 'USAGE' && quiet) continue;
    ordered.push({ sequence: m.sequence, text: renderConsoleMessageLine(m, epubName) });
  }

  // Merge into the single program order. Array.sort is stable (ES2019+), so any
  //    entries without a distinct sequence (legacy report data saved before the
  //    field existed, where every sequence is undefined -> 0) keep their insert
  //    order: the validating line first, then messages -- the prior behavior.
  ordered.sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
  for (const o of ordered) lines.push(o.text);

  // 3) validateFile's tail, from the level-filtered counts.
  const shown = displayedConsoleCounts(countConsoleSeverities(reportData.messages), level);
  if (shown.fatal === 0 && shown.error === 0 && shown.warning === 0) {
    if (!quiet) lines.push(labels.no_errors__or_warnings);
  } else if (shown.warning > 0 && shown.fatal === 0 && shown.error === 0) {
    lines.push(labels.there_were_warnings); // leading "\n" yields the blank line before it
  } else {
    lines.push(labels.there_were_errors);
  }

  // 4) printEpubCheckCompleted: the summary + footer (out-writer -> --quiet).
  if (!quiet) {
    const summary = renderConsoleSummaryLine(shown, level, labels);
    if (summary.length > 0) {
      lines.push(summary);
      lines.push(''); // messageCount.append("\n") before println -> a blank line
    }
    lines.push(labels.epubcheck_completed);
  }

  return lines.length === 0 ? '' : lines.join('\n') + '\n';
}
