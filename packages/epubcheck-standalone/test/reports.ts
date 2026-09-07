#!/usr/bin/env node
// Report byte-parity suite: for every ground-truth report committed under
// test/expected-reports/<corpus>/<book>.epub.{json,xml,xmp}, validate the book
// ONCE through the library with `reports: ['json','xml','xmp']` (ONE engine
// run: the engine's live message tap streams the report events out and the
// formatters render all three documents from that stream) and compare each
// output to the jar ground truth.
//
//   node test/reports.ts                default: ~50 stable-sampled books
//   PARITY=full node test/reports.ts    every book with committed ground truth
//   PARITY=120 node test/reports.ts     ~120 stable-sampled books
//
// The report cache covers ALL 446 committed books (rebuilt from the jar by
// npm run test:reports:generate -> testing/report-groundtruth.ts). The PARITY
// dial (test/sample.ts, the SAME dial + stable sample the console runner uses)
// picks how many the everyday run checks; `full` checks them all.
//
// The ground truth was generated with the real epubcheck.jar (host-local TZ,
// en-US locale, cwd=<book dir>, arg=<book name>); the library defaults to the
// host TZ and the bare relative input name, so the report "path"/timestamp
// fields line up. Masked on both sides (run-varying even between two native
// runs): the JSON checkDate/elapsedTime, the XML <date>, the XMP
// premis:hasEventDateTime, and the per-run random base-URL UUID. JSON is
// compared STRUCTURALLY (parse, deep-sort keys, re-serialize) because member
// order is unspecified Jackson introspection order and differs legitimately
// between the JVM and TeaVM; every VALUE is still strictly compared.

import { validatePool } from './validate-pool.ts';
import { parseDial, inSample } from './sample.ts';
import type { EpubCheckResult } from '../dist/index.js';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const expectedRoot = join(here, 'expected-reports');
const corpusRoot = join(here, 'corpus');
const CONCURRENCY = Number(process.env.CONCURRENCY || 6);
const dial = parseDial();

const canonUuid = (text: string): string => text.replaceAll(
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\.epubcheck\.w3c\.org)/g,
  'UUID',
);
// JSON member ORDER is unspecified Jackson introspection order; compare
// structurally so every value is checked but order differences are ignored.
const deepSort = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(deepSort);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) {
      out[k] = deepSort((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
};
const canonJson = (text: string): string => {
  const masked = canonUuid(text)
    .replace(/"checkDate" : "[^"]*"/, '"checkDate" : "DATE"')
    .replace(/"elapsedTime" : -?\d+/, '"elapsedTime" : 0');
  return JSON.stringify(deepSort(JSON.parse(masked)), null, 2);
};
const canonXml = (text: string): string => canonUuid(text)
  .replace(/<date>[^<]*<\/date>/, '<date>DATE</date>');
const canonXmp = (text: string): string => canonUuid(text)
  .replace(/(<premis:hasEventDateTime[^>]*>)[^<]*(<\/premis:hasEventDateTime>)/, '$1DATE$2');

// Collect the books that have committed ground truth, then narrow to the stable
// dial sample (same key "<group>/<file>" the console runner uses, so both suites
// check the SAME set of books at a given PARITY setting).
const allBooks: { sub: string; book: string }[] = [];
for (const sub of readdirSync(expectedRoot).sort()) {
  const dir = join(expectedRoot, sub);
  if (!statSync(dir).isDirectory()) continue;
  const names = new Set(readdirSync(dir).map((f) => f.replace(/\.(json|xml|xmp)$/, '')));
  for (const book of [...names].sort()) allBooks.push({ sub, book });
}
const books = allBooks.filter((b) => inSample(`${b.sub}/${b.book}`, dial));
console.error(`[reports] dial PARITY=${dial.label}: ${books.length}/${allBooks.length} books`);

let pass = 0;
let fail = 0;
const failures: string[] = [];

const present: { sub: string; book: string }[] = [];
for (const b of books) {
  if (existsSync(join(corpusRoot, b.sub, b.book))) present.push(b);
  else {
    fail++;
    failures.push(`${b.sub}/${b.book}: epub missing from test/corpus`);
  }
}

const results = await validatePool(
  present.map((b) => ({ path: join(corpusRoot, b.sub, b.book), reports: ['json', 'xml', 'xmp'] as Array<'json' | 'xml' | 'xmp'> })),
  CONCURRENCY,
);

function compareBook({ sub, book }: { sub: string; book: string }, r: EpubCheckResult): void {
  const base = join(expectedRoot, sub, book);
  const reports = r.reports ?? {};
  const sides: [string, string | undefined, string, (s: string) => string][] = [
    ['json', reports.json, `${base}.json`, canonJson],
    ['xml', reports.xml, `${base}.xml`, canonXml],
    ['xmp', reports.xmp, `${base}.xmp`, canonXmp],
  ];
  for (const [ext, oursRaw, gtPath, canon] of sides) {
    // Guard the golden read: an incomplete ground-truth triple (a missing or
    // unreadable format file) must be a counted failure, not a raw stack trace
    // that aborts the whole suite mid-run.
    let gt: string;
    try {
      gt = canon(readFileSync(gtPath, 'utf8'));
    } catch (e) {
      fail++;
      failures.push(`${sub}/${book} [${ext}] ground-truth missing or unreadable: ${gtPath} (${e})`);
      continue;
    }
    if (oursRaw === undefined) {
      fail++;
      failures.push(`${sub}/${book} [${ext}] not produced`);
      continue;
    }
    let ours: string;
    try {
      ours = canon(oursRaw);
    } catch (e) {
      fail++;
      failures.push(`${sub}/${book} [${ext}] output not canonicalizable (${e})`);
      continue;
    }
    if (ours === gt) {
      pass++;
      continue;
    }
    fail++;
    const la = ours.split('\n');
    const lb = gt.split('\n');
    let k = 0;
    while (la[k] === lb[k]) k++;
    failures.push(`${sub}/${book} [${ext}] first diff at line ${k + 1}:\n` +
      `    expected: ${lb[k]}\n    got:      ${la[k]}`);
  }
}

for (let i = 0; i < present.length; i++) compareBook(present[i]!, results[i]!);

console.log(`REPORT TEST: ${pass}/${pass + fail} report files byte-identical ` +
  `(${books.length} books x 3 formats)`);
if (fail) {
  for (const f of failures) console.error('  ' + f);
  console.error('REPORT TEST FAILED');
  process.exit(1);
}
console.log('REPORT TEST PASSED');
// Exit explicitly so the printed verdict and the process exit code always agree:
// the pool SIGKILLs its child processes on teardown, and a stray async exit event
// from one of those kills must never flip a PASSED run to a non-zero code.
process.exit(0);
