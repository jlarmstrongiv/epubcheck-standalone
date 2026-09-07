#!/usr/bin/env node
// Generate GROUND-TRUTH report files with the real (native JVM) epubcheck.jar:
// for every .epub in a corpus, produce the three file reports epubcheck can
// write -- --json (CheckingReport), --out (XmlReportImpl), --xmp
// (XmpReportImpl) -- one java run per format (the CLI renders exactly one
// report file per run).
//
//   node testing/report-groundtruth.ts <corpusRoot> <outDir> [concurrency] [--existing-only]
//
//   corpusRoot   directory containing corpus subdirs (e.g. test/corpus, or the
//                full parity corpus checkout); every *.epub found one level
//                below it (corpusRoot/<sub>/<book>.epub) is processed.
//   outDir       ground truth is written to outDir/<sub>/<book>.epub.{json,xml,xmp}
//   --existing-only  only regenerate books that ALREADY have expected reports in
//                outDir (keeps the committed golden set at its current size
//                instead of expanding to the whole corpus; used by the
//                update-epubcheck workflow).
//
// DETERMINISM RULES (the epubcheck-standalone/formatters must reproduce these
// byte-for-byte, so the generation environment is pinned):
//   - cwd = the book's own directory, CLI arg = the bare file name. epubcheck
//     derives every path field from that: JSON checker.path becomes
//     "./<name>", checker.filename "<name>", XML repInfo uri "<name>".
//   - HOST-LOCAL TIMEZONE (TZ deliberately NOT overridden). The only
//     TZ-sensitive value is the zip "creation date" of META-INF/container.xml:
//     DOS-timestamp-only entries round-trip to the same wall-clock string in
//     any zone, but entries with zip EXTENDED timestamps (true UTC) are
//     formatted in the JVM's default zone -- and our engine formats them in
//     the HOST's zone, so the native ground truth must be generated in the
//     same (host) zone to be comparable.
//   - locale pinned to en-US (message/suggestion localization).
//
// The java binary defaults to the mise-pinned JDK (mise which java); override
// with EPUBCHECK_JAVA. The jar defaults to the one `npm run build:deps`
// fetches; override with EPUBCHECK_JAR.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const rawArgs = process.argv.slice(2);
const existingOnly = rawArgs.includes('--existing-only');
const args = rawArgs.filter((a) => a !== '--existing-only');
const corpusRoot = args[0];
const outRoot = args[1];
const CONCURRENCY = Number(args[2] || process.env.CONCURRENCY || 8);
if (!corpusRoot || !outRoot) {
  console.error('usage: node testing/report-groundtruth.ts <corpusRoot> <outDir> [concurrency] [--existing-only]');
  process.exit(64);
}

function resolveJava() {
  if (process.env.EPUBCHECK_JAVA) return process.env.EPUBCHECK_JAVA;
  const r = spawnSync('mise', ['which', 'java'], { encoding: 'utf8' });
  if (r.status === 0 && r.stdout) {
    const java = r.stdout.trim();
    if (existsSync(java)) return java;
  }
  return 'java';
}

const JAVA = resolveJava();
const JAR = process.env.EPUBCHECK_JAR || join(root, 'build', 'epubcheck-5.3.0', 'epubcheck.jar');
if (!existsSync(JAR)) {
  console.error(`epubcheck.jar not found at ${JAR} -- run: npm run build:deps`);
  process.exit(1);
}

interface Job { sub: string; dir: string; book: string; }
interface Format { flag: string; ext: string; }

const FORMATS: Format[] = [
  { flag: '--json', ext: 'json' },
  { flag: '--out', ext: 'xml' },
  { flag: '--xmp', ext: 'xmp' },
];

// Collect corpusRoot/<sub>/<book>.epub jobs. With --existing-only, a book is
// included only if at least one of its three expected files is already present
// (all three are then regenerated so the triple stays consistent).
const jobs: Job[] = [];
for (const sub of readdirSync(resolve(corpusRoot)).sort()) {
  const dir = join(resolve(corpusRoot), sub);
  if (!statSync(dir).isDirectory()) continue;
  let books = readdirSync(dir).filter((f) => f.endsWith('.epub')).sort();
  if (existingOnly) {
    books = books.filter((book) =>
      FORMATS.some((format) => existsSync(join(resolve(outRoot), sub, `${book}.${format.ext}`))),
    );
  }
  if (books.length === 0) continue;
  mkdirSync(join(resolve(outRoot), sub), { recursive: true });
  for (const book of books) jobs.push({ sub, dir, book });
}

function runOne(job: Job, format: Format): Promise<void> {
  const outFile = join(resolve(outRoot), job.sub, `${job.book}.${format.ext}`);
  return new Promise<void>((resolvePromise, reject) => {
    const child = spawn(JAVA, ['-jar', JAR, job.book, format.flag, outFile], {
      cwd: job.dir,
      env: { ...process.env, LC_ALL: 'en_US.UTF-8', LANG: 'en_US.UTF-8' },
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    child.on('error', reject);
    child.on('close', () => resolvePromise());
  });
}

let done = 0;
async function worker() {
  for (;;) {
    const i = next++;
    if (i >= jobs.length) return;
    const job = jobs[i];
    for (const format of FORMATS) {
      await runOne(job, format);
    }
    done++;
    if (done % 25 === 0) process.stderr.write(`  ${done}/${jobs.length} books done\n`);
  }
}

let next = 0;
const t0 = Date.now();
console.log(`ground truth: ${jobs.length} books x ${FORMATS.length} formats -> ${resolve(outRoot)}`);
console.log(`java: ${JAVA}\njar:  ${JAR}\nhost TZ, LC_ALL=en_US.UTF-8, cwd=<book dir>, arg=<book name>`);
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, worker));
console.log(`done: ${jobs.length} books in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
