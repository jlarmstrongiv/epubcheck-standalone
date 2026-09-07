// The parity matrix: scenarios compared byte-for-byte between the real
// epubcheck 5.3.0 jar and this CLI. Each case runs from the fixtures directory
// with the given argv. Cases whose args contain the literal token "OUTFILE"
// write a report to a file (the token is replaced with a temp path, and the
// file's bytes are compared too).
//
// Fixtures (committed, copied from epubcheck's own CLI test corpus):
//   valid.epub    clean EPUB 3                    (0 errors / 0 warnings)
//   invalid.epub  3 errors + 1 warning + 2 usages (severity tester)
//   warning.epub  1 warning only
//   fatal.epub    missing package document        (fatal)
//   content.xhtml a standalone, valid XHTML content document (for --mode xhtml)
//   acc.xhtml     an empty anchor -> ACC-004 (default severity SUPPRESSED)
//   cm-*.txt      -c/--customMessages override files (committed alongside)
export const CASES = [
  // --- core validation, default flags ---
  { name: "valid-default", args: ["valid.epub"] },
  { name: "invalid-default", args: ["invalid.epub"] },
  { name: "warning-default", args: ["warning.epub"] },
  { name: "fatal-default", args: ["fatal.epub"] },
  // empty.epub is a bare end-of-central-directory record (a zero-entry zip):
  // the jar reports PKG-003 + RSC-002 on it (parity-audit Gap D).
  { name: "empty-zip-default", args: ["empty.epub"] },

  // --- severity overrides ---
  { name: "invalid-quiet", args: ["-q", "invalid.epub"] },
  { name: "invalid-quiet-long", args: ["--quiet", "invalid.epub"] },
  { name: "invalid-error", args: ["-e", "invalid.epub"] },
  { name: "invalid-warn", args: ["-w", "invalid.epub"] },
  { name: "invalid-fatal", args: ["-f", "invalid.epub"] },
  { name: "invalid-info", args: ["-i", "invalid.epub"] },

  // --- failonwarnings (exit-code behavior) ---
  { name: "warning-failon", args: ["--failonwarnings", "warning.epub"] },
  { name: "valid-failon", args: ["--failonwarnings", "valid.epub"] },
  { name: "invalid-failon", args: ["--failonwarnings", "invalid.epub"] },

  // --- reports to stdout (console) ---
  { name: "invalid-json-stdout", args: ["--json", "-", "invalid.epub"] },
  { name: "invalid-xml-stdout", args: ["--out", "-", "invalid.epub"] },
  { name: "invalid-xmp-stdout", args: ["--xmp", "-", "invalid.epub"] },
  { name: "valid-json-stdout", args: ["-j", "-", "valid.epub"] },

  // --- reports to file ---
  { name: "invalid-json-file", args: ["--json", "OUTFILE", "invalid.epub"], outExt: "json" },
  { name: "invalid-xml-file", args: ["--out", "OUTFILE", "invalid.epub"], outExt: "xml" },
  { name: "invalid-xmp-file", args: ["--xmp", "OUTFILE", "invalid.epub"], outExt: "xmp" },
  { name: "valid-json-file", args: ["-j", "OUTFILE", "valid.epub"], outExt: "json" },
  { name: "valid-xml-file", args: ["-o", "OUTFILE", "valid.epub"], outExt: "xml" },

  // --- help / version ---
  { name: "help", args: ["--help"] },
  { name: "help-short", args: ["-h"] },
  { name: "help-q", args: ["-?"] },
  { name: "version", args: ["--version"] },
  { name: "version-dash", args: ["-version"] },
  { name: "help-with-path", args: ["--help", "valid.epub"] },
  { name: "version-with-path", args: ["--version", "valid.epub"] },

  // --- argument / usage errors ---
  { name: "no-args", args: [] },
  { name: "bad-flag", args: ["--bogus", "valid.epub"] },
  { name: "missing-file", args: ["does-not-exist.epub"] },
  { name: "two-positionals", args: ["valid.epub", "extra.epub"] },
  { name: "output-conflict", args: ["--json", "-", "--out", "-", "valid.epub"] },

  // --- profile: default and invalid (both -> default) ---
  { name: "profile-default", args: ["--profile", "default", "valid.epub"] },
  { name: "profile-invalid", args: ["--profile", "bogusprofile", "valid.epub"] },

  // --- listChecks (embedded dictionary) ---
  { name: "listchecks-stdout", args: ["--listChecks"] },
  { name: "listchecks-file", args: ["--listChecks", "OUTFILE"], outExt: "txt" },

  // --- .epub + mode/version -> mode_version_ignored, then normal validation ---
  { name: "epub-mode-opf", args: ["--mode", "opf", "valid.epub"] },
  { name: "epub-v2", args: ["-v", "2.0", "valid.epub"] },

  // --- newly unlocked flags (passed straight through to the engine) ---
  // -u surfaces USAGE-severity messages (stdout) and the "usages" counter.
  { name: "usage", args: ["-u", "invalid.epub"] },
  { name: "usage-valid", args: ["-u", "valid.epub"] },
  // A non-default validation profile: EDUPUB adds requirements a plain EPUB lacks.
  { name: "profile-edupub", args: ["--profile", "edupub", "valid.epub"] },
  // Single-file validation of a standalone content document.
  { name: "mode-xhtml", args: ["--mode", "xhtml", "-v", "3.0", "content.xhtml"] },
  // Localized message text + localized framework strings (validating line, tail,
  // counters, footer), on both an erroring and a clean book.
  { name: "locale-fr", args: ["--locale", "fr", "invalid.epub"] },
  { name: "locale-ja", args: ["--locale", "ja", "invalid.epub"] },
  { name: "locale-fr-valid", args: ["--locale", "fr", "valid.epub"] },

  // --- locale fallback (M1): region-qualified tags of shipped languages ---
  // A region subtag resolves to the bare-language bundle through the tag's OWN
  // ResourceBundle candidate chain (region -> language), independent of the host
  // default locale, so these are supported and byte-identical to the jar. en-US
  // and en-GB fall back to English; the others to their language bundle. ko-KR is
  // the exact region-only shipped bundle (no bare `ko` bundle exists).
  { name: "locale-en-US-invalid", args: ["--locale", "en-US", "invalid.epub"] },
  { name: "locale-en-GB-invalid", args: ["--locale", "en-GB", "invalid.epub"] },
  { name: "locale-fr-FR-invalid", args: ["--locale", "fr-FR", "invalid.epub"] },
  { name: "locale-de-DE-invalid", args: ["--locale", "de-DE", "invalid.epub"] },
  { name: "locale-ja-JP-invalid", args: ["--locale", "ja-JP", "invalid.epub"] },
  { name: "locale-ko-KR-invalid", args: ["--locale", "ko-KR", "invalid.epub"] },
  { name: "locale-de-DE-valid", args: ["--locale", "de-DE", "valid.epub"] },

  // --- listChecks localization (M2): the Message/Suggestion columns localize ---
  // to the resolved bundle; ID/Severity stay locale-invariant. The listChecks path
  // NEVER validates/refuses the locale (an unshipped tag just falls back to
  // English, exit 0), so it runs before the unsupported-locale gate -- matching
  // the jar. en-US and pl both fall back to the English dump.
  { name: "listchecks-de", args: ["--listChecks", "--locale", "de"] },
  { name: "listchecks-ja", args: ["--listChecks", "--locale", "ja"] },
  { name: "listchecks-fr-FR", args: ["--listChecks", "--locale", "fr-FR"] },
  { name: "listchecks-ko-KR", args: ["--listChecks", "--locale", "ko-KR"] },
  { name: "listchecks-en-US", args: ["--listChecks", "--locale", "en-US"] },
  { name: "listchecks-pl", args: ["--listChecks", "--locale", "pl"] },
  // listChecks to FILE with a locale: localized dictionary in the file AND the
  // localized completion summary on stdout (the to-file path prints the summary).
  { name: "listchecks-de-file", args: ["--listChecks", "OUTFILE", "--locale", "de"], outExt: "txt" },

  // --- -o/-j/-x auto-derive with no input path (M3): the jar NPEs internally ---
  // (`new File((String)null)`) and run() swallows it -> exit 1, EMPTY stdout AND
  // stderr. The positional (if any) is seen only later in the loop, so even
  // `-o -q invalid.epub` NPEs at the `-o`.
  { name: "out-no-path", args: ["-o"] },
  { name: "out-quiet-no-path", args: ["-o", "-q"] },
  { name: "json-no-path", args: ["-j"] },
  { name: "json-then-xmp-no-path", args: ["-j", "-x"] },
  { name: "out-quiet-then-path", args: ["-o", "-q", "invalid.epub"] },

  // --- customMessages (-c / --customMessages), against committed override files ---
  // promote: ACC-004 (default severity SUPPRESSED) raised to WARNING on an empty
  // anchor -- the flag's killer use, a suppressed check made visible.
  { name: "cm-promote", args: ["-c", "cm-promote.txt", "--mode", "xhtml", "-v", "3.0", "acc.xhtml"] },
  // suppress: every error on invalid.epub suppressed, so the exit code flips 1 -> 0
  // (only a warning remains).
  { name: "cm-suppress", args: ["-c", "cm-suppress.txt", "invalid.epub"] },
  // reword: a custom message string with %1$s parameters (NCX-001).
  { name: "cm-reword", args: ["-c", "cm-reword.txt", "invalid.epub"] },
  // missing override file -> CHK-001 (the name is deliberately absent from fixtures,
  // so the flag rides through untouched and the engine reports CHK-001 like the jar).
  { name: "cm-missing", args: ["-c", "cm-missing.txt", "invalid.epub"] },
];
