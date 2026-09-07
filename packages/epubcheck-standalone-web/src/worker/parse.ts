// Thin demo adapter: turn the library's EpubCheckResult into the UI-facing
// ValidationResult the React component renders.
//
// The library (epubcheck-standalone/validate) now owns the whole run and returns the
// same structured EpubCheckResult the Node API returns: valid, exitCode,
// messages, summary, raw stdout/stderr, and the report-data tap. What stays here
// is only demo-specific presentation:
//   - a three-state verdict and per-severity counts for the stat tiles,
//   - the EPUB version banner. The worker runs in report mode, where the writers
//     replace the "Validating using EPUB version X" console banner, so the
//     version is read from the JSON report's publication block; parseEpubVersion
//     on the console lines stays as a fallback for a plain result,
//   - a raw output log assembled from stdout + stderr for the "show log" panel.
//     In report mode this is epubcheck's report-run console (its run summary and
//     "Check finished" line); the per-message lines live in the results table,
//   - the demo's timing/read-count stats, passed through from the worker.
//
// The results table and the report downloads read result.messages directly in
// the component, so this adapter does not reshape messages — the counts here are
// derived from that same report-tap set, so the tiles and the table agree.

import { parseEpubVersion } from "./vendor";
import type { EpubCheckResult } from "./vendor";
import type {
  Reports,
  SeverityCounts,
  ValidationResult,
  Verdict,
} from "./types";

export interface AssembleMeta {
  name: string;
  /** True for an expanded-EPUB directory run (validated in place), false otherwise. */
  isDirectory: boolean;
  sizeBytes: number;
  wallMs: number;
  /** epubcheck's own report output for the download buttons. */
  reports: Reports;
}

/** Split a raw captured stream into lines, dropping the single trailing blank. */
function toLines(text: string): string[] {
  if (text.length === 0) return [];
  return text.replace(/\n$/, "").split("\n");
}

/**
 * The EPUB version from a JSON report's `publication.ePubVersion`, as a string,
 * or null when the report is missing/unparseable or carries no version (e.g. a
 * container so broken it never reached version detection).
 */
function epubVersionFromJson(json: string | undefined): string | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as {
      publication?: { ePubVersion?: string | number | null };
    };
    const v = parsed.publication?.ePubVersion;
    if (v === null || v === undefined || v === "") return null;
    return String(v);
  } catch {
    return null;
  }
}

export function assembleValidationResult(
  result: EpubCheckResult,
  meta: AssembleMeta,
): ValidationResult {
  // Counts come from the report-tap message set — the exact rows the table
  // renders — so the stat tiles and the table always agree.
  const counts: SeverityCounts = {
    fatal: 0,
    error: 0,
    warning: 0,
    info: 0,
    usage: 0,
  };
  for (const m of result.messages) {
    if (m.severity === "FATAL") counts.fatal++;
    else if (m.severity === "ERROR") counts.error++;
    else if (m.severity === "WARNING") counts.warning++;
    else if (m.severity === "INFO") counts.info++;
    else if (m.severity === "USAGE") counts.usage++;
  }

  let verdict: Verdict = "valid";
  if (counts.fatal > 0 || counts.error > 0) verdict = "invalid";
  else if (counts.warning > 0) verdict = "warnings";

  const stdoutLines = toLines(result.stdout);
  const stderrLines = toLines(result.stderr);

  // The EPUB version epubcheck validated against. In report mode (how the worker
  // runs) the writers replace the "Validating using EPUB version X" console
  // banner, so read it from the JSON report's publication block; the console scan
  // stays as a fallback for a plain (non-report) result and is locale-proof here
  // because the JSON value is the bare number, not a localized sentence.
  let epubVersion: string | null = epubVersionFromJson(meta.reports.json);
  if (epubVersion === null) {
    for (const line of [...stdoutLines, ...stderrLines]) {
      const v = parseEpubVersion(line.trim());
      if (v !== null) {
        epubVersion = v;
        break;
      }
    }
  }

  // Raw output for the "show log" panel: stdout then stderr, stderr lines tagged
  // so the panel can tell the two streams apart (epubcheck writes its
  // ERROR/WARNING messages to stderr).
  const log = [...stdoutLines, ...stderrLines.map((l) => "[stderr] " + l)];

  return {
    verdict,
    epubVersion,
    counts,
    name: meta.name,
    isDirectory: meta.isDirectory,
    sizeBytes: meta.sizeBytes,
    wallMs: meta.wallMs,
    log,
    messages: result.messages,
    // Carried through so the console/CLI download can render its report on demand
    // (formatConsoleReport needs the full { messages, features } ReportData; the
    // engine only pre-produces the json/xml/xmp documents).
    features: result.features,
    reports: meta.reports,
  };
}
