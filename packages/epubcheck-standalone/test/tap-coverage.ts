#!/usr/bin/env node
// Tap-coverage regression suite: the structured results must never silently
// carry FEWER messages than the engine's own console summary says exist.
//
//   node test/tap-coverage.ts
//
// Guarded bug class (parity-audit Gap A, fixed 2026-09-06): the console-line
// parser's message-code regex only accepted "XXX-nnn" spellings, so every
// message whose MessageId prints with an underscore (HTM_056, MED_017, ...)
// or a lowercase suffix letter (RSC-007w, ...) was dropped -- while the raw
// console output and exit code stayed byte-identical to the jar, so nothing
// else caught it. This suite pins the 14 corpus books that exposed the hole
// (every underscore/suffix-letter cluster: fixed-layout viewport HTM_056/057,
// media-overlays MED_*, foreign XHTML picture, package-link RSC-007w) plus a
// handful of healthy books, and asserts for each:
//   - per-severity `result.messages` counts EQUAL the "Messages:" summary line's
//     fatal/error/warning/info counts (the engine's own counters) -- the check
//     that keeps the tap-sourced messages and the console summary consistent;
//   - the tap-sourced `result.messages` agree with the console-parsed messages
//     in count, severity, order, and id (the tap and the console come from the
//     same reporting-level-filtered code path, so they must never diverge);
//   - onMessage fired exactly once per message, with the SAME ReportMessage
//     object that lands in result.messages (live stream IS result.messages).
// Jar-free and warm-engine fast, so it runs in the npm test battery.

import { validate } from '../dist/index.js';
import { fs } from '../dist/plugins.js';
import { parseConsoleReport } from '../dist/parse.js';
import type { ReportMessage } from '../dist/formatters/index.js';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, 'corpus', 'epubcheck-expanded');

// The 14 books the tap hole dropped messages on (parity-audit appendix).
const GAP_A_BOOKS = [
  'epub3__03-resources__files__foreign-xhtml-picture-source-no-type-error.epub',
  'epub3__05-package-document__files__package-link-missing-resource-error.epub',
  'epub3__08-layout__files__content-fxl-xhtml-viewport-duplicate-width-height-error.epub',
  'epub3__08-layout__files__content-fxl-xhtml-viewport-height-empty-error.epub',
  'epub3__08-layout__files__content-fxl-xhtml-viewport-height-missing-error.epub',
  'epub3__08-layout__files__content-fxl-xhtml-viewport-icb-missing-in-first-meta-error.epub',
  'epub3__08-layout__files__content-fxl-xhtml-viewport-units-invalid-error.epub',
  'epub3__08-layout__files__content-fxl-xhtml-viewport-width-missing-error.epub',
  'epub3__09-media-overlays__files__mediaoverlays-incorrect-overlay-ref-error.epub',
  'epub3__09-media-overlays__files__mediaoverlays-missing-mo-attr-error.epub',
  'epub3__09-media-overlays__files__mediaoverlays-multiple-overlay-ref-error.epub',
  'epub3__09-media-overlays__files__mediaoverlays-no-overlay-ref-error.epub',
  'epub3__09-media-overlays__files__mediaoverlays-textref-fragment-schemebased-warning.epub',
  'epub3__09-media-overlays__files__mediaoverlays-textref-svg-fragment-invalid-warning.epub',
];

// Healthy company: books with ordinary hyphen-spelled messages (and one clean
// book), so the count identity is proven on the common path too.
const HEALTHY_BOOKS = [
  'cli__files__20-severity-tester.epub',
  'cli__files__20-warning-tester.epub',
  'cli__files__30-valid-test.epub',
  'epub3__00-minimal__files__minimal.epub',
  'epub-dictionaries__files__epub__dictionary-content-model-error.epub',
];

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail: string): void {
  if (ok) {
    pass++;
  } else {
    fail++;
    failures.push(`${name}: ${detail}`);
  }
}

for (const book of [...GAP_A_BOOKS, ...HEALTHY_BOOKS]) {
  const path = join(fixtures, book);
  const live: ReportMessage[] = [];
  const r = await validate(await fs(path), { onMessage: (m) => live.push(m) });

  check(book, r.summary !== null, 'no "Messages:" summary line parsed');
  if (r.summary === null) continue;

  const bySev = (sev: string): number => r.messages.filter((m) => m.severity === sev).length;
  const got = {
    fatals: bySev('FATAL'),
    errors: bySev('ERROR'),
    warnings: bySev('WARNING'),
    infos: bySev('INFO'),
  };
  check(
    book,
    got.fatals === r.summary.fatals &&
      got.errors === r.summary.errors &&
      got.warnings === r.summary.warnings &&
      got.infos === r.summary.infos,
    `structured counts ${JSON.stringify(got)} != summary ${JSON.stringify(r.summary)}` +
      ' (the console said more messages exist than the parser delivered)',
  );
  // The tap-sourced result.messages must agree with the console-parsed messages
  // in count, severity, order, and id: both come from the SAME
  // reporting-level-filtered code path (DefaultReportImpl.message), so a
  // divergence here would mean the two views of the run had drifted.
  const console = parseConsoleReport(r.stdout + '\n' + r.stderr);
  check(
    book,
    console.messages.length === r.messages.length,
    `tap messages (${r.messages.length}) != console messages (${console.messages.length})`,
  );
  const tapKeys = r.messages.map((m) => `${m.severity}:${m.id}`);
  const consoleKeys = console.messages.map((m) => `${m.severity}:${m.code}`);
  check(
    book,
    JSON.stringify(tapKeys) === JSON.stringify(consoleKeys),
    `tap severity/id order != console order`,
  );
  check(
    book,
    live.length === r.messages.length && live.every((m, i) => m === r.messages[i]),
    `live onMessage stream (${live.length}) != result.messages (${r.messages.length})`,
  );
}

// The 14 pinned books must keep existing in the corpus (a rename would
// silently drop the regression coverage).
const present = new Set(readdirSync(fixtures));
for (const book of [...GAP_A_BOOKS, ...HEALTHY_BOOKS]) {
  check(book, present.has(book), 'book missing from test/corpus/epubcheck-expanded');
}

console.log(`tap-coverage: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  for (const f of failures) console.error('  FAIL ' + f);
  process.exit(1);
}
