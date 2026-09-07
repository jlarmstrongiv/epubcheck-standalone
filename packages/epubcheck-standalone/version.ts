// epubcheck-standalone -- the single source of truth for the bundled epubcheck version.
//
// The engine embeds a specific epubcheck release. Rather than hardcode that
// version string in several modules (index, formatters), we DERIVE it from this
// package's own `version` field: the package is published as
// `<epubcheckVersion>-build<N>` (e.g. "5.3.0-build1"), so the part before
// `-build` IS the epubcheck version. The release pipeline bumps package.json, so
// this constant updates itself -- no second place to edit.
//
// This module is environment-neutral (it only reads a JSON file, no Node
// built-ins), so it is safe to import from the browser-facing modules too.
//
// The package.json is imported through the package SELF-REFERENCE
// `epubcheck-standalone/package.json` (see exports), NOT a relative `./package.json`.
// This module is emitted into dist/, and a relative JSON import would make tsc
// COPY package.json into dist/ -- that stray dist/package.json would then shadow
// the real package scope and break every `epubcheck-standalone/*` self-reference at
// runtime (Node would resolve export targets relative to dist/, doubling it).
// The self-reference resolves to the one real package.json at compile time,
// runtime, and under the demo's bundler, and is never copied.

import pkg from 'epubcheck-standalone/package.json' with { type: 'json' };

/** epubcheck upstream version baked into the bundled engine (e.g. "5.3.0"). */
// String.prototype.split always returns a non-empty array, so [0] is always a
// string: the part before "-build", or the whole version when there is no
// "-build" suffix. No fallback is needed.
export const EPUBCHECK_VERSION: string = pkg.version.split('-build')[0]!;
