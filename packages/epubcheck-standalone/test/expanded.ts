#!/usr/bin/env node
// Expanded (directory / --mode exp) suite.
//
//   node test/expanded.ts
//
// Part 1 (always run) exercises the directory-source PLUGIN contract
// (memoryDir / fsDir listing, reads, path-safety rejections, file-vs-directory
// errors) -- pure JS, no engine.
//
// Part 2 unzips a corpus book and validates the DIRECTORY through the engine
// (epubcheck's `--mode exp`), asserting a clean, complete run. Directory
// support needed three shim fixes (a real java.nio.channels.FileChannel over
// the VFS for commons-compress's zip writer, the JDK-correct CharsetEncoder
// replacement check, and non-virtual ZipEntry time accessors -- see
// agent-docs/teavm-fixes.md); this assertion keeps them honest.

import { validate } from '../dist/index.js';
import { fsDir, memoryDir } from '../dist/plugins.js';
import type { FsDirBackend } from '../dist/plugins.js';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  openSync,
  fstatSync,
  readSync,
  closeSync,
  statSync,
  readdirSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

let failures = 0;
function check(name: string, cond: unknown, detail?: string): void {
  if (cond) {
    console.log(`  ok  - ${name}`);
  } else {
    failures++;
    console.log(`  NOT OK - ${name}${detail ? ': ' + detail : ''}`);
  }
}

async function rejects(fn: () => Promise<unknown> | unknown, match: RegExp): Promise<string | null> {
  try {
    await fn();
    return 'did not throw';
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return match.test(message) ? null : `threw the wrong error: ${message}`;
  }
}

// Polyfill-safe dispose key (same key the plugins register under).
const disposeKey: typeof Symbol.dispose =
  Symbol.dispose ?? (Symbol.for('Symbol.dispose') as typeof Symbol.dispose);

// --- 1. Directory-plugin contract (no engine) --------------------------------
console.log('directory-source contract:');
{
  const tree = new Map<string, Uint8Array>([
    ['mimetype', new TextEncoder().encode('application/epub+zip')],
    ['EPUB/nested/file.bin', new Uint8Array([1, 2, 3, 4, 5])],
  ]);
  const source = memoryDir(tree);
  const listing = source.list();
  check('memoryDir: lists every file with sizes (sorted)',
    JSON.stringify(listing) === JSON.stringify([
      { path: 'EPUB/nested/file.bin', size: 5 },
      { path: 'mimetype', size: 20 },
    ]), JSON.stringify(listing));
  // memoryDir reads synchronously (the contract also admits promise-returning
  // reads; the sync plugins never use them).
  const range = source.read('EPUB/nested/file.bin', 1, 3) as Uint8Array;
  check('memoryDir: reads exactly the requested range',
    JSON.stringify(Array.from(range)) === JSON.stringify([2, 3, 4]));

  for (const bad of ['../escape', '/absolute', 'a/../b', 'a//b', 'a\\b', '.']) {
    check(`memoryDir: rejects unsafe path "${bad}"`,
      (await rejects(() => memoryDir(new Map([[bad, new Uint8Array(0)]])), /unsafe relative path/)) === null);
  }

  check('fsDir: rejects a FILE where a directory is required',
    (await rejects(() => fsDir(join(here, 'fixtures', 'test.epub')), /is not a directory/)) === null);

  const fixturesSource = await fsDir(join(here, 'fixtures'));
  const paths = fixturesSource.list().map((entry) => entry.path);
  check('fsDir: walks a directory (sorted listing)',
    paths.includes('test.epub') && paths.includes('content.xhtml') &&
      JSON.stringify(paths) === JSON.stringify([...paths].sort()),
    paths.join(', '));
  check('fsDir: carries the directory name', fixturesSource.name === 'fixtures', fixturesSource.name);
  fixturesSource[disposeKey]();
}

// --- 2. Expanded validation through the engine -------------------------------
console.log('\nexpanded (--mode exp) directory validation:');
{
  const src = join(here, 'corpus', 'epubcheck-prezipped', 'epub3_00-minimal_files_minimal.epub');
  check('unzip binary is available', spawnSync('unzip', ['-v'], { encoding: 'utf8' }).status === 0);
  check('corpus book exists', existsSync(src), src);
  const tmp = mkdtempSync(join(tmpdir(), 'epubcheck-exp-'));
  try {
    const dir = join(tmp, 'minimal');
    mkdirSync(dir);
    spawnSync('unzip', ['-q', src, '-d', dir], { encoding: 'utf8' });
    // Explicit dirMode: 'exp' exercises the zip-WRITER shim fixes (the library
    // default is 'direct', which validates in place and never packages).
    const r = await validate(await fsDir(dir), { dirMode: 'exp' });
    check('expanded validation succeeds (exit 0)', r.exitCode === 0, `exit=${r.exitCode}`);
    check('the engine really validated (version line present)',
      /Validating using EPUB version/.test(r.stdout), r.stdout.slice(0, 200));
    check('clean book reports no errors or warnings',
      /No errors or warnings detected/.test(r.stdout), r.stdout.slice(0, 200));

    // ASYNC directory source: same directory, but every read resolves through a
    // promise, so the engine must SUSPEND at its HostDir @Async seam for each
    // cache-miss block and still produce identical output to the sync run.
    // The baseline is a genuine SYNCHRONOUS fsDir source: a sync-only injected
    // backend (the six FsDirLike calls, no promise-based open) makes fsDir take
    // its sync fallback path, so `sync.read` returns a Uint8Array inline. The
    // wrapper then hands those bytes over through a promise.
    const syncOnlyBackend: FsDirBackend = {
      openSync: (p: string, flags: 'r') => openSync(p, flags),
      fstatSync: (fd: number) => ({ size: fstatSync(fd).size }),
      readSync: (fd: number, buffer: Uint8Array, offset: number, length: number, position: number) =>
        readSync(fd, buffer, offset, length, position),
      closeSync: (fd: number) => closeSync(fd),
      readdirSync: (p: string, options: { withFileTypes: true }) => readdirSync(p, options),
      statSync: (p: string) => {
        const s = statSync(p);
        return { size: s.size, isDirectory: () => s.isDirectory() };
      },
    };
    const sync = await fsDir(dir, { fs: syncOnlyBackend });
    const asyncSource = {
      name: sync.name,
      list: () => sync.list(),
      read: (path: string, offset: number, length: number) => {
        const bytes = sync.read(path, offset, length) as Uint8Array;
        // Copy: the sync plugin's scratch view is only valid until its next
        // read, and a promise hands the view over asynchronously.
        return Promise.resolve(bytes.slice());
      },
      [disposeKey]() { sync[disposeKey](); },
    };
    const ra = await validate(asyncSource, { dirMode: 'exp' });
    check('async directory source: identical exit code', ra.exitCode === r.exitCode,
      `sync=${r.exitCode} async=${ra.exitCode}`);
    check('async directory source: identical stdout', ra.stdout === r.stdout,
      ra.stdout.slice(0, 200));
    check('async directory source: identical stderr', ra.stderr === r.stderr,
      ra.stderr.slice(0, 200));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// --- 3. Empty-directory input (parity-audit Gap D) ---------------------------
// An EMPTY directory is a real directory: under dirMode: 'exp' epubcheck
// packages it into an empty zip and reports ERROR(PKG-003) + FATAL(RSC-002) on
// that package, exit 1 -- verified byte-for-byte against the jar. (The engine
// once claimed "Directory not found" because the wrapper skipped mounting a
// root for an empty listing.) dirMode is explicit here because the library
// default is now 'direct'.
console.log('\nempty-directory input (jar-parity PKG-003 + RSC-002):');
{
  const tmp = mkdtempSync(join(tmpdir(), 'epubcheck-empty-'));
  try {
    const dir = join(tmp, 'emptydir');
    mkdirSync(dir);
    const r = await validate(await fsDir(dir), { dirMode: 'exp' });
    check('empty dir: exit 1', r.exitCode === 1, `exit=${r.exitCode}`);
    check(
      'empty dir: PKG-003 reported',
      /ERROR\(PKG-003\): \.\/emptydir\.epub\(-1,-1\)/.test(r.stderr),
      r.stderr,
    );
    check(
      'empty dir: RSC-002 reported',
      /FATAL\(RSC-002\): \.\/emptydir\.epub\(-1,-1\)/.test(r.stderr),
      r.stderr,
    );
    check('empty dir: no "Directory not found"', !/Directory not found/.test(r.stderr), r.stderr);
    check(
      'empty dir: both messages structured',
      r.messages.length === 2 && r.messages[0]?.id === 'PKG-003' && r.messages[1]?.id === 'RSC-002',
      JSON.stringify(r.messages),
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// --- 4. Direct directory mode (dirMode: 'direct', parity-audit Gap E) --------
// The jar's AUTO-DETECTED expanded book (a `.epub`-named directory handed over
// with no --mode) is validated IN PLACE: locations carry the directory name
// itself (`junk.epub/mimetype`), never a doubled `junk.epub.epub` package
// name. The assertions below are frozen from byte-identical live-jar runs
// (the CLI's edge.test.ts re-verifies against the live jar).
console.log("\ndirect directory mode (dirMode: 'direct'):");
{
  const src = memoryDir(new Map([['stray.txt', new TextEncoder().encode('not an epub\n')]]));
  const r = await validate(src, { name: 'junk.epub', dirMode: 'direct' });
  check('direct: exit 1', r.exitCode === 1, `exit=${r.exitCode}`);
  check(
    'direct: PKG-006 under the directory name itself',
    /ERROR\(PKG-006\): junk\.epub\/mimetype\(-1,-1\)/.test(r.stderr),
    r.stderr,
  );
  check(
    'direct: RSC-002 under the directory name itself',
    /FATAL\(RSC-002\): junk\.epub\/\.\/junk\.epub\/\(-1,-1\)/.test(r.stderr),
    r.stderr,
  );
  check(
    'direct: no doubled .epub.epub anywhere',
    !/junk\.epub\.epub/.test(r.stdout + r.stderr),
    r.stderr,
  );

  // The library DEFAULT is now 'direct': omitting dirMode must produce the
  // exact same bytes as an explicit dirMode: 'direct' over the same tree.
  const def = await validate(
    memoryDir(new Map([['stray.txt', new TextEncoder().encode('not an epub\n')]])),
    { name: 'junk.epub' },
  );
  check('default dirMode == explicit direct (exit)', def.exitCode === r.exitCode, `default=${def.exitCode} direct=${r.exitCode}`);
  check('default dirMode == explicit direct (stdout)', def.stdout === r.stdout, def.stdout.slice(0, 200));
  check('default dirMode == explicit direct (stderr)', def.stderr === r.stderr, def.stderr.slice(0, 200));
}

// --- 5. Non-`.epub`-named directory under the default (direct) mode ----------
// A directory that is NOT named `*.epub` (e.g. `minimal/`), handed to the jar
// with no --mode and no --profile, never validates: epubcheck's CLI
// argument-processing prints "Mode required for non-epub files. Default version
// is 3.0." to STDOUT (a plain println, NOT a coded message) and exits 1 -- see
// EpubChecker.processArguments (`path.matches(".+\\.[Ee][Pp][Uu][Bb]")` else
// `mode == null && profile == null`). Verified byte-for-byte against the live
// 5.3.0 jar (`java -jar epubcheck.jar minimal`): stdout is exactly that line,
// stderr empty, exit 1. Because dirMode 'direct' hands the engine the bare
// directory NAME with no mode, the library reproduces this exactly -- and since
// 'direct' is now the DEFAULT, omitting dirMode must produce the same bytes.
// (The CLI's edge.test.ts re-verifies this against the live jar side by side.)
console.log("\nnon-`.epub`-named directory (direct/default -> mode_required):");
{
  const MODE_REQUIRED = 'Mode required for non-epub files. Default version is 3.0.\n';
  const mk = () => memoryDir(new Map([['stray.txt', new TextEncoder().encode('not an epub\n')]]));
  const direct = await validate(mk(), { name: 'minimal', dirMode: 'direct' });
  check('non-epub dir (direct): exit 1', direct.exitCode === 1, `exit=${direct.exitCode}`);
  check('non-epub dir (direct): mode_required on stdout', direct.stdout === MODE_REQUIRED, JSON.stringify(direct.stdout));
  check('non-epub dir (direct): empty stderr', direct.stderr === '', JSON.stringify(direct.stderr));
  check('non-epub dir (direct): no coded messages (plain println)', direct.messages.length === 0, JSON.stringify(direct.messages));

  // The library DEFAULT is now 'direct': omitting dirMode must produce the exact
  // same bytes as an explicit dirMode: 'direct' over the same non-epub-named tree.
  const def = await validate(mk(), { name: 'minimal' });
  check('non-epub dir default == explicit direct (exit)', def.exitCode === direct.exitCode, `default=${def.exitCode} direct=${direct.exitCode}`);
  check('non-epub dir default == explicit direct (stdout)', def.stdout === direct.stdout, JSON.stringify(def.stdout));
  check('non-epub dir default == explicit direct (stderr)', def.stderr === direct.stderr, JSON.stringify(def.stderr));
  check('non-epub dir default: mode_required on stdout', def.stdout === MODE_REQUIRED, JSON.stringify(def.stdout));
}

// --- verdict -----------------------------------------------------------------
console.log('');
if (failures) {
  console.error(`EXPANDED SUITE FAILED: ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log('EXPANDED SUITE PASSED');
