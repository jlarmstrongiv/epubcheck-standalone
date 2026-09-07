#!/usr/bin/env node
// CACHE BUILDER (jar -> committed console answer keys). Runs the REAL
// epubcheck.jar ONCE per book in test/corpus and, from that SINGLE run, writes
// TWO complementary console answer keys -- one JSON per corpus group, all books:
//
//   1. test/expected/<group>.json          -- the SORTED MESSAGE cache:
//      { [book]: { exit, messages[] } }. Normalized + sorted message tokens,
//      order-insensitive. Consumed by test/parity.ts (engine-vs-jar message
//      parity) and the CLI jar-parity Phase 2. This is the historical cache;
//      its shape is unchanged.
//
//   2. test/expected-console-ordered/<group>.json -- the ORDERED CONSOLE cache:
//      { [book]: { exit, text } }. The jar's COMPLETE merged-stream console
//      output as ONE string in true program/emission order, with only the
//      per-run UUID host masked. Consumed by test/console.ts, which proves the
//      library's batch formatConsoleReport() byte-matches the jar's real
//      `2>&1` output INCLUDING order (e.g. a container WARNING emitted before
//      the "Validating using EPUB version..." line stays before it).
//
// Both keys come from ONE jar spawn per book: the jar is run with stdout and
// stderr merged at the OS level into a single ordered stream (a true `2>&1`,
// NOT out+err concatenation), which is the ground truth for ORDER; the sorted
// message cache is parsed from that same merged text (parsing then sorting
// yields the identical order-insensitive set the old separate-stream capture
// did, so cache #1 is byte-identical across this change).
//
//   node testing/build-console-cache.ts
//   CONCURRENCY=8 node testing/build-console-cache.ts
//
// This is the ONLY place the jar runs for the console answer keys (the sweep is
// retired). It is bump-only: rebuild when epubcheck's Java version changes, and
// the resulting git diff of test/expected/*.json + test/expected-console-ordered/*.json
// is the behavioral-drift review.
//
// HARD-FAIL, NEVER SILENT-SKIP: the builder's whole job is to run the jar, so a
// missing jar or java is a fatal error (exit 1), not a skip. (EPUBCHECK_REQUIRE_JAR
// is accepted for symmetry with the rest of the suite but the builder always
// requires the jar regardless.)
//
// NORMALIZE (byte-identical to test/parity.ts and the retired sweep): for the
// message cache, only the container path (collapsed to "EPUB") and the per-run
// UUID host are masked; everything else -- message ids, text, in-container
// paths, line/column -- compares literally. For the ordered console cache only
// the UUID host is masked (there are no timestamps in console output); the path
// is left intact so the text byte-matches formatConsoleReport's rendered lines.
//
// The jar is run with cwd=<book dir> and the BARE book name as its argument
// (mirroring testing/report-groundtruth.ts), so every location prefix is the
// bare book name -- lining the ordered cache up with formatConsoleReport's
// `filename` option (the name the engine validates under). The message cache is
// unaffected: its path regex collapses the leading path to "EPUB" either way.
//
// The java binary defaults to the mise-pinned JDK (mise which java); override
// with EPUBCHECK_JAVA. The jar defaults to the newest build/epubcheck-<v>/epubcheck.jar;
// override with EPUBCHECK_JAR.

import { spawn, spawnSync } from 'node:child_process';
import { readdirSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = dirname(here); // testing/ -> package root
const corpusRoot = join(pkgRoot, 'test', 'corpus');
const expectedDir = join(pkgRoot, 'test', 'expected');
const expectedConsoleOrderedDir = join(pkgRoot, 'test', 'expected-console-ordered');
const CONCURRENCY = Number(process.env.CONCURRENCY || 6);

// --- locate java + jar (hard-fail if absent -- the builder must run the jar) --
function resolveJava(): string {
  if (process.env.EPUBCHECK_JAVA) return process.env.EPUBCHECK_JAVA;
  const r = spawnSync('mise', ['which', 'java'], { encoding: 'utf8' });
  if (r.status === 0 && r.stdout) {
    const java = r.stdout.trim();
    if (existsSync(java)) return java;
  }
  return 'java';
}
function resolveJar(): string | null {
  if (process.env.EPUBCHECK_JAR) return process.env.EPUBCHECK_JAR;
  const buildDir = join(pkgRoot, 'build');
  if (!existsSync(buildDir)) return null;
  const candidates = readdirSync(buildDir)
    .filter((d) => /^epubcheck-\d+\.\d+\.\d+$/.test(d))
    .map((d) => join(buildDir, d, 'epubcheck.jar'))
    .filter((p) => existsSync(p))
    .sort();
  return candidates.length ? (candidates[candidates.length - 1] as string) : null;
}

const JAVA = resolveJava();
const JAR = resolveJar();
function die(msg: string): never {
  console.error(`build-console-cache: FATAL -- ${msg}`);
  process.exit(1);
}
if (!JAR || !existsSync(JAR)) {
  die('epubcheck jar not found (set EPUBCHECK_JAR, or run `npm run build:deps`). ' +
    'The cache builder must run the real jar; it never silent-skips.');
}
{
  const v = spawnSync(JAVA, ['-version'], { encoding: 'utf8' });
  if (v.error || v.status !== 0) {
    die(`java not runnable (EPUBCHECK_JAVA=${JAVA}). Provision java via mise install, or set EPUBCHECK_JAVA.`);
  }
}

// --- normalize (identical rules to test/parity.ts) --------------------------
const reEsc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const MSG_RE = /^(FATAL|ERROR|WARNING|INFO)\(([A-Z0-9]+[-_]\d+[a-z]?)\):\s*(.*)$/;

// The one volatile token in console output: the per-run random base-URL UUID
// host (https://<uuid>.epubcheck.w3c.org). There are NO timestamps in console
// output, so masking this alone makes a merged capture a stable answer key.
function maskUuidHost(text: string): string {
  return text.replace(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\.epubcheck\.w3c\.org)/g,
    'UUID',
  );
}

function normalize(rawOutput: string, epubBase: string): string[] {
  const pathRe = new RegExp('[^\\s(]*' + reEsc(epubBase), 'g');
  const msgs: string[] = [];
  for (let line of maskUuidHost(rawOutput).split('\n')) {
    line = line.replace(pathRe, 'EPUB');
    const m = line.match(MSG_RE);
    if (m) msgs.push(`${m[1]}(${m[2]}): ${m[3]}`);
  }
  msgs.sort();
  return msgs;
}

interface EvalResult { exit: number | null; messages: string[]; }
// The ORDERED CONSOLE cache entry: the jar's full merged `2>&1` output (UUID
// host masked), in true program/emission order, plus its exit code.
interface OrderedConsole { exit: number | null; text: string; }

// Run the jar ONCE for a book, capturing stdout+stderr merged at the OS level
// into a SINGLE ordered stream (a true `2>&1`, the real program-order
// interleave). A shell performs the redirect; `exec` replaces it with java so
// java's own exit code propagates unchanged. cwd=<book dir> + bare-name arg
// mirrors testing/report-groundtruth.ts (see the header): the location prefix
// is then the bare book name, matching formatConsoleReport's `filename`.
function runJar(dir: string, file: string): Promise<{ exit: number | null; raw: string }> {
  return new Promise((resolve) => {
    const p = spawn('sh', ['-c', 'exec "$0" -jar "$1" "$2" 2>&1', JAVA, JAR as string, file], {
      cwd: dir,
      env: { ...process.env, LC_ALL: 'en_US.UTF-8', LANG: 'en_US.UTF-8' },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    p.stdout!.on('data', (d) => (out += d));
    p.on('close', (code) => resolve({ exit: code, raw: out }));
    p.on('error', (e) => resolve({ exit: -1, raw: 'SPAWN_ERROR ' + e.message }));
  });
}

async function pool<T>(items: T[], n: number, fn: (item: T, i: number) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i] as T, i);
    }
  });
  await Promise.all(workers);
}

// Discover every corpus group (a subdir of test/corpus that holds .epub files);
// this globs, so new groups and new books are picked up with no hardcoded list.
const groups = readdirSync(corpusRoot)
  .filter((d) => statSync(join(corpusRoot, d)).isDirectory())
  .filter((d) => existsSync(join(corpusRoot, d)) &&
    readdirSync(join(corpusRoot, d)).some((f) => f.endsWith('.epub')))
  .sort();

if (!existsSync(expectedDir)) mkdirSync(expectedDir, { recursive: true });
if (!existsSync(expectedConsoleOrderedDir)) mkdirSync(expectedConsoleOrderedDir, { recursive: true });

console.log(`build-console-cache: java=${JAVA}`);
console.log(`build-console-cache: jar=${JAR}`);
console.log(`build-console-cache: groups=${groups.join(', ')}`);

let grandTotal = 0;
const t0 = Date.now();
for (const group of groups) {
  const dir = join(corpusRoot, group);
  const files = readdirSync(dir).filter((f) => f.endsWith('.epub')).sort();
  process.stderr.write(`[${group}] ${files.length} books ...\n`);
  const cache: Record<string, EvalResult> = {};
  const consoleCache: Record<string, OrderedConsole> = {};
  let done = 0;
  await pool(files, CONCURRENCY, async (file) => {
    // ONE jar spawn per book; both answer keys are derived from its merged output.
    const r = await runJar(dir, file);
    cache[file] = { exit: r.exit, messages: normalize(r.raw, file) };
    consoleCache[file] = { exit: r.exit, text: maskUuidHost(r.raw) };
    if (++done % 50 === 0) process.stderr.write(`[${group}] ${done}/${files.length}\n`);
  });
  // Write keys in sorted order for a stable, review-friendly diff.
  const sortedMessages: Record<string, EvalResult> = {};
  for (const k of Object.keys(cache).sort()) sortedMessages[k] = cache[k] as EvalResult;
  writeFileSync(join(expectedDir, group + '.json'), JSON.stringify(sortedMessages, null, 2) + '\n');
  const sortedConsole: Record<string, OrderedConsole> = {};
  for (const k of Object.keys(consoleCache).sort()) sortedConsole[k] = consoleCache[k] as OrderedConsole;
  writeFileSync(join(expectedConsoleOrderedDir, group + '.json'), JSON.stringify(sortedConsole, null, 2) + '\n');
  process.stderr.write(`[${group}] message + ordered-console caches written (${files.length} books)\n`);
  grandTotal += files.length;
}

console.log(`build-console-cache: DONE ${grandTotal} book entries across ${groups.length} groups in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
process.exit(0);
