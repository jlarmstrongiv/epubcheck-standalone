// UI locale support for the header language switcher, plus the one map from a UI
// locale to the engine's message-locale tag. Kept in one place so adding a UI
// locale is a single, mechanical step (drop in a catalog file).

import { locales, type Locale } from "../../paraglide/runtime.js";
import { LOCALES } from "./constants";

// Message catalogs that actually exist on disk (messages/<locale>.json). Vite's
// import.meta.glob is resolved at build time from the file names, so ADDING
// messages/<locale>.json automatically makes that locale a candidate here with
// no code change. Only the keys (paths) are used; the JSON is never imported.
const catalogModules = import.meta.glob("../../../messages/*.json");
const catalogLocales = new Set(
  Object.keys(catalogModules).map((path) =>
    path.slice(path.lastIndexOf("/") + 1).replace(/\.json$/, ""),
  ),
);

// The UI locales the switcher offers: the Paraglide-configured locales that also
// have a catalog on disk, kept in the runtime's locale order. Today only English
// has a catalog, so this is just ["en"]; it grows on its own as catalogs land.
export const UI_LOCALES: Locale[] = locales.filter((locale) =>
  catalogLocales.has(locale),
);

// The language's own name for itself (endonym), generated with Intl so a new
// catalog needs no hand-written label: "en" -> "English", "de" -> "Deutsch",
// "pt-BR" -> "Português (Brasil)", "zh-TW" -> "中文（繁體）". First letter is
// upper-cased for the locales whose endonym is conventionally lowercase.
export function localeLabel(locale: Locale): string {
  try {
    const name = new Intl.DisplayNames([locale], { type: "language" }).of(
      locale,
    );
    if (name) {
      return name.charAt(0).toLocaleUpperCase(locale) + name.slice(1);
    }
  } catch {
    /* Intl.DisplayNames unsupported for this tag: fall back to the raw tag. */
  }
  return locale;
}

// Map a UI locale (Paraglide, from messages/<locale>.json) to the engine's
// message-locale tag — the value used by the "Language" select in Advanced
// options, which carries the epubcheck jar's own tags. The two sets are
// identical EXCEPT that the jar spells Korean as the full "ko-KR" while the UI
// catalog uses the normalized "ko"; every other tag (including "pt-BR" and
// "zh-TW") is the same on both sides, and "en" is the engine's default. Anything
// not listed here falls through to the identity mapping below.
const UI_TO_ENGINE_OVERRIDES: Partial<Record<Locale, string>> = {
  ko: "ko-KR",
};

// Resolve the engine locale tag for a UI locale, or null when the engine select
// has no matching entry (in which case the caller leaves the select untouched).
export function uiToEngineLocale(uiLocale: Locale): string | null {
  const engineTag = UI_TO_ENGINE_OVERRIDES[uiLocale] ?? uiLocale;
  return LOCALES.some((option) => option.value === engineTag) ? engineTag : null;
}
