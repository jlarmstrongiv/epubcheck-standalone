// Shared normalization for parity comparisons.
//
// epubcheck's report documents embed a few genuinely run-varying fields. These
// are the ONLY things normalized before comparing the CLI's output to the real
// tool -- every other byte must match exactly. Console (non-report) output has
// none of these, so this pass leaves it untouched.
//
// Normalized fields (each tied to its epubcheck source):
//   JSON  "checkDate"                 -> checker.checkDate     (wall clock at run start)
//   JSON  "elapsedTime"               -> checker.elapsedTime   (validation duration, ms)
//   XML   <date>                      -> report generation timestamp
//   XML   <created> / <lastModified>  -> the EPUB file's mtime (filesystem-dependent)
//   XMP   premis:hasEventDateTime     -> report generation timestamp
export function normalizeReport(text: string): string {
  if (typeof text !== "string") return text;
  return text
    // JSON quirk (documented in epubcheck-standalone/formatters): native epubcheck
    // flips the field ORDER of locations[].url {opaque, hierarchical} between
    // JVM runs (Jackson introspection order is unspecified). The values are
    // deterministic; only their order varies. Canonicalize the order (keeping
    // the values) so a jar run and the formatter's fixed opaque-first output
    // compare equal.
    .replace(
      /"url"\s*:\s*\{\s*"opaque"\s*:\s*(true|false)\s*,\s*"hierarchical"\s*:\s*(true|false)\s*\}/g,
      '"url":{"opaque":$1,"hierarchical":$2}',
    )
    .replace(
      /"url"\s*:\s*\{\s*"hierarchical"\s*:\s*(true|false)\s*,\s*"opaque"\s*:\s*(true|false)\s*\}/g,
      '"url":{"opaque":$2,"hierarchical":$1}',
    )
    .replace(/"checkDate"\s*:\s*"[^"]*"/g, '"checkDate":"<NORM>"')
    .replace(/"elapsedTime"\s*:\s*\d+/g, '"elapsedTime":<NORM>')
    .replace(/<date>[^<]*<\/date>/g, "<date><NORM></date>")
    .replace(/<created>[^<]*<\/created>/g, "<created><NORM></created>")
    .replace(/<lastModified>[^<]*<\/lastModified>/g, "<lastModified><NORM></lastModified>")
    .replace(
      /(<premis:hasEventDateTime[^>]*>)[^<]*(<\/premis:hasEventDateTime>)/g,
      "$1<NORM>$2",
    );
}
