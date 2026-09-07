#!/usr/bin/env node
// Drift guard for the verbatim-upstream SHADOWS in the shims jar.
//
//   node scripts/check-shadow-drift.ts
//
// Several files under teavm/shims/src-teavm are copies of an upstream epubcheck
// class -- the upstream source VERBATIM except for one small, documented change
// -- placed so the shims jar (which precedes the epubcheck jars on the TeaVM
// classpath) replaces the stock class. Today those are:
//   - com/adobe/epubcheck/util/DefaultReportImpl.java  (+ ecshim.ReportTap taps)
//   - com/adobe/epubcheck/api/EpubCheck.java           (+ HostBook body wiring)
//   - com/adobe/epubcheck/util/URLResourceProvider.java(+ HostHttp http branch)
//
// The danger: when the project bumps EPUBCHECK_VERSION, upstream may change one
// of those files, and our shadow would silently keep the OLD behavior while the
// engine reports the new version. This guard turns that silent landmine into a
// LOUD build failure. For each guarded shadow it pulls the pristine upstream
// .java out of the fetched epubcheck-<ver>-sources.jar and compares its sha256
// to the hash recorded next to the shadow (<Name>.upstream.sha256, which also
// documents how to re-port on a mismatch).
//
// ADDING THE NEXT SHADOW is one entry in GUARDED below + one .upstream.sha256
// sidecar next to the shadow. Nothing else changes.
//
// The sources jar is fetched by scripts/fetch-deps.ts. build.ts runs this guard
// right before the TeaVM engine compile, so a mismatch stops the build before
// it can bake a stale shadow into the engine.
//
// KNOWN-UNGUARDED shadows (upstream source NOT obtainable through the existing
// deps mechanism) are listed in UNGUARDED and printed as a warning every run,
// so the gap stays visible instead of silent. See that list for details.

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const shimsRoot = join(root, 'teavm', 'shims', 'src-teavm');

// Each guarded shadow: `entry` is the .java path inside the epubcheck sources
// jar; `hashFile` is the recorded pristine-upstream sha256 sidecar next to the
// shadow; `label` names it in the pass/fail output. `entry` is used verbatim
// both as the jar member to hash and as the shadow's location under shimsRoot.
interface GuardedShadow {
  label: string;
  entry: string;
  hashFile: string;
}

const GUARDED: GuardedShadow[] = [
  {
    label: 'DefaultReportImpl',
    entry: 'com/adobe/epubcheck/util/DefaultReportImpl.java',
    hashFile: join(shimsRoot, 'com/adobe/epubcheck/util/DefaultReportImpl.upstream.sha256'),
  },
  {
    label: 'EpubCheck',
    entry: 'com/adobe/epubcheck/api/EpubCheck.java',
    hashFile: join(shimsRoot, 'com/adobe/epubcheck/api/EpubCheck.upstream.sha256'),
  },
  {
    label: 'URLResourceProvider',
    entry: 'com/adobe/epubcheck/util/URLResourceProvider.java',
    hashFile: join(shimsRoot, 'com/adobe/epubcheck/util/URLResourceProvider.upstream.sha256'),
  },
];

// Verbatim-upstream shadows whose upstream source is NOT reachable through the
// existing deps mechanism (scripts/fetch-deps.ts fetches the epubcheck release
// zip + epubcheck sources jar + jzlib jar; it does not fetch Jing sources, and
// the jing jar in the release zip ships only compiled .class files). We do NOT
// invent a new download just for these -- instead we surface the gap loudly on
// every run so it is never a silent blind spot.
interface UnguardedShadow {
  label: string;
  shadow: string;
  reason: string;
}

const UNGUARDED: UnguardedShadow[] = [
  {
    label: 'ChoicePattern (Jing fork)',
    shadow: 'com/thaiopensource/relaxng/pattern/ChoicePattern.java',
    reason:
      'fork of jing-20181222 ChoicePattern (recursive walks rewritten iteratively). ' +
      'Jing upstream .java is not fetched by scripts/fetch-deps.ts (the release-zip ' +
      'jing jar is compiled .class only; no sources jar is downloaded). Jing is pinned ' +
      'separately from the epubcheck update flow, so drift risk is low -- but on a jing ' +
      'bump this fork must be re-verified against the new upstream BY HAND.',
  },
];

// EPUBCHECK_VERSION is the build-input pin (mise.toml [env]); no hardcoded
// fallback, matching fetch-deps.ts / build.ts -- fail loudly outside the
// provisioned toolchain instead of guessing a version.
const EPUBCHECK_VERSION = process.env.EPUBCHECK_VERSION;
if (!EPUBCHECK_VERSION) {
  console.error(
    'EPUBCHECK_VERSION is not set. Run this via mise so the pinned build-input\n' +
      'version is in the environment, e.g. `mise exec -- node scripts/check-shadow-drift.ts`.',
  );
  process.exit(1);
}

const sourcesJar = join(root, 'build', `epubcheck-${EPUBCHECK_VERSION}-sources.jar`);

function fail(lines: string[]): never {
  const bar = '='.repeat(72);
  console.error(`\n${bar}\nSHADOW DRIFT GUARD FAILED\n${bar}`);
  for (const l of lines) console.error(l);
  console.error(bar + '\n');
  process.exit(1);
}

if (!existsSync(sourcesJar)) {
  fail([
    `Upstream sources jar not found:`,
    `  ${sourcesJar}`,
    ``,
    `This guard needs the pristine upstream .java files to compare the shadows`,
    `against. Fetch the build inputs first:`,
    ``,
    `  mise exec -- node scripts/fetch-deps.ts   (or: npm run build:deps)`,
  ]);
}

async function checkShadow({ label, entry, hashFile }: GuardedShadow): Promise<void> {
  // Read the recorded expected hash (first 64-hex token in the file; '#' lines
  // are human-readable notes on what this guards and how to re-port).
  const recorded = await readFile(hashFile, 'utf8').catch(() => {
    fail([
      `Recorded hash sidecar not found for the ${label} shadow:`,
      `  ${hashFile}`,
      ``,
      `Every guarded shadow needs a <Name>.upstream.sha256 next to it.`,
    ]);
  });
  const recordedMatch = recorded.match(/\b[0-9a-f]{64}\b/);
  if (!recordedMatch) {
    fail([
      `Could not find a sha256 (64 hex chars) in the recorded hash file:`,
      `  ${hashFile}`,
    ]);
  }
  const expected = recordedMatch[0];

  // Pull the single upstream entry out of the sources jar (a zip) and hash its
  // exact stored bytes. `unzip -p` streams the entry to stdout -- same tool
  // fetch-deps.ts already relies on.
  const unzip = spawnSync('unzip', ['-p', sourcesJar, entry], { maxBuffer: 64 * 1024 * 1024 });
  if (unzip.status !== 0 || !unzip.stdout || unzip.stdout.length === 0) {
    fail([
      `Failed to read ${entry}`,
      `from ${sourcesJar}`,
      ``,
      `unzip exited ${unzip.status}. The upstream file may have moved or been`,
      `renamed in this epubcheck version -- if so, the ${label} shadow needs`,
      `re-porting to wherever the upstream class now lives.`,
    ]);
  }
  const actual = createHash('sha256').update(unzip.stdout).digest('hex');

  if (actual !== expected) {
    fail([
      `The UPSTREAM epubcheck ${entry.split('/').pop()} changed, but our ${label} shadow did not.`,
      ``,
      `  upstream (epubcheck-${EPUBCHECK_VERSION}-sources.jar): ${actual}`,
      `  recorded (shadow was ported against):                 ${expected}`,
      ``,
      `Our shadow at`,
      `  teavm/shims/src-teavm/${entry}`,
      `is the upstream source plus one documented change. If it keeps the old`,
      `upstream body, the engine will silently run STALE behavior while claiming`,
      `to be epubcheck ${EPUBCHECK_VERSION}.`,
      ``,
      `To fix (full instructions in ${hashFile.split('/').pop()}):`,
      `  1. diff the new upstream file against our shadow:`,
      `       unzip -p ${sourcesJar} \\`,
      `         ${entry} > /tmp/upstream.java`,
      `       diff /tmp/upstream.java \\`,
      `         teavm/shims/src-teavm/${entry}`,
      `  2. re-port ONLY our documented change onto the new upstream source;`,
      `     keep everything else byte-for-byte upstream.`,
      `  3. update the hash in ${hashFile.split('/').pop()} to:`,
      `       ${actual}`,
    ]);
  }

  console.log(
    `ok shadow drift guard: ${label} matches recorded upstream ` +
      `(sha256 ${expected.slice(0, 12)}..., epubcheck ${EPUBCHECK_VERSION})`,
  );
}

for (const shadow of GUARDED) {
  await checkShadow(shadow);
}

for (const u of UNGUARDED) {
  console.warn(
    `warn KNOWN-UNGUARDED shadow: ${u.label} (${u.shadow})\n` +
      `     ${u.reason}`,
  );
}
