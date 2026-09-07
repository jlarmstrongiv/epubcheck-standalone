#!/usr/bin/env node
// URL-input parity suite: serve corpus books over a local HTTP server, run the
// engine (validate(await url(...)) -> the URL as epubcheck's input arg + the
// async __epubHttpGet/__epubHttpRead bridge, on which the engine SUSPENDS at
// its TeaVM @Async seam -> the shadowed URLResourceProvider, see
// teavm/shims/src-teavm/ecshim/HostHttp.java) and the REAL epubcheck.jar
// against the SAME URLs, and assert byte-identical output (with one precisely
// pinned normalization). This restores the wasm-era jar-parity suite (commit
// 610d605); the fetch-then-validate-basename behavior of the interim TeaVM
// port is gone.
//
//   node test/url.ts
//
// WHAT IS AND IS NOT REPRODUCIBLE (pinned here, on purpose):
//  - Success runs: stdout and stderr are byte-identical EXCEPT for one token.
//    Both the jar and the engine name the download after a RANDOM temp file
//    (java.io.File.createTempFile("epub", ".epub") -- the stock code path on
//    both sides), and messages located on the container file itself (e.g.
//    PKG-010) embed that path: the jar prints <TMPDIR>/epub<random>.epub, the
//    engine prints /tmp/epub<random>.epub in its VFS (which stays EMPTY: the
//    engine range-reads the body off the host bridge instead of copying it).
//    The suite normalizes exactly that token on both sides and asserts nothing
//    else differs.
//  - Failure runs (404, connection refused): the exception HEADLINE lines
//    ("java.lang.RuntimeException: java.io.FileNotFoundException: <url>",
//    "Caused by: java.net.ConnectException: Connection refused") and stdout
//    and the exit code are byte-identical. The stack FRAMES under them are
//    runtime internals (JDK socket frames vs TeaVM function frames) and are
//    filtered out on both sides.
//  - Redirects: both sides follow the same-protocol redirect and report
//    locations under the ORIGINAL (redirecting) URL. (A protocol-switching
//    http->https redirect would diverge -- the jar stops at the 3xx --
//    documented in HostHttp.java, not covered here.)
//
// Like test/flags.ts, the suite SKIPs cleanly (exit 0) when the epubcheck
// release or a java binary is absent. Set EPUBCHECK_REQUIRE_JAR=1 to turn that
// skip into a FAILURE instead.

import { validate } from '../dist/index.js';
import { url } from '../dist/plugins.js';
import type { EpubCheckResult } from '../dist/index.js';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = dirname(here);

// --- locate the jar + java (same rules as test/flags.ts) ---------------------
function findJar(): string | null {
  const buildDir = join(pkgRoot, 'build');
  if (!existsSync(buildDir)) return null;
  for (const entry of readdirSync(buildDir).sort()) {
    if (!entry.startsWith('epubcheck-')) continue;
    const jar = join(buildDir, entry, 'epubcheck.jar');
    if (existsSync(jar)) return jar;
  }
  return null;
}

function findJava(): string[] | null {
  const candidates: string[][] = [['mise', 'exec', '--', 'java'], ['java']];
  for (const c of candidates) {
    const r = spawnSync(c[0] as string, [...c.slice(1), '-version'], { encoding: 'utf8' });
    if (r.status === 0) return c;
  }
  return null;
}

const jar = findJar();
const java = findJava();
if (!jar || !java) {
  const why = !jar
    ? 'epubcheck.jar not found under build/epubcheck-*/ (run: npm run build:deps)'
    : 'no working java binary (mise exec -- java, or PATH)';
  if (process.env.EPUBCHECK_REQUIRE_JAR === '1') {
    console.error(`URL SUITE FAILED: EPUBCHECK_REQUIRE_JAR=1 but ${why}`);
    process.exit(1);
  }
  console.log(`URL SUITE SKIPPED: ${why}`);
  process.exit(0);
}
const javaCmd = java;

let failures = 0;
function check(name: string, cond: unknown, detail?: string): void {
  if (cond) {
    console.log(`  ok  - ${name}`);
  } else {
    failures++;
    console.log(`  NOT OK - ${name}${detail ? ': ' + detail : ''}`);
  }
}

interface Side { exit: number | null; stdout: string; stderr: string; }

function toSide(result: EpubCheckResult): Side {
  return { exit: result.exitCode, stdout: result.stdout, stderr: result.stderr };
}

// SAME THREAD, on purpose: the engine SUSPENDS at its TeaVM @Async seam while
// the async http bridge fetches, so the event loop stays free -- the local
// HTTP server living in THIS process answers the engine's own download. This
// is the async design's regression test: under the old synchronous bridge
// this call pattern deadlocked (Atomics.wait starved the server) and the
// suite had to run every validation in a child-process pool.
async function validateUrlSameThread(target: string): Promise<EpubCheckResult> {
  return validate(await url(target));
}

// ASYNC on purpose: the HTTP server the jar downloads from lives in THIS
// process, so a spawnSync here would block the event loop the server needs to
// answer the jar's request -- a deadlock. (findJava's spawnSync above is fine:
// no server exists yet when it runs.)
function runJar(target: string, args: string[] = []): Promise<Side> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      javaCmd[0] as string,
      [...javaCmd.slice(1), '-jar', jar as string, ...args, target],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (exit) => resolvePromise({ exit, stdout, stderr }));
  });
}

// --- the pinned normalizations (see the header comment) ----------------------

/**
 * Normalize the ONE unreproducible token of success runs: the random temp file
 * the download is named after. Jar: <TMPDIR>/epub<random>.epub (macOS
 * /var/folders/... or /tmp/... on Linux); engine: /tmp/epub<random>.epub in
 * its VFS. The pattern is anchored on the temp roots and the
 * epub<digits>.epub basename so it can never touch the URL itself.
 */
function normalizeTempDownload(text: string): string {
  return text.replace(
    /\/(?:private\/)?(?:var|tmp)\/[^\s()]*?epub\d+\.epub/g,
    '/TMP/epub.epub',
  );
}

/** Keep only the reproducible stderr lines of a FAILURE run: drop stack frames. */
function stripFrames(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/^\s+at /.test(line) && !/^\s*\.\.\. \d+ more$/.test(line))
    .join('\n');
}

function checkSuccessParity(label: string, engine: Side, native: Side): void {
  check(`${label}: exit codes match`, engine.exit === native.exit, `engine=${engine.exit} jar=${native.exit}`);
  const nStdout = [normalizeTempDownload(engine.stdout), normalizeTempDownload(native.stdout)];
  const nStderr = [normalizeTempDownload(engine.stderr), normalizeTempDownload(native.stderr)];
  check(`${label}: stdout is byte-identical (temp path normalized)`, nStdout[0] === nStdout[1],
    `\n--- jar ---\n${nStdout[1]}\n--- engine ---\n${nStdout[0]}`);
  check(`${label}: stderr is byte-identical (temp path normalized)`, nStderr[0] === nStderr[1],
    `\n--- jar ---\n${nStderr[1]}\n--- engine ---\n${nStderr[0]}`);
  check(`${label}: no unnormalized temp token remains`,
    !/epub\d{6,}\.epub/.test(nStdout[0] + nStderr[0] + nStdout[1] + nStderr[1]));
}

function checkFailureParity(label: string, engine: Side, native: Side): void {
  check(`${label}: exit codes match`, engine.exit === native.exit, `engine=${engine.exit} jar=${native.exit}`);
  check(`${label}: stdout is byte-identical`, engine.stdout === native.stdout,
    `\n--- jar ---\n${native.stdout}\n--- engine ---\n${engine.stdout}`);
  const [w, n] = [stripFrames(engine.stderr), stripFrames(native.stderr)];
  check(`${label}: stderr headlines are byte-identical (frames stripped)`, w === n,
    `\n--- jar ---\n${n}\n--- engine ---\n${w}`);
}

// --- the local HTTP server ---------------------------------------------------
const corpus = join(here, 'corpus');
const BOOKS: Record<string, string> = {
  '/book.epub': join(corpus, 'epubcheck-expanded', 'cli__files__20-severity-tester.epub'),
  '/clean.epub': join(corpus, 'epubcheck-expanded', 'cli__files__30-valid-test.epub'),
};

const server: Server = createServer((req, res) => {
  const path = req.url ?? '/';
  if (path === '/redirect.epub') {
    res.writeHead(302, { Location: '/book.epub' });
    res.end();
    return;
  }
  const file = BOOKS[path];
  if (!file) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found\n');
    return;
  }
  const bytes = readFileSync(file);
  res.writeHead(200, { 'Content-Type': 'application/epub+zip', 'Content-Length': bytes.length });
  res.end(bytes);
});
await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;

// A port with NOTHING listening (bound once to reserve, then released).
const refusedPort: number = await new Promise((resolvePromise) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => {
    const p = (s.address() as { port: number }).port;
    s.close(() => resolvePromise(p));
  });
});

try {
  // --- 1. a book with messages ----------------------------------------------
  console.log('URL input, book with messages:');
  {
    const target = `${base}/book.epub`;
    const native = await runJar(target);
    const engine = toSide(await validateUrlSameThread(target));
    checkSuccessParity('book.epub', engine, native);
    check('book.epub: locations carry the URL prefix',
      engine.stderr.includes(`ERROR(OPF-049): ${target}/OPS/package.opf`), engine.stderr);
  }

  // --- 2. a clean book (exit 0) ---------------------------------------------
  console.log('\nURL input, clean book:');
  {
    const target = `${base}/clean.epub`;
    const native = await runJar(target);
    const engine = toSide(await validateUrlSameThread(target));
    checkSuccessParity('clean.epub', engine, native);
    check('clean.epub: exit 0', engine.exit === 0, `got ${engine.exit}`);
  }

  // --- 3. a same-protocol redirect ------------------------------------------
  console.log('\nURL input, same-protocol redirect:');
  {
    const target = `${base}/redirect.epub`;
    const native = await runJar(target);
    const engine = toSide(await validateUrlSameThread(target));
    checkSuccessParity('redirect.epub', engine, native);
    check('redirect.epub: locations carry the ORIGINAL (redirecting) URL',
      engine.stderr.includes(`${target}/OPS/package.opf`), engine.stderr);
  }

  // --- 4. 404 ----------------------------------------------------------------
  console.log('\nURL input, 404:');
  {
    const target = `${base}/missing.epub`;
    const native = await runJar(target);
    const engine = toSide(await validateUrlSameThread(target));
    checkFailureParity('404', engine, native);
    check('404: FileNotFoundException headline names the URL',
      engine.stderr.startsWith(`java.lang.RuntimeException: java.io.FileNotFoundException: ${target}`),
      engine.stderr);
  }

  // --- 5. connection refused --------------------------------------------------
  console.log('\nURL input, connection refused:');
  {
    const target = `http://127.0.0.1:${refusedPort}/nothing.epub`;
    const native = await runJar(target);
    const engine = toSide(await validateUrlSameThread(target));
    checkFailureParity('refused', engine, native);
    check('refused: ConnectException headline matches',
      engine.stderr.includes('java.net.ConnectException: Connection refused'),
      engine.stderr);
  }

  // --- 6. API guards -----------------------------------------------------------
  console.log('\nAPI guards:');
  {
    let msg = '';
    await url('./local.epub').catch((err: Error) => { msg = err.message; });
    check('url() rejects a local path', /not an http\(s\) URL/.test(msg), msg);
  }
} finally {
  await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
}

// --- verdict -----------------------------------------------------------------
console.log('');
if (failures) {
  console.error(`URL SUITE FAILED: ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log('URL SUITE PASSED');
