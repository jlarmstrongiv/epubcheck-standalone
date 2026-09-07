// Structured, type-safe result of a validation run. The worker parses
// epubcheck's output into these shapes so React never touches raw log lines.

import type { ReportMessage, ReportFeature } from "./vendor";

export type { ReportMessage, ReportFeature };

/** epubcheck's own JSON/XML/XMP report output for the download buttons. */
export interface Reports {
  json?: string;
  xml?: string;
  xmp?: string;
}

export type Severity = "FATAL" | "ERROR" | "WARNING" | "INFO" | "USAGE";

export type Verdict = "valid" | "warnings" | "invalid";

export interface SeverityCounts {
  fatal: number;
  error: number;
  warning: number;
  info: number;
  usage: number;
}

export interface ValidationResult {
  /** Overall verdict derived from the message severities. */
  verdict: Verdict;
  /** e.g. "3.3" — the EPUB version epubcheck validated against, if reported. */
  epubVersion: string | null;
  counts: SeverityCounts;
  /** Input file name, or the folder name for an expanded EPUB directory run. */
  name: string;
  /**
   * True when this run validated an expanded (unzipped) EPUB directory
   * (validated in place, epubcheck's directory input with no `--mode`), false
   * for a single File / whole-container run.
   * Drives the folder/expanded-EPUB verdict wording.
   */
  isDirectory: boolean;
  /** Input file size in bytes (the summed size of every file for a directory). */
  sizeBytes: number;
  /** Wall-clock milliseconds for the whole validation. */
  wallMs: number;
  /** Raw epubcheck stdout/stderr lines, for the "show log" affordance. */
  log: string[];
  /** The parsed checker messages, for the results table. */
  messages: ReportMessage[];
  /**
   * The run's feature/info events (publication/item metadata, sizes, checksums,
   * fonts, references). Together with `messages` this makes the result a
   * `ReportData`, so the console/CLI download can render its report on demand via
   * `formatConsoleReport` (the engine pre-produces only json/xml/xmp).
   */
  features: ReportFeature[];
  /**
   * epubcheck's own JSON/XML/XMP report output, produced by the engine's writers,
   * used by the download buttons.
   */
  reports: Reports;
}
