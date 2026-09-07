#!/usr/bin/env node
// Cancellation-during-suspension suite: prove abort survives the async
// suspension points the engine grew when it became async-first.
//
//   node test/abort-suspension.ts
//
// The sibling test/abort.ts already samples abort at the host seams. What it
// does NOT pin is the SPECIFIC interleaving this suite exists for:
//
//   the AbortSignal (or timeout) fires WHILE the engine is SUSPENDED on a
//   feed promise that has NOT settled yet, and the promise settles a clear
//   macrotask gap AFTER the abort.
//
// That is the exact window engine-run.ts's resume-boundary re-check owns:
//   - __ecRead / __ecDirRead settle through `consume` (engine-run.ts), whose
//     RESOLVE handler re-samples the signal via throwIfAborted() at the resume
//     boundary (engine-run.ts, "Re-sample the signal at the resume boundary")
//     and whose REJECT handler rethrows the read error into the engine;
//   - the post-settle checks in runOnce (the catch after main() and the check
//     before `completed = true`) force a DETERMINISTIC rejection with the abort
//     reason whenever the signal aborted before the run settled -- keyed off
//     `signal.aborted`, so it wins even when the injected read error was
//     swallowed into a FATAL result OR surfaced as an engine error.
//
// Every case here drives the REAL engine through the public validate() over a
// real plugin (fs / fsDir / url), with a read promise whose settle timing this
// suite controls, so the abort provably lands mid-suspension and the promise
// provably settles afterwards. Required behavior proven per case: the run
// rejects with the signal's reason, the aborted engine scope is NOT reused,
// and a fresh validate() on the same thread works afterwards.
//
// NOT a pass/fail case (recorded known limitation, engine review finding 2,
// owner-visible): a feed promise for __ecRead/__ecDirRead that NEVER settles
// leaves the engine's green thread parked at its @Async seam forever -- those
// two seams re-sample the signal only at the RESUME boundary (when the promise
// settles), so a never-settling read is uninterruptible by an abort. It is
// documented as a SKIPPED case at the bottom, not exercised.

import { readFileSync, readdirSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { open as fspOpen, readdir as fspReaddir, stat as fspStat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import type { Server, ServerResponse } from 'node:http';
import { validate } from '../dist/index.js';
import { fs as fsSource, fsDir, url } from '../dist/plugins.js';
import type { FsBackend, FsDirBackend } from '../dist/plugins.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, 'fixtures');
const CLEAN = join(fixtures, 'test.epub');
const BAD = join(fixtures, 'test_bad.epub');
const badBytes = readFileSync(BAD);
const cleanBytes = readFileSync(CLEAN);
const g = globalThis as unknown as Record<string, unknown>;

let failures = 0;
function check(name: string, cond: unknown, detail?: string): void {
  if (cond) {
    console.log(`  ok  - ${name}`);
  } else {
    failures++;
    console.log(`  NOT OK - ${name}${detail ? ': ' + detail : ''}`);
  }
}

// Any unhandled rejection is a failure: an aborted run must reject exactly once
// into its caller and leak no dangling read/settle promises.
process.on('unhandledRejection', (err) => {
  failures++;
  console.log(`  NOT OK - unhandled rejection: ${String(err)}`);
});

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}
function isTimeoutError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'TimeoutError';
}
async function rejectionOf(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
    return null;
  } catch (err) {
    return err;
  }
}
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// The shared feed keys engine-run.ts owns; all must be absent after any run
// (the same airtight-finally invariant the abort/engine-error suites guard).
const FEED_KEYS = [
  '__ecSize',
  '__ecRead',
  '__epubName',
  '__epubArgs',
  '__ecExtraPaths',
  '__ecExtraB64',
  '__ecInputArg',
  '__ecDirPaths',
  '__ecDirSizes',
  '__ecDirRead',
  '__epubHttpGet',
  '__epubHttpRead',
  '__ecTapMessage',
  '__ecTapInfo',
  '__ecPlain',
  '__ecRelArg',
  '__ecTZ',
  '__ecJson',
  '__ecExit',
  '__ecFile',
] as const;
function checkFeedsCleared(label: string): void {
  for (const k of FEED_KEYS) {
    check(`${label}: feed ${k} cleared`, g[k] === undefined, `still ${String(g[k])}`);
  }
}

const DISPOSE: typeof Symbol.dispose =
  Symbol.dispose ?? (Symbol.for('Symbol.dispose') as typeof Symbol.dispose);

const READ_ERR = 'backend read exploded a full macrotask AFTER the abort fired';

// A promises-only fs backend (node:fs/promises FileHandle shape, no sync fd
// methods -> the fs() plugin uses its async suspend path). On its FIRST read
// the engine is already SUSPENDED on the returned promise; this backend then
// interleaves by hand: it fires `duringPending` (abort, or nothing for the
// timeout cases) while the promise is STILL pending, waits a clear macrotask
// gap so the engine stays suspended across it, and only THEN settles -- by
// resolving with the real bytes ('resolve') or throwing ('reject'). Every await
// lives inside this async body, so the promise the engine awaits stays pending
// until the settle and nothing floats.
function gatedFsBackend(opts: {
  settle: 'resolve' | 'reject';
  duringPending: () => void;
  onFirstRead?: () => void;
  counters: { reads: number };
}): FsBackend {
  let armed = true;
  return {
    open: async (path: string, flags: 'r') => {
      const fh = await fspOpen(path, flags);
      return {
        stat: async () => ({ size: (await fh.stat()).size }),
        read: async (buffer: Uint8Array, offset: number, length: number, position: number) => {
          opts.counters.reads++;
          if (armed) {
            armed = false;
            if (opts.onFirstRead) opts.onFirstRead();
            // The engine is SUSPENDED on this pending read now.
            await delay(25); // let the suspension settle in
            opts.duringPending(); // T1: fire while the read is STILL pending
            await delay(25); // T2 is a clear macrotask gap AFTER T1
            if (opts.settle === 'reject') throw new Error(READ_ERR);
          }
          const r = await fh.read(buffer, offset, length, position);
          return { bytesRead: r.bytesRead };
        },
        close: async () => {
          await fh.close();
        },
      };
    },
  };
}

// The fsDir sibling of the backend above: a promises-only directory backend
// (async readdir/stat walk + FileHandle reads -> fsDir()'s async suspend path).
// Same first-read interleaving as gatedFsBackend.
function gatedFsDirBackend(opts: {
  settle: 'resolve' | 'reject';
  duringPending: () => void;
  counters: { reads: number };
}): FsDirBackend {
  let armed = true;
  return {
    open: async (path: string, flags: 'r') => {
      const fh = await fspOpen(path, flags);
      return {
        stat: async () => ({ size: (await fh.stat()).size }),
        read: async (buffer: Uint8Array, offset: number, length: number, position: number) => {
          opts.counters.reads++;
          if (armed) {
            armed = false;
            await delay(25);
            opts.duringPending(); // T1
            await delay(25); // T2 gap
            if (opts.settle === 'reject') throw new Error(READ_ERR);
          }
          const r = await fh.read(buffer, offset, length, position);
          return { bytesRead: r.bytesRead };
        },
        close: async () => {
          await fh.close();
        },
      };
    },
    readdir: async (p: string, o: { withFileTypes: true }) => fspReaddir(p, o),
    stat: async (p: string) => {
      const s = await fspStat(p);
      return { size: s.size, isDirectory: () => s.isDirectory() };
    },
  };
}

// ============================================================================
// 1 + 2. fs() over a promises backend: abort mid-suspension, then the pending
//        read settles (resolve, then reject).
// ============================================================================

console.log('fs() range feed -- abort while a read promise is pending, RESOLVE after (case 1):');
{
  const controller = new AbortController();
  const counters = { reads: 0 };
  const backend = gatedFsBackend({
    settle: 'resolve',
    duringPending: () => controller.abort(),
    counters,
  });
  const err = await rejectionOf(
    validate(await fsSource(BAD, { fs: backend }), { signal: controller.signal }),
  );
  check('reached the read (engine suspended before abort)', counters.reads > 0, `reads=${counters.reads}`);
  check('rejects with AbortError once the pending read RESOLVED after abort', isAbortError(err), String(err));
  checkFeedsCleared('case 1');

  // Fresh validate() on the same thread works (aborted scope discarded, cold start).
  const after = await validate(await fsSource(CLEAN));
  check('clean re-validate after the abort is valid (exit 0)', after.exitCode === 0, `exit=${after.exitCode}`);
}

console.log('\nfs() range feed -- abort while a read promise is pending, REJECT after (case 2):');
{
  // The pending read REJECTS a full macrotask after the abort. engine-run.ts's
  // consume() REJECT handler rethrows READ_ERR into the engine (no re-sample on
  // that path), but the post-settle checks key off signal.aborted, so the
  // ABORT REASON is what surfaces -- deterministically -- never the read error.
  const controller = new AbortController();
  const counters = { reads: 0 };
  const backend = gatedFsBackend({
    settle: 'reject',
    duringPending: () => controller.abort(),
    counters,
  });
  const err = await rejectionOf(
    validate(await fsSource(BAD, { fs: backend }), { signal: controller.signal }),
  );
  check('reached the read (engine suspended before abort)', counters.reads > 0, `reads=${counters.reads}`);
  check('rejects with the ABORT REASON, not the read error', isAbortError(err), String(err));
  check(
    'the read error (READ_ERR) is NOT what surfaced',
    !(err instanceof Error && err.message === READ_ERR),
    String(err),
  );
  checkFeedsCleared('case 2');

  const after = await validate(await fsSource(CLEAN));
  check('clean re-validate after the abort is valid (exit 0)', after.exitCode === 0, `exit=${after.exitCode}`);
}

// ============================================================================
// 3. fsDir() (async directory feed, new as of 105c8d6): abort while a
//    directory-read promise is pending, settle after.
// ============================================================================

console.log('\nfsDir() directory feed -- abort while a dir-read promise is pending, settle after (case 3):');
{
  const src = join(here, 'corpus', 'epubcheck-prezipped', 'epub3_00-minimal_files_minimal.epub');
  check('unzip binary is available', spawnSync('unzip', ['-v'], { encoding: 'utf8' }).status === 0);
  const tmp = mkdtempSync(join(tmpdir(), 'epubcheck-abort-dir-'));
  try {
    const dir = join(tmp, 'minimal');
    mkdirSync(dir);
    spawnSync('unzip', ['-q', src, '-d', dir], { encoding: 'utf8' });

    const controller = new AbortController();
    const counters = { reads: 0 };
    const backend = gatedFsDirBackend({
      settle: 'resolve',
      duringPending: () => controller.abort(),
      counters,
    });
    // dirMode: 'exp' packages the tree, so the engine PULLS each file through
    // the directory feed -- the pending dir-read this case suspends on. The
    // library default is now 'direct' (a391b42), which errors "Mode required"
    // on this non-`.epub`-named directory before any read, never reaching the
    // feed. Pin 'exp' to keep exercising it, matching the other directory suites.
    const err = await rejectionOf(
      validate(await fsDir(dir, { fs: backend }), { signal: controller.signal, dirMode: 'exp' }),
    );
    check('reached a directory read (engine suspended before abort)', counters.reads > 0, `reads=${counters.reads}`);
    check('rejects with AbortError once the pending dir-read settled after abort', isAbortError(err), String(err));
    checkFeedsCleared('case 3');

    // Fresh validate() on the same thread works (cold-started, aborted scope
    // discarded): validate the SAME expanded tree cleanly through fsDir().
    // dirMode: 'exp' for the same reason as the aborted run above.
    const after = await validate(await fsDir(dir), { dirMode: 'exp' });
    check('clean re-validate of the expanded dir after the abort (exit 0)', after.exitCode === 0, `exit=${after.exitCode}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ============================================================================
// 4. http feed (Node bridge): abort while the download is pending, THEN let
//    the server respond -> abort reason wins, spool cleaned up, bridge closed.
// ============================================================================

console.log('\nurl() http feed -- abort while the download is pending, then the server responds (case 4):');
{
  // Spool files the Node bridge would create for THIS process (POSIX unlinks
  // them at creation, so none should ever be observable; assert that anyway).
  const spoolPattern = new RegExp(`^epubcheck-http-${process.pid}-\\d+\\.spool$`);
  const leftoverSpools = (): string[] => readdirSync(tmpdir()).filter((n) => spoolPattern.test(n));

  // A server that HOLDS the request open (no headers, no body) so the engine's
  // download suspends on __epubHttpGet; we release it only AFTER the abort.
  const held: ServerResponse[] = [];
  const server: Server = createServer((req, res) => {
    if (req.url === '/clean.epub') {
      // The recovery route answers immediately with a valid book.
      res.writeHead(200, { 'Content-Type': 'application/epub+zip', 'Content-Length': cleanBytes.length });
      res.end(cleanBytes);
      return;
    }
    held.push(res); // /hang.epub -- parked until we respond by hand below
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;

  try {
    const controller = new AbortController();
    const pending = validate(await url(`${base}/hang.epub`), { signal: controller.signal });
    // Abort while the download is genuinely pending (server still holding).
    setTimeout(() => controller.abort(), 60);
    const err = await rejectionOf(pending);
    check('rejects with AbortError while the download was pending', isAbortError(err), String(err));
    checkFeedsCleared('case 4');

    // NOW let the held request finish: the bridge's fetch resolves and the
    // download completes into a spool, but the run already tore the bridge down
    // (closed=true), so the late body is dropped and its spool is released.
    for (const res of held) {
      res.writeHead(200, { 'Content-Type': 'application/epub+zip', 'Content-Length': cleanBytes.length });
      res.end(cleanBytes);
    }
    // Give the late download time to stream in and hit the bridge's closed path.
    await delay(200);
    check('no leftover http spool file after the aborted-then-late download', leftoverSpools().length === 0, leftoverSpools().join(', '));

    // Bridge + engine scope recovered: a fresh URL validation completes normally.
    const after = await validate(await url(`${base}/clean.epub`));
    check('clean URL re-validate after the abort completes (exit 0)', after.exitCode === 0, `exit=${after.exitCode}`);
    check('no leftover http spool file after the clean run either', leftoverSpools().length === 0, leftoverSpools().join(', '));
  } finally {
    for (const res of held) if (!res.writableEnded) res.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

// ============================================================================
// 5. Timeout sugar: timeoutMs (not an explicit signal) across the fs()
//    suspension point -- the timeout fires while the read is pending, the read
//    settles after, and the run rejects with the TimeoutError reason.
// ============================================================================

console.log('\ntimeoutMs sugar -- timeout fires mid-suspension on the fs() feed, read settles after (case 5):');
{
  const counters = { reads: 0 };
  // No explicit signal: timeoutMs=30 fires on its own timer during the 50ms the
  // read stays pending; the read then RESOLVES with real bytes at the gap end.
  const backend = gatedFsBackend({
    settle: 'resolve',
    duringPending: () => {}, // the timeout does the aborting, not us
    counters,
  });
  const err = await rejectionOf(validate(await fsSource(BAD, { fs: backend }), { timeoutMs: 30 }));
  check('reached the read (engine suspended before the timeout)', counters.reads > 0, `reads=${counters.reads}`);
  check('rejects with TimeoutError once the pending read settled after the timeout', isTimeoutError(err), String(err));
  checkFeedsCleared('case 5');

  const after = await validate(await fsSource(CLEAN));
  check('clean re-validate after the timeout is valid (exit 0)', after.exitCode === 0, `exit=${after.exitCode}`);
}

// ============================================================================
// SKIPPED (recorded known limitation -- engine review finding 2, owner-visible)
// ============================================================================
// A feed promise for __ecRead / __ecDirRead that NEVER settles parks the
// engine's Java green thread at its TeaVM @Async seam indefinitely. Those two
// seams re-sample the abort signal ONLY at the resume boundary (inside
// consume()'s resolve handler, which runs when the promise settles), so an
// abort cannot force a rejection while the promise stays pending -- the run
// hangs. (The http __epubHttpGet seam is different: it registers its own abort
// listener that resumes the engine with an IO-error response, so a hung
// DOWNLOAD is interruptible; a hung __ecRead/__ecDirRead is not.) This is a
// known, owner-visible limitation, NOT a bug this suite fails on, so it is
// documented here rather than exercised (a real never-settling case would hang
// the run forever with no way to time it out from inside the library).
console.log('\nSKIPPED - never-settling __ecRead/__ecDirRead promise is uninterruptible (engine review finding 2, owner-visible)');
console.log('  skip - documented known limitation; not exercised (would hang forever)');

console.log('');
if (failures) {
  console.error(`ABORT-SUSPENSION SUITE FAILED: ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log('ABORT-SUSPENSION SUITE PASSED');
