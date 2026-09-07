#!/usr/bin/env node
// Cancellation suite: AbortSignal + timeoutMs on validate(), and the driver's
// abort seams in engine-run.ts.
//
//   node test/abort.ts
//
// Part 1 is a UNIT test of the driver seams (engine-error-cleanup style): mock
// engine factories drive driveEngine directly to prove the deterministic bits
// no real book can pin down -- the pre-start short-circuit does no engine work
// and keeps the warm scope, an aborted run rejects with the abort reason even
// when the mock engine SWALLOWS the injected read error and completes main()
// normally, the aborted run's scope is DISCARDED (the next run calls the
// factory again), and every shared feed global is cleared afterwards.
//
// Part 2 drives the REAL engine through validate(): abort before start, abort
// while an async book read is in flight, abort mid-run through the directory
// feed, timeoutMs firing during a suspension, abort racing composition
// (signal + timeoutMs together), an aborted run followed by a clean run whose
// result matches an untouched run byte for byte, and a signal aborted only
// AFTER success changing nothing.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { driveEngine } from '../engine-run.ts';
import type { EngineRun, EngineFactory } from '../engine-run.ts';
import { validate } from '../dist/index.js';
import { memoryDir, url } from '../dist/plugins.js';
import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, 'fixtures');
const g = globalThis as unknown as Record<string, unknown>;
const yieldMacrotask = () => new Promise<void>((r) => setImmediate(r));

let failures = 0;
function check(name: string, cond: unknown, detail?: string): void {
  if (cond) {
    console.log(`  ok  - ${name}`);
  } else {
    failures++;
    console.log(`  NOT OK - ${name}${detail ? ': ' + detail : ''}`);
  }
}

// Any unhandled rejection anywhere in this suite is a failure (aborted runs
// must reject exactly once, into their caller, and leak nothing).
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

// The shared feed keys engine-run.ts owns; all must be absent after any run
// (the same airtight-finally invariant engine-error-cleanup.ts guards).
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
  '__ecReadError',
  '__ecDirReadError',
  '__epubHttpGet',
  '__epubHttpRead',
  '__epubHttpReadPending',
  '__epubHttpReadError',
  '__ecTapMessage',
  '__ecTapInfo',
  '__ecPlain',
  '__ecRelArg',
  '__ecTZ',
  '__ecJson',
  '__ecExit',
  '__ecFile',
] as const;

const DISPOSE: typeof Symbol.dispose =
  Symbol.dispose ?? (Symbol.for('Symbol.dispose') as typeof Symbol.dispose);

// --- Part 1: driver seams, mock engine --------------------------------------

console.log('driver seams (mock engine):');
{
  // ONE factory across runs 1-4 so scope reuse is observable: the driver
  // reuses a cleanly-completed scope (no new factory call) and cold-starts
  // after an aborted one (a new factory call).
  let factoryCalls = 0;
  const mockFactory: EngineFactory = () => {
    factoryCalls++;
    const mod: ReturnType<EngineFactory> = {
      main(_args: string[], cb: (err: unknown) => void): void {
        // Pull the book feed like the real engine does; SWALLOW any read
        // error (epubcheck's resilience) and complete main() normally.
        const read = g.__ecRead as
          | ((t: Int8Array, o: number, l: number) => number | Promise<number>)
          | undefined;
        if (read) {
          try {
            read(new Int8Array(3), 0, 3);
          } catch {
            // swallowed: the engine turns the IO error into a FATAL result
          }
        }
        g.__ecExit = 0;
        cb(undefined);
      },
    };
    return mod;
  };
  const getFactory = () => Promise.resolve(mockFactory);
  const bytes = new TextEncoder().encode('ABC');
  const makeRun = (signal?: AbortSignal): EngineRun => {
    const run: EngineRun = {
      size: bytes.length,
      read: (offset, length) => bytes.subarray(offset, offset + length),
      name: 'mock.epub',
      args: [],
      plain: true,
      relArg: true,
    };
    if (signal !== undefined) run.signal = signal;
    return run;
  };

  // Run 1: clean, builds the scope.
  const res1 = await driveEngine(makeRun(), getFactory, yieldMacrotask);
  check('run 1 (clean) completed', res1.exitCode === 0, `exit ${res1.exitCode}`);
  check('run 1 built a scope (factory called once)', factoryCalls === 1, `${factoryCalls}`);

  // Run 2: PRE-ABORTED signal. Rejects with the signal's reason before any
  // engine work -- and before getFactory(), so the call count cannot move.
  const preController = new AbortController();
  const preReason = new Error('aborted before start');
  preController.abort(preReason);
  const err2 = await rejectionOf(driveEngine(makeRun(preController.signal), getFactory, yieldMacrotask));
  check('run 2 (pre-aborted) rejected with the abort reason', err2 === preReason, String(err2));
  check('run 2 did no engine work (factory not called)', factoryCalls === 1, `${factoryCalls}`);

  // Run 3: clean again. The pre-aborted run must NOT have cost the warm
  // scope: the factory is still at one call.
  const res3 = await driveEngine(makeRun(), getFactory, yieldMacrotask);
  check('run 3 (clean) completed', res3.exitCode === 0, `exit ${res3.exitCode}`);
  check('run 3 reused the warm scope (factory still once)', factoryCalls === 1, `${factoryCalls}`);

  // Run 4: aborted MID-RUN, and the mock engine SWALLOWS the read throw and
  // completes main() normally with exit 0 -- the driver's post-settle flag
  // must still reject with the abort reason, never resolve with the result.
  const midController = new AbortController();
  const run4 = makeRun(midController.signal);
  const innerRead = run4.read as (o: number, l: number) => Uint8Array;
  run4.read = (offset, length) => {
    // Abort DURING the run, from inside the first read: the wrapper already
    // passed its pre-read check, so the abort is observed at the NEXT seam
    // sample -- here, the post-settle check (the mock reads only once).
    midController.abort();
    return innerRead(offset, length);
  };
  const err4 = await rejectionOf(driveEngine(run4, getFactory, yieldMacrotask));
  check('run 4 (aborted, engine swallowed) rejected with AbortError', isAbortError(err4), String(err4));
  for (const k of FEED_KEYS) {
    check(`feed ${k} cleared after aborted run`, g[k] === undefined, `still ${String(g[k])}`);
  }

  // Run 5: clean. The aborted run's scope must have been DISCARDED, so this
  // run cold-starts through a fresh factory call.
  const res5 = await driveEngine(makeRun(), getFactory, yieldMacrotask);
  check('run 5 (clean after abort) completed', res5.exitCode === 0, `exit ${res5.exitCode}`);
  check('run 5 cold-started (factory called again)', factoryCalls === 2, `${factoryCalls}`);

  // Run 6: the abort is observed at the ASYNC resume boundary and the mock
  // engine does NOT swallow it (main rejects with what the read seam threw,
  // like a real suspended engine resuming into an unhandled IOException) --
  // the driver still rejects with the abort reason, not a generic error.
  let sawThrow: unknown = null;
  const throwFactory: EngineFactory = () => ({
    main(_args: string[], cb: (err: unknown) => void): void {
      // Await the read like the real engine's @Async suspension does.
      const read = g.__ecRead as (t: Int8Array, o: number, l: number) => number | Promise<number>;
      Promise.resolve(read(new Int8Array(3), 0, 3)).then(
        () => cb(undefined),
        (e: unknown) => {
          sawThrow = e;
          cb(e);
        },
      );
    },
  });
  const lateController = new AbortController();
  const lateReason = new Error('mid-run abort reason');
  const run6 = makeRun(lateController.signal);
  // Abort while the read is IN FLIGHT (a macrotask before its 20 ms resolve):
  // the resume-boundary re-check throws the reason into the engine.
  setImmediate(() => lateController.abort(lateReason));
  run6.read = (offset, length) =>
    new Promise((resolve) =>
      setTimeout(() => resolve(new Uint8Array(bytes.subarray(offset, offset + length))), 20),
    );
  const err6 = await rejectionOf(driveEngine(run6, () => Promise.resolve(throwFactory), yieldMacrotask));
  check('run 6 (engine rethrew the abort) rejected with the abort reason', err6 === lateReason, String(err6));
  check('run 6 engine observed the thrown abort reason', sawThrow === lateReason, String(sawThrow));
}

// --- Part 2: real engine through validate() ----------------------------------

const badBytes = readFileSync(join(fixtures, 'test_bad.epub'));
const makeSource = (onDispose?: () => void) => ({
  size: badBytes.length,
  name: 'test_bad.epub',
  read: (offset: number, length: number): Uint8Array => badBytes.subarray(offset, offset + length),
  [DISPOSE](): void {
    if (onDispose) onDispose();
  },
});

console.log('\nabort before start (real engine):');
{
  const controller = new AbortController();
  controller.abort();
  let disposed = 0;
  const err = await rejectionOf(
    validate(makeSource(() => disposed++), { signal: controller.signal }),
  );
  check('rejects with AbortError', isAbortError(err), String(err));
  check('source still disposed exactly once', disposed === 1, `${disposed}`);
}

console.log('\nabort while an async book read is in flight (real engine):');
{
  const controller = new AbortController();
  let reads = 0;
  const err = await rejectionOf(
    validate(
      {
        size: badBytes.length,
        name: 'test_bad.epub',
        read: (offset: number, length: number): Promise<Uint8Array> => {
          reads++;
          return new Promise((resolve) => {
            // Abort while the read is pending; the resume-boundary re-check
            // observes it and the engine unwinds as an IOException.
            setTimeout(() => {
              controller.abort();
              resolve(new Uint8Array(badBytes.subarray(offset, offset + length)));
            }, 10);
          });
        },
        [DISPOSE](): void {},
      },
      { signal: controller.signal },
    ),
  );
  check('engine started (read reached)', reads > 0, `${reads}`);
  check('rejects with AbortError', isAbortError(err), String(err));
  for (const k of FEED_KEYS) {
    check(`feed ${k} cleared after aborted run`, g[k] === undefined, `still ${String(g[k])}`);
  }
}

console.log('\nabort mid-run through the directory feed (real engine):');
{
  const controller = new AbortController();
  const tree = new Map<string, Uint8Array>([
    ['mimetype', new TextEncoder().encode('application/epub+zip')],
    ['META-INF/container.xml', new TextEncoder().encode('<?xml version="1.0"?><container/>')],
    ['EPUB/package.opf', new TextEncoder().encode('<?xml version="1.0"?><package/>')],
  ]);
  const inner = memoryDir(tree);
  let reads = 0;
  const source = {
    name: 'abortdir',
    list: () => inner.list(),
    read: (path: string, offset: number, length: number): Uint8Array => {
      reads++;
      const chunk = inner.read(path, offset, length) as Uint8Array;
      // Abort after serving the first range; the next directory read's
      // pre-read check throws the abort into the engine.
      controller.abort();
      return chunk;
    },
    [DISPOSE](): void {},
  };
  // dirMode: 'exp' packages the tree, so the engine PULLS each file's bytes
  // through the directory feed -- that read is what this test aborts mid-flight.
  // The library default is now 'direct' (a391b42), which for this non-`.epub`-
  // named directory errors "Mode required" before any read, so it would never
  // reach (let alone abort during) the directory feed. Pin 'exp' to keep
  // exercising the feed, matching the other directory suites.
  const err = await rejectionOf(validate(source, { signal: controller.signal, dirMode: 'exp' }));
  check('directory reads reached the source', reads > 0, `${reads}`);
  check('rejects with AbortError', isAbortError(err), String(err));
}

console.log('\ntimeoutMs fires during a suspension (real engine):');
{
  const err = await rejectionOf(
    validate(
      {
        size: badBytes.length,
        name: 'test_bad.epub',
        read: (offset: number, length: number): Promise<Uint8Array> =>
          new Promise((resolve) =>
            setTimeout(() => resolve(new Uint8Array(badBytes.subarray(offset, offset + length))), 120),
          ),
        [DISPOSE](): void {},
      },
      { timeoutMs: 20 },
    ),
  );
  check('rejects with TimeoutError', isTimeoutError(err), String(err));
}

console.log('\nsignal + timeoutMs compose (whichever aborts first wins):');
{
  const controller = new AbortController();
  const err = await rejectionOf(
    validate(
      {
        size: badBytes.length,
        name: 'test_bad.epub',
        read: (offset: number, length: number): Promise<Uint8Array> =>
          new Promise((resolve) => {
            setTimeout(() => {
              controller.abort();
              resolve(new Uint8Array(badBytes.subarray(offset, offset + length)));
            }, 10);
          }),
        [DISPOSE](): void {},
      },
      { signal: controller.signal, timeoutMs: 60_000 },
    ),
  );
  check('the user abort wins over the far timeout (AbortError, not TimeoutError)', isAbortError(err), String(err));
}

console.log('\nengine completes normally but the signal aborted mid-run (post-settle determinism):');
{
  // Abort from inside onMessage: the tap fires synchronously mid-run and the
  // tiny book needs no further reads, so the engine finishes its run and
  // main() completes normally -- the caller must STILL get the AbortError.
  const controller = new AbortController();
  let messagesSeen = 0;
  const err = await rejectionOf(
    validate(makeSource(), {
      signal: controller.signal,
      onMessage: () => {
        messagesSeen++;
        if (messagesSeen === 1) controller.abort();
      },
    }),
  );
  check('a message fired before the abort', messagesSeen > 0, `${messagesSeen}`);
  check('rejects with AbortError even though the engine finished', isAbortError(err), String(err));
}

console.log('\naborted run then clean run (scope-reuse composition, real engine):');
{
  // Baseline result on an untouched run.
  const baseline = await validate(makeSource());
  check('baseline run is the known-invalid fixture verdict', baseline.exitCode === 1, `exit ${baseline.exitCode}`);

  // Aborted run in the middle.
  const controller = new AbortController();
  const err = await rejectionOf(
    validate(
      {
        size: badBytes.length,
        name: 'test_bad.epub',
        read: (offset: number, length: number): Promise<Uint8Array> =>
          new Promise((resolve) => {
            setTimeout(() => {
              controller.abort();
              resolve(new Uint8Array(badBytes.subarray(offset, offset + length)));
            }, 10);
          }),
        [DISPOSE](): void {},
      },
      { signal: controller.signal },
    ),
  );
  check('middle run rejected with AbortError', isAbortError(err), String(err));

  // Clean run after the abort: cold-starts (the aborted scope was discarded)
  // and must match the baseline exactly.
  const after = await validate(makeSource());
  check('clean run after the abort matches the baseline exit code', after.exitCode === baseline.exitCode, `exit ${after.exitCode}`);
  check(
    'clean run after the abort matches the baseline messages',
    JSON.stringify(after.messages) === JSON.stringify(baseline.messages),
  );
  check(
    'clean run after the abort matches the baseline summary',
    JSON.stringify(after.summary) === JSON.stringify(baseline.summary),
  );
}

console.log('\nsignal aborted only AFTER success changes nothing:');
{
  const controller = new AbortController();
  const result = await validate(makeSource(), { signal: controller.signal });
  check('run resolved normally', result.exitCode === 1, `exit ${result.exitCode}`);
  controller.abort();
  await yieldMacrotask();
  check('result unaffected by the late abort', result.valid === false && result.messages.length > 0);
  // And the NEXT run (no signal at all) still works against clean feeds.
  const next = await validate(makeSource());
  check('next run after a late abort is clean', next.exitCode === 1, `exit ${next.exitCode}`);
}

console.log('\nabort during a pending URL download (real engine, http feed):');
{
  // A local server that never answers: the engine suspends on the GET
  // indefinitely. The abort listener resumes it with an IO-error response,
  // the stock URL-failure path unwinds, and the caller gets the AbortError --
  // the one seam where an abort must fire while NO read callback can run.
  const held: ServerResponse[] = [];
  const server = createServer((_req, res) => {
    held.push(res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const controller = new AbortController();
  const pending = validate(await url(`http://127.0.0.1:${port}/book.epub`), {
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 50);
  const err = await rejectionOf(pending);
  check('rejects with AbortError while the download hangs', isAbortError(err), String(err));
  for (const k of FEED_KEYS) {
    check(`feed ${k} cleared after aborted URL run`, g[k] === undefined, `still ${String(g[k])}`);
  }
  for (const res of held) res.destroy();
  await new Promise((resolve) => server.close(resolve));
}

console.log('\nmanual signal-combining fallback (AbortSignal.any absent):');
{
  const holder = AbortSignal as unknown as Record<string, unknown>;
  const nativeAny = holder.any;
  delete holder.any;
  try {
    // Timeout side fires while the caller's signal never does.
    const idle = new AbortController();
    const err = await rejectionOf(
      validate(
        {
          size: badBytes.length,
          name: 'test_bad.epub',
          read: (offset: number, length: number): Promise<Uint8Array> =>
            new Promise((resolve) =>
              setTimeout(() => resolve(new Uint8Array(badBytes.subarray(offset, offset + length))), 120),
            ),
          [DISPOSE](): void {},
        },
        { signal: idle.signal, timeoutMs: 20 },
      ),
    );
    check('fallback combiner: timeout side fires (TimeoutError)', isTimeoutError(err), String(err));

    // Already-aborted caller signal short-circuits without engine work.
    const pre = new AbortController();
    const preReason = new Error('pre-aborted through the fallback');
    pre.abort(preReason);
    const err2 = await rejectionOf(validate(makeSource(), { signal: pre.signal, timeoutMs: 60_000 }));
    check('fallback combiner: pre-aborted signal rejects with its reason', err2 === preReason, String(err2));
  } finally {
    holder.any = nativeAny;
  }
}

console.log('');
if (failures) {
  console.error(`ABORT SUITE FAILED: ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log('ABORT SUITE PASSED');
