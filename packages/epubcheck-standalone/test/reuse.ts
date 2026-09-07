#!/usr/bin/env node
// VM-reuse suite: the engine now runs IN-PROCESS and is reusable -- a fresh VM
// per call, disposed with a macrotask yield between runs, all on the calling
// thread. This suite proves that reuse is BYTE-FOR-BYTE indistinguishable from a
// single run: validating the same input again (even after a DIFFERENT input ran
// in between) yields the identical exit code, stdout, stderr, and report tap.
//
//   node test/reuse.ts
//
// It exercises every input mode sequentially in ONE thread -- plain file,
// customMessages override, expanded directory (dirMode: 'exp'), and an http(s) URL
// (served by a throwaway local server) -- running each at least twice,
// interleaved with others, and asserting each input's signature never changes.
// If any cross-run state leaked between runs (a stale globalThis feed, a spent VM
// scope, a lingering tap), an interleaved re-run would differ and fail here.
//
// The memory-plateau check is deliberately NOT here: it is a local manual
// measurement (see agent-docs), not a battery test, because forcing GC and
// sampling RSS is environment-sensitive and does not belong in CI.

import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate } from '../dist/index.js';
import { fs, fsDir, url as urlSource } from '../dist/plugins.js';
import type { EpubCheckResult } from '../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const validateFile = async (path: string, options = {}) => validate(await fs(path), options);
const validateDirectory = async (path: string, options = {}) => validate(await fsDir(path), options);
const fixtures = join(here, 'fixtures');
const corpus = join(here, 'corpus');

let failures = 0;
function check(name: string, cond: unknown, detail?: string): void {
  if (cond) console.log(`  ok  - ${name}`);
  else {
    failures++;
    console.log(`  NOT OK - ${name}${detail ? ': ' + detail : ''}`);
  }
}

// Canonicalize a result for byte-comparison across runs. A handful of tokens
// vary run-to-run even in a SINGLE native run, so normalize them on both sides
// (the same tokens parity / reports / url suites normalize):
//   - the random base-URL UUID (https://<uuid>.epubcheck.w3c.org),
//   - the random temp path a URL download lands in (<tmp>/epub<random>.epub).
// Everything else -- exit code, console text, and the report tap -- must be
// identical between two runs of the same input, which is the reuse invariant.
function norm(s: string): string {
  return s
    .replaceAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\.epubcheck\.w3c\.org)/g, 'UUID')
    .replaceAll(/\/(?:private\/)?(?:var|tmp)\/[^\s"()]*?epub\d+\.epub/g, '/TMP/epub.epub');
}
function sig(r: EpubCheckResult): string {
  return norm(
    JSON.stringify({
      exitCode: r.exitCode,
      stdout: r.stdout,
      stderr: r.stderr,
      messages: r.messages,
      features: r.features,
    }),
  );
}
// A directory input additionally reports each file's filesystem timestamp
// (CREATION_DATE / MODIFIED_DATE info events) which the OS clock makes vary
// between reads -- inherent, not a reuse effect (packaged .epub inputs read
// fixed ZIP timestamps and have none of this). Strip *_DATE info VALUES so the
// dir comparison tests the reuse invariant, not the wall clock.
function sigNoDates(r: EpubCheckResult): string {
  const features = r.features.map((i) =>
    typeof i.feature === 'string' && i.feature.endsWith('_DATE') ? { ...i, value: '<date>' } : i,
  );
  return norm(
    JSON.stringify({ exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, messages: r.messages, features }),
  );
}

const A = join(fixtures, 'test_bad.epub'); // 2 errors (RSC-005 + RSC-007)
const CLEAN = join(fixtures, 'test.epub'); // clean

const tmpRoot = mkdtempSync(join(tmpdir(), 'epubcheck-reuse-'));
try {
  // --- 1. same file, twice, back to back ------------------------------------
  console.log('same file validated twice in one thread:');
  const a1 = await validateFile(A);
  const a2 = await validateFile(A);
  check('run 1 is the known-bad result (exit 1)', a1.exitCode === 1, `exit ${a1.exitCode}`);
  check('run 2 byte-identical to run 1', sig(a2) === sig(a1));

  // --- 2. a DIFFERENT file in between, then the first again ------------------
  console.log('\ninterleaved with a different file:');
  const clean = await validateFile(CLEAN);
  check('clean file is valid (exit 0)', clean.exitCode === 0, `exit ${clean.exitCode}`);
  const a3 = await validateFile(A);
  check('re-run after a different book is still byte-identical', sig(a3) === sig(a1));
  const clean2 = await validateFile(CLEAN);
  check('clean re-run byte-identical', sig(clean2) === sig(clean));

  // --- 3. customMessages override, twice ------------------------------------
  console.log('\ncustomMessages override, reused:');
  const overrides = new TextEncoder().encode('RSC-005\tSUPPRESSED\n'); // hide RSC-005
  const cm1 = await validateFile(A, { customMessages: overrides });
  const cm2 = await validateFile(A, { customMessages: overrides });
  check('customMessages run is deterministic across reuse', sig(cm1) === sig(cm2));
  check('customMessages actually changed the output vs plain', sig(cm1) !== sig(a1));
  check(
    'suppressing RSC-005 drops it from messages',
    !cm1.messages.some((m) => m.id === 'RSC-005') && a1.messages.some((m) => m.id === 'RSC-005'),
  );
  // ...and a plain run AFTER a customMessages run is unaffected (feed cleared).
  const a4 = await validateFile(A);
  check('plain re-run after customMessages is byte-identical to the original plain run', sig(a4) === sig(a1));

  // --- 4. expanded directory (dirMode: 'exp' packaging), twice --------------
  // Explicit 'exp': the library default is 'direct', which errors "Mode
  // required" on a non-`.epub`-named directory like `minimal`. The reuse
  // invariant (deterministic output, no feed leakage) is mode-agnostic.
  console.log('\nexpanded directory (exp packaging), reused:');
  {
    const src = join(corpus, 'epubcheck-prezipped', 'epub3_00-minimal_files_minimal.epub');
    const dir = join(tmpRoot, 'minimal');
    mkdirSync(dir);
    const unzip = spawnSync('unzip', ['-q', src, '-d', dir], { encoding: 'utf8' });
    check('unzip of the corpus book succeeds', unzip.status === 0, unzip.stderr || String(unzip.status));
    const d1 = await validateDirectory(dir, { dirMode: 'exp' });
    const d2 = await validateDirectory(dir, { dirMode: 'exp' });
    check('directory input is valid (exit 0)', d1.exitCode === 0, `exit ${d1.exitCode}`);
    check('directory run is deterministic across reuse', sigNoDates(d1) === sigNoDates(d2));
    // ...and a plain file run after a directory run is unaffected (feed cleared).
    const a5 = await validateFile(A);
    check('plain file re-run after a directory run is byte-identical', sig(a5) === sig(a1));
  }

  // --- 5. http(s) URL input, twice ------------------------------------------
  console.log('\nURL input (local server), reused:');
  const bytes = readFileSync(A);
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/epub+zip', 'content-length': String(bytes.length) });
    res.end(bytes);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const url = `http://127.0.0.1:${port}/test_bad.epub`;
  try {
    // The url() plugin downloads with fetch (async, non-blocking), so a URL run
    // can share this thread with the server above -- no off-thread dance needed.
    // Two runs must match; the download is fed as in-memory bytes, so there is no
    // random temp path either.
    const u1 = await validate(await urlSource(url));
    const u2 = await validate(await urlSource(url));
    check('URL input reports errors (exit 1)', u1.exitCode === 1, `exit ${u1.exitCode}`);
    check('URL input run is deterministic across reuse', sig(u1) === sig(u2));
    // a plain file run after a URL run is unaffected
    const a6 = await validateFile(A);
    check('plain file re-run after a URL run is byte-identical', sig(a6) === sig(a1));
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
} finally {
  rmSync(tmpRoot, { recursive: true, force: true });
}

console.log('');
if (failures) {
  console.error(`REUSE SUITE FAILED: ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log('REUSE SUITE PASSED');
