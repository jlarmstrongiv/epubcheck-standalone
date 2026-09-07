#!/usr/bin/env node
// TeaVM parity suite: runs the full 446-book committed corpus through the
// TeaVM build (one fresh child process per book, plain-CLI output) and
// compares each result to the SAME baselines the wasm suite uses
// (test/expected/*.json -- captured from the parity-verified wasm build, i.e.
// jar-equivalent ground truth). Normalization rules are byte-identical to
// test/parity.ts so a pass here means jar parity.
//
//   mise exec -- node parity-teavm.ts                     full run
//   CONCURRENCY=8 mise exec -- node parity-teavm.ts       pool size (default 6)
//   ONLY=fixtures mise exec -- node parity-teavm.ts       one corpus
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const testDir = join(here, '..', 'test');
const CORPORA = (process.env.ONLY ? [process.env.ONLY] : ['epubcheck-expanded', 'epubcheck-prezipped', 'standard-ebooks']);
const CONCURRENCY = Number(process.env.CONCURRENCY || 6);

const reEsc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const MSG_RE = /^(FATAL|ERROR|WARNING|INFO)\(([A-Z0-9]+[-_]\d+[a-z]?)\):\s*(.*)$/;

interface EvalResult { exit: number | null; messages: string[]; }

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

interface RunResult { exit: number | null; err: string | null; stdout: string; stderr: string; }

function runOne(epubPath: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const child = spawn(process.execPath, [join(here, 'parity-worker.ts'), epubPath], {
      stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
    });
    const fd3 = child.stdio[3] as NodeJS.ReadableStream;
    fd3.on('data', (c: Buffer) => chunks.push(c));
    child.on('close', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as RunResult);
      } catch {
        resolve({ exit: null, err: 'worker produced no result', stdout: '', stderr: '' });
      }
    });
  });
}

async function pool<T, R>(items: T[], n: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function lane() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i] as T, i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, lane));
  return results;
}

let totalPass = 0;
let totalFail = 0;
let totalBooks = 0;
const t0 = Date.now();

for (const corpus of CORPORA) {
  const dir = join(testDir, 'corpus', corpus);
  const files = readdirSync(dir).filter((f) => f.endsWith('.epub')).sort();
  totalBooks += files.length;
  const baseline = JSON.parse(readFileSync(join(testDir, 'expected', corpus + '.json'), 'utf8')) as Record<string, EvalResult>;
  process.stderr.write(`[${corpus}] ${files.length} books ...\n`);

  let done = 0;
  const results = await pool(files, CONCURRENCY, async (file) => {
    const r = await runOne(join(dir, file));
    done++;
    if (done % 25 === 0) process.stderr.write(`[${corpus}] ${done}/${files.length}\n`);
    return r;
  });

  let fails = 0;
  for (let i = 0; i < files.length; i++) {
    const file = files[i] as string;
    const r = results[i] as RunResult;
    const exp = baseline[file];
    const got: EvalResult = { exit: r.exit, messages: normalize(r.stdout + '\n' + r.stderr, file) };
    const ok = exp && !r.err &&
      exp.exit === got.exit &&
      JSON.stringify(exp.messages) === JSON.stringify(got.messages);
    if (ok) { totalPass++; continue; }
    totalFail++;
    fails++;
    console.error(`  [${corpus}] ${file}  exit exp=${exp?.exit} got=${got.exit}${r.err ? ' CRASH' : ''}`);
    if (r.err) console.error('      crash: ' + r.err.split('\n').slice(0, 6).join(' | '));
    if (exp) {
      for (const m of exp.messages.filter((m) => !got.messages.includes(m))) console.error(`      - expected only: ${m}`);
      for (const m of got.messages.filter((m) => !exp.messages.includes(m))) console.error(`      + got only:      ${m}`);
    }
  }
  process.stderr.write(`[${corpus}] pass=${files.length - fails}/${files.length}\n`);
}

console.log(`\nTEAVM PARITY: ${totalPass}/${totalBooks} passed in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
process.exit(totalFail ? 1 : 0);
