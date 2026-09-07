#!/usr/bin/env node
// Formatter byte-parity suite via the SAVE -> REHYDRATE round-trip.
//
//   node test/formatters.ts                default: ~50 stable-sampled books
//   PARITY=full node test/formatters.ts    every book with committed ground truth
//
// For every ground-truth report committed under
// test/expected-reports/<corpus>/<book>.epub.{json,xml,xmp} (the same jar-
// derived goldens test/reports.ts checks the ENGINE's inline writers against),
// this suite proves the LOSSLESS re-render path a `validate()` consumer uses:
//
//   1. validate the book once (ONE plain engine run);
//   2. take the COMPLETE report data straight off the result -- { messages,
//      features } -- and JSON.stringify it, then JSON.parse it back (the "save
//      now, re-render later" round-trip: persist the data, reload it another
//      day, format any report from it);
//   3. feed the rehydrated data to formatJson/Xml/XmpReport;
//   4. byte-compare each output to the committed golden.
//
// Because the result already carries every field the writers need (raw text,
// suggestion, per-location context, the full feature-event stream in emission
// order), the round-trip is lossless and needs no reconstruction adapter and no
// golden-extracted supplements -- the machinery the retired formatters/adapter.ts
// required is gone.
//
// RUN-VARYING FIELDS are extracted from the ground truth and passed as formatter
// OPTIONS (they can never match between two runs, even two native ones): JSON
// checkDate + elapsedTime, XML <date>, XMP premis:hasEventDateTime. Normalized on
// BOTH sides: the per-run random base-URL UUID (https://<uuid>.epubcheck.w3c.org)
// and the JSON locations[].url field order (native epubcheck itself flips it
// between JVM runs). Goldens are never edited.

import { validatePool } from './validate-pool.ts';
import { parseDial, inSample } from './sample.ts';
import type { EpubCheckResult } from '../dist/index.js';
import {
  formatJsonReport,
  formatXmlReport,
  formatXmpReport,
} from '../dist/formatters/index.js';
import type { ReportData } from '../dist/formatters/index.js';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const expectedRoot = join(here, 'expected-reports');
const corpusRoot = join(here, 'corpus');
const CONCURRENCY = Number(process.env.CONCURRENCY || 6);
const dial = parseDial();

// --- canonicalization (both sides) ------------------------------------------

const canonUuid = (text: string): string => text.replaceAll(
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\.epubcheck\.w3c\.org)/g,
  'UUID',
);
const canonUrlOrder = (json: string): string => json.replaceAll(
  /"url" : \{\n(\s+)"hierarchical" : (true|false),\n\s+"opaque" : (true|false)\n(\s+)\}/g,
  '"url" : {\n$1"opaque" : $3,\n$1"hierarchical" : $2\n$4}',
);
const canonJson = (t: string): string => canonUuid(canonUrlOrder(t));
const canonXml = canonUuid;

// --- run-varying golden field extraction ------------------------------------

const extract = (text: string, re: RegExp, what: string, file: string): string => {
  const m = text.match(re);
  if (!m) throw new Error(`cannot extract ${what} from ${file}`);
  return m[1]!;
};

// --- book discovery (same walk + stable dial sample as test/reports.ts) ------

const allBooks: { sub: string; book: string }[] = [];
for (const sub of readdirSync(expectedRoot).sort()) {
  const dir = join(expectedRoot, sub);
  if (!statSync(dir).isDirectory()) continue;
  const names = new Set(readdirSync(dir).map((f) => f.replace(/\.(json|xml|xmp)$/, '')));
  for (const book of [...names].sort()) allBooks.push({ sub, book });
}
const books = allBooks.filter((b) => inSample(`${b.sub}/${b.book}`, dial));
console.error(`[formatters] dial PARITY=${dial.label}: ${books.length}/${allBooks.length} books`);

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

// One plain run per book: the result carries the complete { messages, features }.
const results = await validatePool(
  present.map((b) => ({ path: join(corpusRoot, b.sub, b.book) })),
  CONCURRENCY,
);

function firstDiff(ours: string, gt: string): string {
  const la = ours.split('\n');
  const lb = gt.split('\n');
  let k = 0;
  while (la[k] === lb[k]) k++;
  return `first diff at line ${k + 1}:\n    expected: ${lb[k]}\n    got:      ${la[k]}`;
}

function compareBook({ sub, book }: { sub: string; book: string }, run: EpubCheckResult): void {
  const base = join(expectedRoot, sub, book);
  const file = `${sub}/${book}`;

  // SAVE -> REHYDRATE: serialize the run's complete report data and parse it
  // back, exactly as a consumer persisting and reloading it would. Everything
  // downstream renders from this rehydrated copy.
  const data = JSON.parse(
    JSON.stringify({ messages: run.messages, features: run.features }),
  ) as ReportData;

  interface Side {
    ext: string;
    canon: (s: string) => string;
    render: (gt: string) => string;
  }
  const sides: Side[] = [
    {
      ext: 'json',
      canon: canonJson,
      render: (gt) => formatJsonReport(data, {
        filename: book,
        checkDate: extract(gt, /"checkDate" : "([^"]*)"/, 'checkDate', `${base}.json`),
        elapsedTime: Number(extract(gt, /"elapsedTime" : (-?\d+)/, 'elapsedTime', `${base}.json`)),
      }),
    },
    {
      ext: 'xml',
      canon: canonXml,
      render: (gt) => formatXmlReport(data, {
        filename: book,
        generationDate: extract(gt, /<date>([^<]*)<\/date>/, 'date', `${base}.xml`),
      }),
    },
    {
      ext: 'xmp',
      canon: canonXml,
      render: (gt) => formatXmpReport(data, {
        filename: book,
        generationDate: extract(
          gt, /<premis:hasEventDateTime[^>]*>([^<]*)<\/premis:hasEventDateTime>/,
          'date', `${base}.xmp`),
      }),
    },
  ];

  for (const side of sides) {
    const gtPath = `${base}.${side.ext}`;
    let gt: string;
    try {
      gt = readFileSync(gtPath, 'utf8');
    } catch (e) {
      fail++;
      failures.push(`${file} [${side.ext}] ground-truth missing or unreadable: ${gtPath} (${e})`);
      continue;
    }
    let ours: string;
    try {
      ours = side.canon(side.render(gt));
    } catch (e) {
      fail++;
      failures.push(`${file} [${side.ext}] formatter threw: ${e}`);
      continue;
    }
    if (ours === side.canon(gt)) {
      pass++;
      continue;
    }
    fail++;
    failures.push(`${file} [${side.ext}] ${firstDiff(ours, side.canon(gt))}`);
  }
}

for (let i = 0; i < present.length; i++) compareBook(present[i]!, results[i]!);

console.log(`FORMATTER TEST: ${pass}/${pass + fail} report files byte-identical ` +
  `(${books.length} books x 3 formats)`);
if (fail) {
  for (const f of failures) console.error('  ' + f);
  console.error('FORMATTER TEST FAILED');
  process.exit(1);
}
console.log('FORMATTER TEST PASSED');
// Exit explicitly: the pool SIGKILLs its children on teardown, and a stray
// async exit event from those kills must never flip a PASSED run's exit code.
process.exit(0);
