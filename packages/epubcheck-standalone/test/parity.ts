#!/usr/bin/env node
// CONSOLE PARITY: run OUR ENGINE on a dial-controlled sample of the committed
// corpus and compare its normalized console output (messages + exit code) to the
// JAR CONSOLE CACHE in test/expected/<group>.json.
//
//   node test/parity.ts                 default: ~50 stable-sampled books
//   PARITY=full node test/parity.ts     every book in the corpus
//   PARITY=120 node test/parity.ts      ~120 stable-sampled books
//   CONCURRENCY=8 node test/parity.ts   worker-pool size (default 6)
//
// WHAT THIS IS: a REAL parity check. The answer key in test/expected/*.json is
// the actual epubcheck.jar's output, captured + committed by the cache builder
// (testing/build-console-cache.ts); it is NOT a snapshot of this engine. So a
// green run proves our engine still matches Java, message-for-message and on the
// exit code -- not merely that it hasn't changed. The jar runs ONLY in the cache
// builder (bump-time); this runner reads the committed cache, so it needs no jar
// or java and runs fast anywhere.
//
// To REBUILD the cache from a new jar (only when epubcheck's version bumps), run
// `npm run test:parity:generate` (-> testing/build-console-cache.ts); its git
// diff is the behavioral-drift review.
//
// DIAL + STABLE SAMPLING: PARITY picks how many books each run checks; the sample
// is keyed on each book's own relative path (test/sample.ts), so it is stable
// under corpus growth/regen and failures reproduce. `full` covers everything.
//
// NORMALIZE (byte-identical to the cache builder): mask the container path to
// "EPUB" and the per-run UUID host; everything else compares literally.
//
// The committed corpus is 446 books (epubcheck-expanded + epubcheck-prezipped +
// standard-ebooks). The generated stress books (88 MB image book, multi-GB
// ZIP64 books) are NOT in test/corpus/ -- they are regenerable with
// testing/generate-books.ts / testing/generate-big-books.ts and excluded from CI
// and the repo (see agent-docs/BIGBOOK.md).

import { validatePool } from './validate-pool.ts';
import { parseDial, inSample } from './sample.ts';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const corpusRoot = join(here, 'corpus');
const expectedDir = join(here, 'expected');
const CONCURRENCY = Number(process.env.CONCURRENCY || 6);
const dial = parseDial();

const reEsc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const MSG_RE = /^(FATAL|ERROR|WARNING|INFO)\(([A-Z0-9]+[-_]\d+[a-z]?)\):\s*(.*)$/;

interface EvalResult { exit: number | null; messages: string[]; }
interface Task { corpus: string; file: string; path: string; }
interface Fail {
  file: string;
  expExit: number | null | undefined;
  gotExit: number | null;
  onlyExpected: string[];
  onlyGot: string[];
}

// Normalize captured output into a sorted, comparable set of message tokens --
// identical rules to testing/build-console-cache.ts so a match here means our
// engine agrees with the jar.
function normalize(rawOutput: string, epubBase: string): string[] {
  const pathRe = new RegExp('[^\\s(]*' + reEsc(epubBase), 'g');
  const uuidRe = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\.epubcheck\.w3c\.org)/g;
  const msgs = [];
  for (let line of rawOutput.split('\n')) {
    line = line.replace(pathRe, 'EPUB').replace(uuidRe, 'UUID');
    const m = line.match(MSG_RE);
    if (m) msgs.push(`${m[1]}(${m[2]}): ${m[3]}`);
  }
  msgs.sort();
  return msgs;
}

// Discover corpus groups (subdirs with .epub files) -- globbed, no hardcoded
// list, so new groups/books are covered automatically. Each group must have a
// committed jar console cache in test/expected/<group>.json.
const groups = readdirSync(corpusRoot)
  .filter((d) => existsSync(join(corpusRoot, d)) && (() => {
    try { return readdirSync(join(corpusRoot, d)).some((f) => f.endsWith('.epub')); }
    catch { return false; }
  })())
  .sort();

let totalPass = 0;
let totalFail = 0;
let totalSelected = 0;
let totalBooks = 0;
const failuresByCorpus: Record<string, Fail[]> = {};

console.error(`[parity] dial PARITY=${dial.label}`);

for (const corpus of groups) {
  const dir = join(corpusRoot, corpus);
  const allFiles = readdirSync(dir).filter((f) => f.endsWith('.epub')).sort();
  totalBooks += allFiles.length;
  // Apply the stable dial sample (key = "<group>/<file>").
  const files = allFiles.filter((f) => inSample(`${corpus}/${f}`, dial));
  totalSelected += files.length;
  process.stderr.write(`[${corpus}] ${files.length}/${allFiles.length} books (dial) ...\n`);
  if (files.length === 0) continue;

  const baselineFile = join(expectedDir, corpus + '.json');
  if (!existsSync(baselineFile)) {
    console.error(`MISSING CACHE: ${baselineFile} -- rebuild with npm run test:parity:generate`);
    process.exit(2);
  }
  const baseline = JSON.parse(readFileSync(baselineFile, 'utf8')) as Record<string, EvalResult>;

  // Validate across a worker-thread pool (the library serializes in-thread, so
  // the suite brings its own parallelism -- see validate-pool.ts).
  const tasks: Task[] = files.map((file) => ({ corpus, file, path: join(dir, file) }));
  const results = await validatePool(tasks.map((t) => ({ path: t.path })), CONCURRENCY);

  const fails: Fail[] = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i] as string;
    const r = results[i]!;
    const res: EvalResult = { exit: r.exitCode, messages: normalize(r.stdout + '\n' + r.stderr, file) };
    const exp = baseline[file];
    const ok = exp &&
      exp.exit === res.exit &&
      JSON.stringify(exp.messages) === JSON.stringify(res.messages);
    if (ok) { totalPass++; }
    else {
      totalFail++;
      fails.push({
        file,
        expExit: exp && exp.exit, gotExit: res.exit,
        onlyExpected: exp ? exp.messages.filter((m) => !res.messages.includes(m)) : ['<no cache entry>'],
        onlyGot: exp ? res.messages.filter((m) => !exp.messages.includes(m)) : res.messages,
      });
    }
  }
  if (fails.length) failuresByCorpus[corpus] = fails;
  process.stderr.write(`[${corpus}] pass=${files.length - fails.length}/${files.length}\n`);
}

console.log(`\nCONSOLE PARITY (engine vs jar cache): ${totalPass}/${totalSelected} passed ` +
  `(dial PARITY=${dial.label}; ${totalBooks} books in corpus)`);
if (totalFail) {
  console.error(`\n${totalFail} MISMATCH(es) -- our engine diverged from the jar cache:`);
  for (const [corpus, fails] of Object.entries(failuresByCorpus)) {
    for (const f of fails) {
      console.error(`  [${corpus}] ${f.file}  exit exp=${f.expExit} got=${f.gotExit}`);
      for (const m of f.onlyExpected) console.error(`      - jar only:    ${m}`);
      for (const m of f.onlyGot) console.error(`      + engine only: ${m}`);
    }
  }
  process.exit(1);
}
console.log('CONSOLE PARITY PASSED');
// Exit explicitly so the printed verdict and the process exit code always agree:
// the pool SIGKILLs its child processes on teardown, and a stray async exit event
// from one of those kills must never flip a PASSED run to a non-zero code.
process.exit(0);
