#!/usr/bin/env node
// CONSOLE ORDER PARITY (offline): prove the library's BATCH console renderer
// -- formatConsoleReport({ messages, features }, { filename }) -- byte-matches
// the real epubcheck.jar's MERGED `2>&1` console output, INCLUDING emission
// ORDER, for a dial-controlled sample of the committed corpus.
//
//   node test/console.ts                default: ~50 stable-sampled books
//   PARITY=full node test/console.ts    every book in the corpus
//   PARITY=12 node test/console.ts      ~12 stable-sampled books
//   CONCURRENCY=8 node test/console.ts  worker-pool size (default 6)
//
// WHAT THIS IS (vs test/parity.ts): test/parity.ts compares the SORTED, order-
// insensitive message SET against test/expected/<group>.json. THIS suite is the
// stronger, order-SENSITIVE check: it compares the COMPLETE console text as one
// string against the ORDERED CONSOLE cache in test/expected-console-ordered/
// <group>.json -- so it proves, e.g., that a container WARNING(PKG-010) emitted
// BEFORE the "Validating using EPUB version..." line stays before it, which a
// sorted set can never catch.
//
// The answer key is the actual jar's merged `2>&1` output, captured + committed
// by the cache builder (testing/build-console-cache.ts) from the SAME jar run
// that produces the message cache. So a green run proves our batch formatter
// still reproduces Java's real console output byte-for-byte, in order -- not
// merely that it hasn't changed. NO live jar or java is used here: this runner
// reads only the committed cache, so it runs fast anywhere (like test/parity.ts,
// test/reports.ts, test/formatters.ts).
//
// To REBUILD the cache from a new jar (only when epubcheck's version bumps), run
// `npm run test:parity:generate` (-> testing/build-console-cache.ts); its git
// diff is the console behavioral-drift review.
//
// DIAL + STABLE SAMPLING: PARITY picks how many books each run checks; the sample
// is keyed on each book's own relative path (test/sample.ts) -- the SAME dial +
// stable sample test/parity.ts / test/reports.ts / test/formatters.ts use, so
// all four suites check the SAME set of books at a given PARITY setting. `full`
// covers everything.
//
// NORMALIZE (byte-identical to the cache builder): mask ONLY the per-run UUID
// host (there are no timestamps in console output); everything else -- including
// the full ordered text -- compares literally. filename = the bare book name is
// the name the engine validated under (the cache builder ran the jar cwd=<book
// dir> + bare-name arg), so the location prefixes line up.

import { validatePool } from './validate-pool.ts';
import { parseDial, inSample } from './sample.ts';
import type { EpubCheckResult } from '../dist/index.js';
import { formatConsoleReport } from '../dist/formatters/index.js';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const corpusRoot = join(here, 'corpus');
const expectedDir = join(here, 'expected-console-ordered');
const CONCURRENCY = Number(process.env.CONCURRENCY || 6);
const dial = parseDial();

interface OrderedConsole { exit: number | null; text: string; }

// Mask the one volatile token (per-run UUID host) exactly as the cache builder
// does; no other normalization -- the ordered text is compared byte-for-byte.
const maskUuidHost = (text: string): string => text.replaceAll(
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\.epubcheck\.w3c\.org)/g,
  'UUID',
);

// Discover corpus groups (subdirs with .epub files) -- globbed, no hardcoded
// list. Each group must have a committed ordered-console cache.
const groups = readdirSync(corpusRoot)
  .filter((d) => existsSync(join(corpusRoot, d)) && (() => {
    try { return readdirSync(join(corpusRoot, d)).some((f) => f.endsWith('.epub')); }
    catch { return false; }
  })())
  .sort();

interface Task { corpus: string; file: string; path: string; }
const tasks: Task[] = [];
let totalBooks = 0;
console.error(`[console] dial PARITY=${dial.label}`);
for (const corpus of groups) {
  const dir = join(corpusRoot, corpus);
  const allFiles = readdirSync(dir).filter((f) => f.endsWith('.epub')).sort();
  totalBooks += allFiles.length;
  const files = allFiles.filter((f) => inSample(`${corpus}/${f}`, dial));
  process.stderr.write(`[${corpus}] ${files.length}/${allFiles.length} books (dial) ...\n`);
  for (const file of files) tasks.push({ corpus, file, path: join(dir, file) });
}

// Load each group's committed ordered-console cache once (lazy per group).
const caches: Record<string, Record<string, OrderedConsole>> = {};
function cacheFor(corpus: string): Record<string, OrderedConsole> {
  if (!caches[corpus]) {
    const cacheFile = join(expectedDir, corpus + '.json');
    if (!existsSync(cacheFile)) {
      console.error(`MISSING CACHE: ${cacheFile} -- rebuild with npm run test:parity:generate`);
      process.exit(2);
    }
    caches[corpus] = JSON.parse(readFileSync(cacheFile, 'utf8')) as Record<string, OrderedConsole>;
  }
  return caches[corpus]!;
}

// One plain engine run per sampled book; its result carries { messages, features }.
const results = await validatePool(tasks.map((t) => ({ path: t.path })), CONCURRENCY);

function unifiedDiff(ours: string, exp: string): string {
  const a = ours.split('\n');
  const b = exp.split('\n');
  const n = Math.max(a.length, b.length);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    if (a[i] === b[i]) continue;
    if (b[i] !== undefined) out.push(`    - jar   [${i + 1}]: ${JSON.stringify(b[i])}`);
    if (a[i] !== undefined) out.push(`    + our   [${i + 1}]: ${JSON.stringify(a[i])}`);
  }
  return out.join('\n');
}

let pass = 0;
let fail = 0;
const failures: string[] = [];

for (let i = 0; i < tasks.length; i++) {
  const t = tasks[i]!;
  const r = results[i] as EpubCheckResult;
  const exp = cacheFor(t.corpus)[t.file];
  if (!exp) {
    fail++;
    failures.push(`[${t.corpus}] ${t.file}: no ordered-console cache entry`);
    continue;
  }
  const ours = maskUuidHost(
    formatConsoleReport({ messages: r.messages, features: r.features }, { filename: t.file }),
  );
  const okText = ours === exp.text;
  const okExit = r.exitCode === exp.exit;
  if (okText && okExit) { pass++; continue; }
  fail++;
  const notes: string[] = [];
  if (!okExit) notes.push(`exit jar=${exp.exit} engine=${r.exitCode} (valid=${r.valid})`);
  if (!okText) notes.push('console text mismatch:\n' + unifiedDiff(ours, exp.text));
  failures.push(`[${t.corpus}] ${t.file}: ${notes.join('; ')}`);
}

console.log(`\nCONSOLE ORDER PARITY (batch formatConsoleReport vs jar merged 2>&1): ` +
  `${pass}/${tasks.length} byte-identical (dial PARITY=${dial.label}; ${totalBooks} books in corpus)`);
if (fail) {
  console.error(`\n${fail} MISMATCH(es):`);
  for (const f of failures) console.error('  ' + f);
  console.error('CONSOLE ORDER PARITY FAILED');
  process.exit(1);
}
console.log('CONSOLE ORDER PARITY PASSED');
// Exit explicitly: the pool SIGKILLs its child processes on teardown, and a stray
// async exit event from one of those kills must never flip a PASSED run's code.
process.exit(0);
