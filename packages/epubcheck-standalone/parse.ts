// epubcheck-standalone -- the reusable console-line parser (public API:
// `epubcheck-standalone/parse`).
//
// epubcheck prints one line per message to the console:
//   SEVERITY(CODE): <path>(line,col): message      (with a location)
//   SEVERITY(CODE): message                        (no location)
// plus an informational line:
//   Validating using EPUB version 3.3 rules.
//
// This module turns those raw lines into structured records. The low-level
// tokenizer (parseMessageLine / parseEpubcheckLines) returns the location path
// exactly as printed. Keeping the tokenizer here means the demo, the CLI, and
// any other consumer share one battle-tested regex instead of re-deriving it.
//
// It ALSO hosts the one higher-level console reader the isomorphic runner shares
// across environments: `parseConsoleReport(text)` returns the exact
// `EpubCheckResult`-shaped `{ messages, summary }` that `validate()` puts on its
// result in Node (index.ts) and in the browser (validate-browser.ts). This is the
// single source of that logic, so the two environments cannot drift. The result
// types those readers use (EpubCheckMessage, EpubCheckSummary, ...) live in
// result-types.js -- their one public home is the main entry, not this subpath,
// so they are imported here (type only) and never re-exported.
//
// This module is environment-neutral ESM with no runtime imports (the one import
// below is type-only and erased), so it loads cleanly in a browser Worker.

import type {
  Severity,
  MessageLocation,
  EpubCheckMessage,
  EpubCheckSummary,
} from './result-types.js';

/** Severities epubcheck can print on a console message line. */
export type ParsedSeverity = 'FATAL' | 'ERROR' | 'WARNING' | 'INFO' | 'USAGE';

/** One parsed console message line (location path returned verbatim). */
export interface ParsedMessage {
  severity: ParsedSeverity;
  /** epubcheck message code, e.g. "RSC-005". */
  code: string;
  /** Location path exactly as printed, or null. */
  path: string | null;
  /** 1-based line, or null when the message has no location. */
  line: number | null;
  /** 1-based column, or null when the message has no location. */
  column: number | null;
  /** Human-readable message text. */
  message: string;
}

/** Result of parsing a run's console lines. */
export interface ParsedOutput {
  messages: ParsedMessage[];
  /** The EPUB version epubcheck validated against, if it printed the line. */
  epubVersion: string | null;
}

// SEVERITY(CODE): rest
//
// The CODE grammar covers every spelling epubcheck's MessageId enum actually
// prints: most ids are "XXX-nnn", but some print with an UNDERSCORE separator
// (HTM_053..HTM_061, MED_006..MED_018 -- upstream quirk, e.g. "HTM_056",
// "MED_017") and some carry a single lowercase suffix letter ("HTM-014a",
// "OPF-004a".."OPF-004f", "RSC-007w", "HTM_060a"). A hyphen-digits-only
// pattern here once silently dropped every underscore/suffix-letter message
// from the structured results (parity-audit Gap A).
const MESSAGE_RE = /^(FATAL|ERROR|WARNING|INFO|USAGE)\(([A-Z0-9]+[-_]\d+[a-z]?)\):\s*([\s\S]*)$/;
// path(line,col): message
const LOCATION_RE = /^(.*?)\((\d+),(\d+)\):\s*([\s\S]*)$/;
// "Validating using EPUB version 3.3 rules."
const VERSION_RE = /^Validating using EPUB version (.+?) rules\.$/;

/** Extract the EPUB version from a "Validating using EPUB version X rules." line. */
export function parseEpubVersion(line: string): string | null {
  const m = line.match(VERSION_RE);
  return m ? (m[1] ?? null) : null;
}

/**
 * Parse a single console line into a structured message, or null if the line is
 * not a `SEVERITY(CODE): ...` message line. The line should already be trimmed
 * and free of any transport tagging (e.g. a worker's "[stderr] " prefix).
 */
export function parseMessageLine(line: string): ParsedMessage | null {
  const match = line.match(MESSAGE_RE);
  if (!match) return null;
  const severity = match[1] as ParsedSeverity;
  const code = match[2] as string;
  const rest = match[3] as string;

  let path: string | null = null;
  let lineNo: number | null = null;
  let column: number | null = null;
  let message = rest;

  const loc = rest.match(LOCATION_RE);
  if (loc) {
    path = loc[1] as string;
    lineNo = Number(loc[2]);
    column = Number(loc[3]);
    message = loc[4] as string;
  }

  return { severity, code, path, line: lineNo, column, message };
}

/**
 * Parse a run's console lines into structured messages plus the reported EPUB
 * version. Blank lines and non-message lines are ignored. Lines are trimmed
 * before matching; supply already-detagged lines (strip any "[stderr] " markers
 * first).
 */
export function parseEpubcheckLines(lines: string[]): ParsedOutput {
  const messages: ParsedMessage[] = [];
  let epubVersion: string | null = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    const version = parseEpubVersion(line);
    if (version !== null) {
      epubVersion = version;
      continue;
    }

    const parsed = parseMessageLine(line);
    if (parsed) messages.push(parsed);
  }

  return { messages, epubVersion };
}

// ============================================================================
// Higher-level console report -- the EpubCheckResult building blocks shared by
// `validate()` in Node (index.ts) and in the browser (validate-browser.ts). The
// result types themselves (Severity, MessageLocation, EpubCheckMessage,
// EpubCheckSummary, ...) live in result-types.js and are imported at the top of
// this file; their one public home is the main entry, not `epubcheck-standalone/parse`.
// ============================================================================

// SEVERITY(CODE): [ location(line,col): ] message -- same CODE grammar as
// MESSAGE_RE above (hyphen or underscore separator, optional lowercase
// suffix letter; see the note there).
const REPORT_MSG_RE = /^(FATAL|ERROR|WARNING|INFO|USAGE)\(([A-Z0-9]+[-_]\d+[a-z]?)\):\s*(.*)$/;
// "Messages: 0 fatals / 2 errors / 0 warnings / 0 infos"
const REPORT_SUMMARY_RE =
  /^Messages:\s*(\d+)\s+fatals?\s*\/\s*(\d+)\s+errors?\s*\/\s*(\d+)\s+warnings?\s*\/\s*(\d+)\s+infos?/;

/**
 * Parse ONE console line into the `EpubCheckMessage` shape, or null when the
 * line is not a `SEVERITY(CODE): ...` message line. This is the exact per-line
 * logic `parseConsoleReport` applies, exported separately so the live
 * per-message stream (the engine tap's console-line field) parses IDENTICALLY
 * to the post-run console text.
 */
export function parseReportMessageLine(line: string): EpubCheckMessage | null {
  const m = line.match(REPORT_MSG_RE);
  if (!m) return null;
  const severity = m[1] as Severity;
  const code = m[2] as string;
  let rest = m[3] as string;
  let location: MessageLocation | null = null;
  // Optional "path(line,col): message" location prefix.
  const loc = rest.match(/^(.*?)\((\d+),(\d+)\):\s*(.*)$/);
  if (loc) {
    location = { path: loc[1]!, line: +loc[2]!, column: +loc[3]! };
    rest = loc[4]!;
  }
  return { severity, code, location, message: rest };
}

/**
 * Parse a run's raw console text (stdout, or stdout + stderr) into the
 * `{ messages, summary }` an `EpubCheckResult` carries. The engine reports
 * message locations as `<name>/<entry>` directly, so no path rewriting is
 * needed. Lines that are not a `SEVERITY(CODE): ...` message (and are not the
 * summary line) are ignored.
 */
export function parseConsoleReport(
  text: string,
): { messages: EpubCheckMessage[]; summary: EpubCheckSummary | null } {
  const messages: EpubCheckMessage[] = [];
  let summary: EpubCheckSummary | null = null;
  for (const line of text.split('\n')) {
    const s = line.match(REPORT_SUMMARY_RE);
    if (s) {
      summary = { fatals: +s[1]!, errors: +s[2]!, warnings: +s[3]!, infos: +s[4]! };
      continue;
    }
    const message = parseReportMessageLine(line);
    if (message) messages.push(message);
  }
  return { messages, summary };
}
