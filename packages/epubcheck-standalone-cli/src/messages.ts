// Verbatim message strings from epubcheck 5.3.0's default (English) resource
// bundle: src/main/resources/com/adobe/epubcheck/util/messages.properties.
// These are reproduced exactly so the CLI's console text is byte-identical to
// the real `epubcheck` tool. `%1$s`-style Java placeholders are rendered by the
// library's shared `formatTemplate` helper.
//
// The English baseline for the strings the console renderer formats (the
// validating line, the finished-with lines, the summary counters, the footer)
// is stated ONCE in the library's `DEFAULT_CONSOLE_LABELS` (the `ConsoleLabels`
// contract), so `M` below carries ONLY the CLI-specific strings that have no
// `ConsoleLabels` counterpart. A run's message table (`messagesFor`) merges the
// two -- `{ ...DEFAULT_CONSOLE_LABELS, ...M }` -- and layers any per-locale
// overrides on top, so the localized `ConsoleLabels` the CLI passes into the
// library render primitives is exactly `{ ...DEFAULT_CONSOLE_LABELS, ...overrides }`.

// The epubcheck upstream version is the library's single source of truth
// (derived there from its package.json version prefix); re-export it so CLI
// modules can keep importing it from here, with no hardcoded token.
export { EPUBCHECK_VERSION } from "epubcheck-standalone";
// The `%1$s`/`%1$d` positional substitution and the English console chrome
// strings both live in the library (one implementation); re-export the helper
// so CLI modules keep a single import site.
export { formatTemplate } from "epubcheck-standalone/formatters";
import { DEFAULT_CONSOLE_LABELS, type ConsoleLabels } from "epubcheck-standalone/formatters";

import { LOCALE_MESSAGES } from "./locale-messages.js";

// --- CLI-only strings (messages.properties keys with no ConsoleLabels
//     counterpart). The shared console chrome (no_errors__or_warnings,
//     there_were_*, messages, counter_*, validating_version_message,
//     epubcheck_completed) is NOT restated here -- it comes from the library's
//     DEFAULT_CONSOLE_LABELS (see messagesFor). ---
export const M = {
  display_help: "-help displays help",
  argument_needed: "At least one argument expected",
  no_file_specified: "No file specified in the arguments. Exiting.",
  mode_version_ignored:
    "The mode and version arguments are ignored for epubs. They are retrieved from the files.",
  mode_required: "Mode required for non-epub files. Default version is 3.0.",
  output_type_conflict: "Only one output format can be specified at a time.",
  file_not_found: 'File not found: "%1$s"',
  directory_not_found: 'Directory not found: "%1$s"',
  deleting_archive: "\nEpub creation cancelled due to detected errors.\n",
  error_creating_config_file: 'Error creating config file "%1$s".',
  expected_message_filename: 'Expected the Custom message file name, but found "%1$s"',
  unrecognized_argument: 'Unrecognized argument: "%1$s"',
  epubcheck_version_text: "EPUBCheck v%1$s",
  incorrect_locale: 'Argument "%1$s" to the --locale option is incorrect.',
  missing_locale: "Argument to the --locale option is missing.",
} as const;

/**
 * Every localizable key: the shared console-chrome keys (from `ConsoleLabels`,
 * whose English baseline is `DEFAULT_CONSOLE_LABELS`) plus the CLI-only keys in
 * `M`. This is the union a per-locale override table may key off of.
 */
export type MessageKey = keyof ConsoleLabels | keyof typeof M;

/** The full message table for a run: the shared `ConsoleLabels` chrome plus the
 *  CLI-only strings. Values are widened to `string` so a localized table (whose
 *  strings are not the English literals) is still assignable, and it structurally
 *  satisfies `ConsoleLabels` so it can be passed straight into the library render
 *  primitives. */
export type Messages = ConsoleLabels & { readonly [K in keyof typeof M]: string };

/**
 * The exact locale tags whose message bundles epubcheck ships (verified against
 * the jar: `messages_{da,de,en,es,fr,it,ja,ko_KR,nl,pt_BR,zh_TW}.properties` and
 * the matching `MessageBundle_*`). Canonical form: lowercase language, uppercase
 * region. Note `ko`, `pt`, and `zh` ship ONLY region-qualified (ko_KR/pt_BR/zh_TW),
 * so the bare language subtags of those are NOT here.
 */
export const SHIPPED_LOCALES: ReadonlySet<string> = new Set([
  "da", "de", "en", "es", "fr", "it", "ja", "ko-KR", "nl", "pt-BR", "zh-TW",
]);

/**
 * The BARE-LANGUAGE bundles epubcheck ships (`messages_<lang>.properties` with no
 * region). A region-qualified tag of one of these (e.g. `en-US`, `fr-FR`, `de-DE`)
 * resolves to the bare bundle through the TAG'S OWN Java ResourceBundle candidate
 * chain (language-region -> language -> ...), so its resolution is deterministic
 * regardless of the host's default locale. That is what makes those tags safe to
 * support with proven byte-identity. `ko`/`pt`/`zh` are absent on purpose: they
 * ship only region-qualified, so a bare `ko`/`pt`/`zh` (or any unshipped language
 * such as `pl`/`ru`) would fall through to Java's DEFAULT-LOCALE fallback, whose
 * result is host-dependent and therefore not provably byte-identical across hosts
 * -- the CLI keeps refusing those (see resolveLocale / unsupportedReason).
 */
export const SHIPPED_LANGUAGES: ReadonlySet<string> = new Set([
  "da", "de", "en", "es", "fr", "it", "ja", "nl",
]);

/**
 * Canonicalize a locale tag the way java.util.Locale.forLanguageTag would for our
 * shipped set: lowercase the language subtag, uppercase a two-letter region
 * subtag, join with a hyphen. e.g. "ko-kr" / "KO_KR" -> "ko-KR", "FR" -> "fr".
 */
export function canonicalizeLocale(tag: string): string {
  const parts = tag.split(/[-_]/);
  const lang = (parts[0] ?? "").toLowerCase();
  if (parts.length < 2) return lang;
  const region = (parts[1] as string).toUpperCase();
  return `${lang}-${region}`;
}

/**
 * The shipped locale key whose bundle epubcheck's ResourceBundle would resolve
 * `tag` to THROUGH THE TAG'S OWN candidate chain (region -> language), or "en" for
 * a tag that resolves to the English base that way, or null when resolution would
 * require Java's host-dependent default-locale fallback (which we cannot prove is
 * byte-identical to an arbitrary jar host, so the CLI refuses it).
 *
 * Deterministic, default-locale-independent, mirroring java.util.ResourceBundle:
 *   - an exact shipped tag (incl. ko-KR / pt-BR / zh-TW) -> itself;
 *   - a tag whose language is a shipped bare-language bundle -> that language
 *     (so en-US / fr-FR / de-DE / es-ES / it-IT / ja-JP / nl-NL / da-DK / en-GB
 *      all resolve to their bare bundle);
 *   - anything else -> null (refused).
 */
export function resolveLocale(tag: string): string | null {
  const canon = canonicalizeLocale(tag);
  if (SHIPPED_LOCALES.has(canon)) return canon;
  const lang = canon.split("-")[0] as string;
  if (SHIPPED_LANGUAGES.has(lang)) return lang;
  return null;
}

/**
 * The message table for a run: English by default, or English merged with the
 * localized overrides for a shipped non-English locale. Message text itself
 * arrives already localized from the engine tap; this only covers the strings the
 * CLI formats on its own (the summary counters, the validating line, the footer,
 * and the finished-with lines).
 */
export function messagesFor(localeTag: string | null): Messages {
  // The English baseline: the library's shared console chrome + the CLI-only
  // strings. Stated once here from DEFAULT_CONSOLE_LABELS (no echo in M).
  const base: Messages = { ...DEFAULT_CONSOLE_LABELS, ...M };
  if (localeTag === null) return base;
  // Look up the localized framework overrides under the SAME shipped key the tag
  // resolves to (so fr-FR uses the "fr" table, en-US falls back to English, etc.).
  // Overrides cover both the console-chrome keys and the CLI-only keys.
  const key = resolveLocale(localeTag);
  const over = key ? LOCALE_MESSAGES[key] : undefined;
  return over ? { ...base, ...over } : base;
}

/** Reporting levels, mirroring com.adobe.epubcheck.util.ReportingLevel. */
export const ReportingLevel = {
  Fatal: 5,
  Error: 4,
  Warning: 3,
  Info: 2,
  Usage: 1,
  Suppressed: 0,
} as const;
