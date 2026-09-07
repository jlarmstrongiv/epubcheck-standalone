#!/usr/bin/env node
// Engine-error feed-cleanup suite: proves that when the engine's main callback
// REJECTS (an engine error before/during validation output), driveEngine still
// clears every shared globalThis feed and drops the module scope, so the NEXT
// run cannot read the failed run's stale feeds and validate the WRONG book.
//
//   node test/engine-error-cleanup.ts
//
// This is a UNIT test of engine-run.ts's cleanup seam, not a native comparison:
// there is no deterministic byte sequence that makes the real TeaVM/Java side
// throw before output, so instead we drive driveEngine with a MOCK engine source
// (the source + macrotask yield are injected, exactly the host seam production
// uses). The mock lets us reproduce the exact leak scenario from the review
// (ledger 5/9): run A is zipped (feeds __ecSize/__ecRead), throws mid-run; run
// B is directory mode (no range feed) and must NOT observe run A's stale
// __ecSize/__ecRead.

import { driveEngine } from '../engine-run.ts';
import type { EngineRun, EngineFactory } from '../engine-run.ts';

const g = globalThis as unknown as Record<string, unknown>;
const yieldMacrotask = () => new Promise<void>((r) => setImmediate(r));

// The shared feed keys engine-run.ts owns; all must be absent after any run.
// __ecTapMessage/__ecTapInfo are the live report-event tap: a LINGERING tap
// would stream a later run's messages into an old caller's callbacks, so their
// clearing is part of the same airtight-finally invariant.
const FEED_KEYS = [
  '__ecSize',
  '__ecRead',
  '__epubName',
  '__epubArgs',
  '__ecExtraPaths',
  '__ecExtraB64',
  '__ecInputArg',
  '__ecReadError',
  '__ecTapMessage',
  '__ecTapInfo',
  '__ecPlain',
  '__ecRelArg',
  '__ecTZ',
  '__ecJson',
  '__ecExit',
  '__ecFile',
] as const;

let failures = 0;
function check(name: string, cond: unknown, detail?: string): void {
  if (cond) console.log(`  ok  - ${name}`);
  else {
    failures++;
    console.log(`  NOT OK - ${name}${detail ? ': ' + detail : ''}`);
  }
}

// A mock engine FACTORY whose main() records what feeds it saw, then REJECTS.
// engine-run now takes an injected factory (production supplies the build-time
// createEngine); calling it returns a fresh single-shot module, exactly like the
// real engine. Each driveEngine call gets its own factory here.
const errFactory: EngineFactory = () => ({
  main(_args: string[], cb: (err: unknown) => void): void {
    g.__probeErrSawSize = g.__ecSize;
    g.__probeErrSawRead = typeof g.__ecRead;
    cb(new Error('engine boom before validation output'));
  },
});

// A mock engine factory for a normal directory-mode run: records what feeds it
// saw and completes cleanly. If run A leaked __ecSize/__ecRead, this would see it.
const okFactory: EngineFactory = () => ({
  main(_args: string[], cb: (err: unknown) => void): void {
    g.__probeOkSawSize = g.__ecSize;
    g.__probeOkSawInput = g.__ecInputArg;
    g.__ecExit = 0;
    (g.__ecJson as (s: string) => void)('{"ok":true}');
    cb(undefined);
  },
});

// --- Run A: zipped mode (feeds __ecSize/__ecRead), engine errors -----------
console.log('run A (zipped) errors mid-run:');
const bookABytes = new TextEncoder().encode('ABC');
const runA: EngineRun = {
  size: bookABytes.length,
  read: (offset, length) => bookABytes.subarray(offset, offset + length),
  name: 'bookA.epub',
  args: ['--json', 'out.json'],
  extraFiles: [{ path: '/work/override.txt', b64: 'eA==' }],
  // A tap is installed so the failed-run path proves the tap globals are
  // cleared too (the FEED_KEYS assertions below).
  tap: { message: () => {}, info: () => {} },
  plain: false,
  relArg: false,
  tz: 'UTC',
};
let rejected = false;
try {
  await driveEngine(runA, () => Promise.resolve(errFactory), yieldMacrotask);
} catch {
  rejected = true;
}
check('run A rejected (engine error propagated)', rejected);
check('run A engine actually saw the fed __ecSize', g.__probeErrSawSize === 3, String(g.__probeErrSawSize));
check('run A engine actually saw the fed __ecRead', g.__probeErrSawRead === 'function', String(g.__probeErrSawRead));

// The invariant: after a FAILED run, every shared feed is cleared.
for (const k of FEED_KEYS) {
  check(`feed ${k} cleared after failed run`, g[k] === undefined, `still ${String(g[k])}`);
}

// --- Run B: directory mode (no range feed) must not see run A's stale feeds -
console.log('\nrun B (directory mode) after the failed run:');
const runB: EngineRun = {
  args: ['--mode', 'exp'],
  inputArg: '/work/bookB',
  plain: false,
  relArg: true,
};
const resB = await driveEngine(runB, () => Promise.resolve(okFactory), yieldMacrotask);
check('run B completed with exit 0', resB.exitCode === 0, `exit ${resB.exitCode}`);
check('run B produced its own json tap', resB.json === '{"ok":true}', String(resB.json));
// The core anti-regression assertion: run A's range feed did NOT leak into run B.
check(
  'run B did NOT observe run A stale __ecSize (no wrong-book validation)',
  g.__probeOkSawSize === undefined,
  `saw ${String(g.__probeOkSawSize)}`,
);
check('run B saw its own __ecInputArg', g.__probeOkSawInput === '/work/bookB', String(g.__probeOkSawInput));

// After the successful run, feeds are cleared too.
for (const k of FEED_KEYS) {
  check(`feed ${k} cleared after successful run`, g[k] === undefined, `still ${String(g[k])}`);
}

// Clean up the probe globals this test set.
delete g.__probeErrSawSize;
delete g.__probeErrSawRead;
delete g.__probeOkSawSize;
delete g.__probeOkSawInput;

console.log('');
if (failures) {
  console.error(`ENGINE-ERROR-CLEANUP SUITE FAILED: ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log('ENGINE-ERROR-CLEANUP SUITE PASSED');
