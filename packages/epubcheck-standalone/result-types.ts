// epubcheck-standalone -- the validate() result types (internal module, no
// public subpath of its own).
//
// These are the types `validate()` returns. Their ONE public home is the main
// entry (`epubcheck-standalone`): index.ts (Node) and validate-browser.ts
// (browser) re-export every type here, so a validate consumer imports them from
// the bare package. Other internal modules (parse.ts, run-core.ts,
// validate-core.ts) import them from here directly; none of them re-exports
// these types from its own public subpath, so each type stays importable from
// exactly one place.
//
// It imports the complete report-data types (ReportMessage / ReportFeature)
// type-only from the formatters module (their one public home is
// `epubcheck-standalone/formatters`); a type-only import is fully erased, so
// this module still has no runtime imports and loads cleanly in a browser
// Worker.

import type { ReportMessage, ReportFeature } from './formatters/index.js';

/**
 * Severity levels epubcheck emits on a validated run's result. USAGE is emitted
 * only under `-u`/`--usage`; it is parsed into messages (so consumers can count
 * or show it) but never appears on a default run.
 *
 * This is the CONSOLE reader's severity set (`epubcheck-standalone/parse`). The
 * result's own `messages` use `ReportSeverity` (from
 * `epubcheck-standalone/formatters`), a superset that also has `SUPPRESSED`.
 */
export type Severity = 'FATAL' | 'ERROR' | 'WARNING' | 'INFO' | 'USAGE';

/** Location of a message inside the EPUB, when epubcheck reports one. */
export interface MessageLocation {
  /** File path inside the EPUB, as reported by the engine. */
  path: string;
  line: number;
  column: number;
}

/**
 * A single message as the CONSOLE reader (`epubcheck-standalone/parse`)
 * tokenizes it from epubcheck's per-message console lines. This is NOT the
 * result's message shape: `validate()`'s `result.messages` are the complete
 * `ReportMessage`s (a content superset -- `code`->`id`, nested `location`->flat
 * `path`/`line`/`column`, plus `suggestion`/`context`/raw text). This narrower
 * form remains the return type of the console line readers only.
 */
export interface EpubCheckMessage {
  severity: Severity;
  /** epubcheck message code, e.g. "RSC-005". */
  code: string;
  /** Location, or null when the message is not tied to a position. */
  location: MessageLocation | null;
  /** Human-readable message text. */
  message: string;
}

/** Count summary from epubcheck's "Messages:" line. */
export interface EpubCheckSummary {
  fatals: number;
  errors: number;
  warnings: number;
  infos: number;
}

/** The report files epubcheck's own writers produced, when `reports` requested. */
export interface EpubCheckReports {
  json?: string;
  xml?: string;
  xmp?: string;
}

/**
 * Result of validating one EPUB. `validate()` returns this exact shape in Node
 * (index.ts) and in the browser (validate-browser.ts), so a consumer can move
 * between the two environments without reshaping anything.
 */
export interface EpubCheckResult {
  /** True when epubcheck exited 0 (no fatals or errors). */
  valid: boolean;
  /** Raw exit code (0 = clean, 1 = errors/fatals), or null when unavailable. */
  exitCode: number | null;
  /**
   * The COMPLETE checker-message list of this run, in emission order, sourced
   * from the engine's live report-event tap -- every field epubcheck's own
   * report writers see (raw text, `suggestion`, per-location `context`, flat
   * `path`/`line`/`column`, `id`). Populated on EVERY validation, plain or with
   * `reports`. Together with `features` this makes the result a `ReportData`, so
   * it can be handed straight to a formatter, or `{ messages, features }` can be
   * JSON-serialized and rehydrated to re-render any report later, losslessly.
   */
  messages: ReportMessage[];
  /**
   * Every feature/info event of the run (a `Report.info()` call) in emission
   * order -- publication/item metadata, sizes, checksums, fonts, references,
   * tool info. Streamed out live by the engine's message tap; the exact stream
   * epubcheck's own JSON/XML/XMP writers aggregate. Populated on EVERY run.
   */
  features: ReportFeature[];
  /** Parsed count summary, or null if the summary line was not found. */
  summary: EpubCheckSummary | null;
  /** Raw captured stdout. */
  stdout: string;
  /** Raw captured stderr. */
  stderr: string;
  /**
   * The JSON/XML/XMP report documents, present only when `reports` were
   * requested on the run. Rendered from this run's live report-event stream
   * (one single validation, no re-runs); byte-identical to what the stock
   * CLI's `--json`/`--out`/`--xmp` writers produce.
   */
  reports?: EpubCheckReports;
}
