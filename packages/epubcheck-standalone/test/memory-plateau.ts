#!/usr/bin/env node
// Memory-plateau regression suite: run many back-to-back WARM validations of the
// same small book through the one reused engine scope, sampling RSS after each,
// and prove memory holds a BOUNDED PLATEAU instead of climbing run over run.
//
//   node test/memory-plateau.ts
//
// Why this exists: unbounded memory growth is this project's founding failure --
// the previous engine was abandoned for it. Engine scope reuse (commit 81783aa)
// keeps ONE engine scope and reruns its main() per validation, resetting all
// cross-run state each time, which is what keeps RSS bounded. That plateau was
// only ever verified by hand (see agent-docs). This suite catches a reintroduced
// leak automatically: a leak here historically grew ~450+ MB PER RUN, so it
// blows through every bound below within a run or two.
//
// This intentionally does NOT force GC (no --expose-gc) and does NOT try to
// measure an exact number. Forcing GC and pinning an absolute figure is
// environment-sensitive and flaky (that is exactly why the reuse suite keeps the
// memory check out of its battery). Instead we sample the natural RSS the
// process settles at and make two robust assertions: a generous absolute ceiling,
// and no sustained growth between an early and a late window of the run.

import { validate } from '../dist/index.js';
import { fs } from '../dist/plugins.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, 'fixtures');
const BOOK = join(fixtures, 'test.epub'); // clean, ~1.7 KB -> exit 0, scope reused

const MiB = 1024 * 1024;

// --- calibration -------------------------------------------------------------
// Measured plateaus (warm, 30 back-to-back small-book runs, in-process reuse):
//   Node 26.7.0 (repo's pinned mise runtime): ~890 MB (886-893 MB)
//   Node 24                                  : ~1014 MB
// The RSS floor tracks the Node version -- newer Node plateaus lower. The
// package supports Node >= 24, so the ceiling must clear the highest known
// plateau (Node 24, ~1014 MB) with headroom for runtime variance, while staying
// tight enough that a real leak trips it fast.
//
// 1.5 GB gives ~520 MB of headroom over the Node 24 plateau (and ~630 MB over
// the pinned Node 26 plateau) yet still catches the historical leak within two
// runs: a ~450 MB/run leak past a 1014 MB plateau reaches 1464 MB after one
// leaking run and 1914 MB after two -- over the ceiling. On the pinned runtime
// it trips even sooner. So the bound absorbs normal cross-runtime variance but
// cannot absorb a genuine per-run leak.
const RSS_CEILING = 1536 * MiB; // 1.5 GiB

const RUNS = 30; // one cold engine build (~5 s) + 29 warm runs (~30 ms each)

// The first samples include the cold engine build and the JIT/cache warm-up
// that follows it, during which RSS legitimately climbs to its plateau. Discard
// them so the growth test compares two windows that are BOTH on the plateau.
const WARMUP = 10;

// Compare the mean RSS of an early on-plateau window to the mean of the final
// window. Means over several samples smooth out GC sawtooth (RSS wiggles by tens
// of MB as the collector runs), so a small drift is expected and tolerated; a
// leak is not a drift. Between the early window (~run 12) and the late window
// (~run 27) a ~450 MB/run leak would open a multi-GB gap -- thousands of MB --
// so a 150 MB tolerance is far below any real leak yet comfortably above GC
// noise on a bounded plateau.
const WINDOW = 5;
const GROWTH_TOLERANCE = 150 * MiB;

let failures = 0;
function check(name: string, cond: unknown, detail?: string): void {
  if (cond) console.log(`  ok  - ${name}`);
  else {
    failures++;
    console.log(`  NOT OK - ${name}${detail ? ': ' + detail : ''}`);
  }
}

const mb = (bytes: number) => (bytes / MiB).toFixed(1) + ' MB';
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

// --- run ---------------------------------------------------------------------
console.log(`${RUNS} back-to-back warm validations of test.epub, sampling RSS after each:`);
const rss: number[] = [];
for (let i = 0; i < RUNS; i++) {
  const result = await validate(await fs(BOOK));
  // A non-clean verdict would mean the engine scope was discarded and rebuilt
  // each run (an errored scope is never reused), which would invalidate the
  // "one reused scope" premise this suite measures. Guard it.
  if (result.exitCode !== 0) {
    failures++;
    console.log(`  NOT OK - run ${i} expected exit 0 (clean book), got ${result.exitCode}`);
  }
  const sample = process.memoryUsage().rss;
  rss.push(sample);
}

const peak = Math.max(...rss);
const earlyWindow = rss.slice(WARMUP, WARMUP + WINDOW);
const lateWindow = rss.slice(RUNS - WINDOW);
const earlyMean = mean(earlyWindow);
const lateMean = mean(lateWindow);
const growth = lateMean - earlyMean;

console.log('');
console.log(`  first sample (post cold build): ${mb(rss[0])}`);
console.log(`  peak RSS over the run:          ${mb(peak)}`);
console.log(`  early-window mean (runs ${WARMUP}-${WARMUP + WINDOW - 1}):  ${mb(earlyMean)}`);
console.log(`  late-window mean (last ${WINDOW}):      ${mb(lateMean)}`);
console.log(`  growth (late - early):          ${growth >= 0 ? '+' : ''}${mb(growth)}`);
console.log('');

// (a) RSS never crosses the ceiling.
check(`peak RSS stays under ceiling (${mb(RSS_CEILING)})`, peak < RSS_CEILING, `peak ${mb(peak)}`);

// (b) No sustained growth: the late window is not meaningfully above the early
// window. Only positive drift matters (a leak grows RSS); the late window
// settling lower than the early one is fine.
check(
  `no sustained growth across the run (< ${mb(GROWTH_TOLERANCE)} tolerance)`,
  growth < GROWTH_TOLERANCE,
  `grew ${mb(growth)} from ${mb(earlyMean)} to ${mb(lateMean)}`,
);

// --- verdict -----------------------------------------------------------------
if (failures) {
  console.error(`\nMEMORY-PLATEAU SUITE FAILED: ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log('MEMORY-PLATEAU SUITE PASSED');
