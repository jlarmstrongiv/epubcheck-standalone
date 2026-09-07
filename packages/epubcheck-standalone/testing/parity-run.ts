#!/usr/bin/env node
// Parity runner (manual tool): for each .epub in a corpus dir, run a NATIVE
// epubcheck baseline and the current library engine (via the
// testing/run-epubcheck-opt.ts harness) under Node, normalize incidental path
// differences, and diff the message sets + exit codes. Records wall-time and
// peak RSS (via /usr/bin/time -l) for both sides. The `wasm`-named identifiers
// below predate the TeaVM plain-JavaScript engine; they mean "the library
// engine side" of the comparison. The committed-golden parity gate is
// test/parity.ts; this tool is for ad-hoc live comparisons over any corpus.
//
// Usage: node parity-run.ts <corpus-dir> <part-label> [--limit N]
import { spawnSync } from 'node:child_process';
import { readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';

import { fileURLToPath } from 'node:url';
const REPO = fileURLToPath(new URL('..', import.meta.url));
const NODE = process.execPath;
// The native epubcheck baseline is NOT shipped in this repo. Point NATIVE at
// any executable that runs epubcheck on a book-path argument (e.g. a small
// wrapper script around `java -jar epubcheck.jar`); the default path is a
// leftover convention with nothing behind it unless you put a binary there.
const NATIVE = process.env.NATIVE || join(REPO, 'build/build-native/epubcheck-native');
const HARNESS = join(REPO, 'testing/run-epubcheck-opt.ts');
const TIME = '/usr/bin/time';

const corpusDir = process.argv[2];
const part = process.argv[3] || 'part';
const limIdx = process.argv.indexOf('--limit');
const limit = limIdx > -1 ? parseInt(process.argv[limIdx + 1], 10) : Infinity;
if (!corpusDir) { console.error('usage: node parity-run.ts <corpus-dir> <part-label> [--limit N]'); process.exit(64); }

const RESDIR = join(REPO, 'testing/results');
const LOGDIR = join(REPO, 'testing/logs', part);
mkdirSync(RESDIR, { recursive: true });
mkdirSync(LOGDIR, { recursive: true });

const reEsc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A "message" line from epubcheck: SEVERITY(CODE): [location(line,col): ] text
const MSG_RE = /^(FATAL|ERROR|WARNING|INFO)\(([A-Z]+-\d+)\):\s*(.*)$/;

// Split a /usr/bin/time -l -polluted stderr into [programStderr, rss].
function splitTime(stderrText: string): [string, number | null] {
  const lines = stderrText.split('\n');
  let idx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\s*[\d.]+\s+real\s+[\d.]+\s+user\s+[\d.]+\s+sys/.test(lines[i])) { idx = i; break; }
  }
  if (idx === -1) return [stderrText, null];
  const report = lines.slice(idx).join('\n');
  const prog = lines.slice(0, idx).join('\n');
  const m = report.match(/(\d+)\s+maximum resident set size/);
  return [prog, m ? parseInt(m[1], 10) : null];
}

// Normalize a captured stderr into a sorted, comparable set of message tokens.
function normalize(progStderr: string, epubBase: string): string[] {
  // Collapse any path token ending in the epub basename down to "EPUB".
  const pathRe = new RegExp('[^\\s(]*' + reEsc(epubBase), 'g');
  const msgs = [];
  for (let line of progStderr.split('\n')) {
    line = line.replace(pathRe, 'EPUB');
    // epubcheck's OCFContainer builds its synthetic root URL from
    // UUID.randomUUID() ("https://<uuid>.epubcheck.w3c.org"), which leaks into
    // some messages (e.g. CSS-007 remote-font references). That differs between
    // ANY two runs -- even native vs native -- so collapse it to a fixed token.
    line = line.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\.epubcheck\.w3c\.org)/g, 'UUID');
    const m = line.match(MSG_RE);
    if (m) msgs.push(`${m[1]}(${m[2]}): ${m[3]}`);
  }
  msgs.sort();
  return msgs;
}

function runNative(file: string) {
  const t0 = process.hrtime.bigint();
  const r = spawnSync(TIME, ['-l', NATIVE, file], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const wall = Number(process.hrtime.bigint() - t0) / 1e9;
  const [prog, rss] = splitTime(r.stderr || '');
  return { exit: r.status, stdout: r.stdout || '', stderr: prog, wall, rss };
}
function runWasm(file: string) {
  const t0 = process.hrtime.bigint();
  const r = spawnSync(TIME, ['-l', NODE, HARNESS, file], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const wall = Number(process.hrtime.bigint() - t0) / 1e9;
  const [prog, rss] = splitTime(r.stderr || '');
  return { exit: r.status, stdout: r.stdout || '', stderr: prog, wall, rss };
}

const files = readdirSync(corpusDir).filter((f) => f.endsWith('.epub')).sort();
const chosen = files.slice(0, limit === Infinity ? files.length : limit);
console.error(`[${part}] ${files.length} epubs found, running ${chosen.length}`);

interface Rec {
  file: string; base: string;
  pass: boolean; msgsEqual: boolean; exitEqual: boolean; errLevelEqual: boolean; wasmCrash: boolean;
  nativeExit: number | null; wasmExit: number | null;
  nativeWall: number; wasmWall: number;
  nativeRssMB: number | null; wasmRssMB: number | null;
  nMsgs: number; wMsgs: number;
  nativeMsgs?: string[]; wasmMsgs?: string[]; onlyNative?: string[]; onlyWasm?: string[];
}

const results: Rec[] = [];
let pass = 0, mismatch = 0;
for (let i = 0; i < chosen.length; i++) {
  const f = chosen[i];
  const path = join(corpusDir, f);
  const base = basename(f);
  const nat = runNative(path);
  const was = runWasm(path);
  const natMsgs = normalize(nat.stderr, base);
  const wasMsgs = normalize(was.stderr, base);
  const msgsEqual = JSON.stringify(natMsgs) === JSON.stringify(wasMsgs);
  const exitEqual = nat.exit === was.exit;
  // Error-level parity ignores INFO-severity messages (e.g. RSC-022 image-detail infos).
  const noInfo = (arr: string[]): string[] => arr.filter((m) => !m.startsWith('INFO('));
  const natErr = noInfo(natMsgs), wasErr = noInfo(wasMsgs);
  const errLevelEqual = JSON.stringify(natErr) === JSON.stringify(wasErr);
  // Detect wasm crash: exception/stack signatures in stderr not present in native.
  const crashSig = /(Exception|Error:|MissingReflectionRegistration|ClassNotFound|UnsatisfiedLink|could not be loaded|at [\w.$]+\()/;
  const wasmCrash = crashSig.test(was.stderr) && !crashSig.test(nat.stderr);
  const isPass = msgsEqual && exitEqual && !wasmCrash;
  if (isPass) pass++; else mismatch++;
  const rec: Rec = {
    file: f, base,
    pass: isPass, msgsEqual, exitEqual, errLevelEqual, wasmCrash,
    nativeExit: nat.exit, wasmExit: was.exit,
    nativeWall: +nat.wall.toFixed(3), wasmWall: +was.wall.toFixed(3),
    nativeRssMB: nat.rss ? +(nat.rss / 1048576).toFixed(1) : null,
    wasmRssMB: was.rss ? +(was.rss / 1048576).toFixed(1) : null,
    nMsgs: natMsgs.length, wMsgs: wasMsgs.length,
  };
  if (!isPass) {
    rec.nativeMsgs = natMsgs;
    rec.wasmMsgs = wasMsgs;
    rec.onlyNative = natMsgs.filter((m) => !wasMsgs.includes(m));
    rec.onlyWasm = wasMsgs.filter((m) => !natMsgs.includes(m));
    // dump full raw logs for evidence
    writeFileSync(join(LOGDIR, base + '.native.txt'), `EXIT=${nat.exit}\n--STDOUT--\n${nat.stdout}\n--STDERR--\n${nat.stderr}`);
    writeFileSync(join(LOGDIR, base + '.wasm.txt'), `EXIT=${was.exit}\n--STDOUT--\n${was.stdout}\n--STDERR--\n${was.stderr}`);
  }
  results.push(rec);
  if ((i + 1) % 25 === 0 || !isPass) console.error(`[${part}] ${i + 1}/${chosen.length}  pass=${pass} mismatch=${mismatch}  ${isPass ? 'ok' : 'MISMATCH ' + f}`);
}

const errLevelPass = results.filter((r) => r.errLevelEqual && r.exitEqual && !r.wasmCrash).length;
const crashes = results.filter((r) => r.wasmCrash).length;
const summary = {
  part, corpusDir, total: chosen.length, pass, mismatch,
  parityRate: +(100 * pass / chosen.length).toFixed(1),
  errLevelPass, errLevelParityRate: +(100 * errLevelPass / chosen.length).toFixed(1),
  wasmCrashes: crashes,
  generatedAt: new Date().toISOString(),
};
writeFileSync(join(RESDIR, part + '.json'), JSON.stringify({ summary, results }, null, 2));
console.error(`[${part}] DONE  pass=${pass}/${chosen.length}  parity=${summary.parityRate}%  -> results/${part}.json`);
