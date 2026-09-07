#!/usr/bin/env node
// Regenerates the committed src/locale-messages.ts from the REAL epubcheck jar's
// own resource bundles, so an epubcheck upgrade regenerates the localized
// framework strings instead of anyone hand-editing them:
//
//   src/locale-messages.ts <- com/adobe/epubcheck/util/messages_<locale>.properties
//
//   npm run generate:locale-messages
//
// The CLI reconstructs epubcheck's console text from the engine's report tap. The
// message text itself arrives already localized from the tap, but the strings the
// CLI formats on its own (the "Messages: ..." counters, the "Validating using ..."
// line, the finished-with lines, and the completion footer) live here in
// messages.ts and default to English. To keep a --locale run byte-identical to the
// jar, those strings must be localized too; this script lifts them verbatim from
// the jar's bundles for the locales whose data the engine image ships.
//
// The jar is located by scripts/epubcheck-jar.ts (env/glob, never hardcoded); its
// property entries are extracted with `unzip` (the jar is a zip). Only keys the
// CLI actually formats (the ones in messages.ts's M) are kept, and only where the
// localized value differs from English -- every other key falls back to English.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveJarPath } from "./epubcheck-jar.ts";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..", "src");
const jar = resolveJarPath();

// Shipped tag -> the bundle basename epubcheck resolves it to. English is the
// default bundle (messages.properties) and carries no override entry.
const LOCALES: Record<string, string> = {
  da: "messages_da.properties",
  de: "messages_de.properties",
  es: "messages_es.properties",
  fr: "messages_fr.properties",
  it: "messages_it.properties",
  ja: "messages_ja.properties",
  "ko-KR": "messages_ko_KR.properties",
  nl: "messages_nl.properties",
  "pt-BR": "messages_pt_BR.properties",
  "zh-TW": "messages_zh_TW.properties",
};

// The keys the CLI formats itself (kept in sync with messages.ts's M). Anything
// not listed here comes localized straight from the tap, so it needs no bundle.
const KEYS = [
  "no_errors__or_warnings", "there_were_errors",
  "there_were_warnings", "messages", "counter_fatal_zero", "counter_fatal_one", "counter_fatal_many",
  "counter_error_zero", "counter_error_one", "counter_error_many", "counter_warn_zero", "counter_warn_one",
  "counter_warn_many", "counter_info_zero", "counter_info_one", "counter_info_many", "counter_usage_zero",
  "counter_usage_one", "counter_usage_many", "display_help", "argument_needed",
  "no_file_specified",
  "mode_version_ignored", "mode_required", "validating_version_message", "output_type_conflict",
  "file_not_found", "directory_not_found", "deleting_archive", "epubcheck_completed", "error_creating_config_file",
  "expected_message_filename", "unrecognized_argument", "epubcheck_version_text", "incorrect_locale", "missing_locale",
];

/** Minimal java.util.Properties parser for the UTF-8 bundles: handles line
 *  continuations and the \n \t \r \f \\ \: \= \uXXXX escapes. */
function parseProps(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i] as string;
    const trimmed = line.replace(/^\s+/, "");
    if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith("!")) continue;
    while (/(^|[^\\])(\\\\)*\\$/.test(line)) {
      line = line.replace(/\\$/, "") + ((lines[++i] ?? "") as string).replace(/^\s+/, "");
    }
    const m = line.match(/^\s*([^=:\s]+)\s*[=:]\s*(.*)$/);
    if (m) out[m[1] as string] = unescapeProp(m[2] as string);
  }
  return out;
}

function unescapeProp(s: string): string {
  let r = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i] as string;
    if (c !== "\\") { r += c; continue; }
    const n = s[++i] as string;
    if (n === "n") r += "\n";
    else if (n === "t") r += "\t";
    else if (n === "r") r += "\r";
    else if (n === "f") r += "\f";
    else if (n === "u") { r += String.fromCharCode(parseInt(s.slice(i + 1, i + 5), 16)); i += 4; }
    else r += n;
  }
  return r;
}

const tmp = mkdtempSync(join(tmpdir(), "ecw-locale-"));
try {
  const unzip = spawnSync(
    "unzip",
    ["-o", "-j", jar, "com/adobe/epubcheck/util/messages*.properties", "-d", tmp],
    { encoding: "utf8" },
  );
  if (unzip.status !== 0) {
    console.error(`Could not extract locale bundles from ${jar} with unzip.\n${unzip.stderr ?? ""}`);
    process.exit(1);
  }

  const en = parseProps(readFileSync(join(tmp, "messages.properties"), "utf8"));
  const table: Record<string, Record<string, string>> = {};
  for (const [tag, fname] of Object.entries(LOCALES)) {
    const p = parseProps(readFileSync(join(tmp, fname), "utf8"));
    const over: Record<string, string> = {};
    for (const k of KEYS) {
      if (p[k] !== undefined && p[k] !== en[k]) over[k] = p[k] as string;
    }
    table[tag] = over;
  }

  const body = `// AUTO-GENERATED. Do not edit by hand.
// Localized epubcheck framework strings, extracted verbatim from the
// engine's own resource bundles (com/adobe/epubcheck/util/messages_<locale>.properties
// inside epubcheck.jar), for the locales whose data the epubcheck-standalone image ships.
// Only keys whose value differs from the English default are listed; every other
// key falls back to the English string in messages.ts at lookup time. These are
// the strings the CLI formats itself (summary counters, the validating line, the
// completion footer, the finished-with-errors and no-errors lines); message text
// comes localized from the engine tap.
// Regenerate with: npm run generate:locale-messages
import type { MessageKey } from "./messages.js";

export type LocaleOverride = Partial<Record<MessageKey, string>>;

export const LOCALE_MESSAGES: Record<string, LocaleOverride> = ${JSON.stringify(table, null, 2)};
`;

  const outPath = join(srcDir, "locale-messages.ts");
  writeFileSync(outPath, body);
  for (const tag of Object.keys(table)) {
    console.log(`  ${tag}: ${Object.keys(table[tag] as object).length} localized strings`);
  }
  console.log(`\nWrote ${outPath}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
