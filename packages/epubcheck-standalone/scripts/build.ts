#!/usr/bin/env node
// Build dist/ from source: the TeaVM JS-backend engine + the TypeScript library.
//
//   mise install            # provision node + java + gradle (once)
//   npm run build:deps      # fetch the pinned epubcheck jars + jzlib (once)
//   npm run build           # this script
//
// Steps:
//   1. gradle generateJavaScript          (TeaVM JS backend -> teavm/build/...)
//   2. node fix-generated.ts <engine.js>  (post-process the emitted JS)
//   3. copy the engine to dist/epubcheck-engine.js
//   4. tsc -p tsconfig.json               (compile the TS library into dist/)
//
// The engine build is expensive (~80s, needs -Xmx4g -- set in
// teavm/gradle.properties) and deliberate: it is never run implicitly by the
// test scripts. The toolchain comes from mise (java@temurin-21, gradle@9.7.1).

import { existsSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const teavm = join(root, 'teavm');
const dist = join(root, 'dist');
const engineOut = join(teavm, 'build', 'generated', 'teavm', 'js', 'epubcheck.js');

function run(cmd: string, args: string[], cwd: string): void {
  console.log(`\n$ (cd ${cwd} && ${cmd} ${args.join(' ')})`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd });
  if (r.status !== 0) {
    console.error(`${cmd} exited ${r.status}`);
    process.exit(r.status || 1);
  }
}

// Build-input versions come from the environment. mise.toml [env] supplies them
// for a plain build; the update-epubcheck workflow re-exports EPUBCHECK_VERSION
// after a bump. There is deliberately NO hardcoded fallback -- run this via mise
// (`mise exec -- npm run build`) so the pinned versions are in the environment,
// exactly as scripts/fetch-deps.ts requires. This keeps mise.toml the single
// source of truth: the epubcheck jar path below and the gradle build both derive
// from these, never from a second copy of the version string.
const EPUBCHECK_VERSION = process.env.EPUBCHECK_VERSION;
if (!EPUBCHECK_VERSION) {
  console.error(
    'EPUBCHECK_VERSION is not set. Run this via mise so the pinned build-input\n' +
      'version is in the environment, e.g. `mise run build` or\n' +
      '`mise exec -- npm run build`.',
  );
  process.exit(1);
}
// JZlib is a stable transitive build input (its version is not part of the
// epubcheck update flow); mise.toml [env] JZLIB_VERSION is its one home. It is
// required here for the same reason: fail loudly rather than compile against
// some default jzlib jar.
const JZLIB_VERSION = process.env.JZLIB_VERSION;
if (!JZLIB_VERSION) {
  console.error(
    'JZLIB_VERSION is not set. Run this via mise so the pinned build-input\n' +
      'version is in the environment, e.g. `mise run build` or\n' +
      '`mise exec -- npm run build`.',
  );
  process.exit(1);
}

// Build inputs (the epubcheck jars + jzlib) must already be fetched.
const buildInputs = join(root, 'build', `epubcheck-${EPUBCHECK_VERSION}`, 'epubcheck.jar');
if (!existsSync(buildInputs)) {
  console.error('Build inputs missing. Run: npm run build:deps');
  process.exit(1);
}

// 0. Drift guard: our teavm shim shadows EPUBCheck's own DefaultReportImpl
// (upstream source + two ecshim.ReportTap mirror blocks). If an EPUBCheck bump
// changed that upstream file, the shadow would silently keep old behavior. This
// check hashes the pristine upstream file (pulled from the fetched sources jar)
// against the hash recorded next to the shadow and FAILS the build on drift, so
// the mismatch is caught BEFORE the engine compile bakes a stale shadow in.
run('mise', ['exec', '--', 'node', join(root, 'scripts', 'check-shadow-drift.ts')], root);

// 1. TeaVM compile. Forward the build-input versions to gradle as project
// properties so teavm/build.gradle.kts resolves the epubcheck + jzlib jar paths
// from the SAME source of truth this script read (no version literal in the
// gradle build either).
run(
  'mise',
  [
    'exec', 'java@temurin-21', 'gradle@9.7.1', '--',
    'gradle', 'generateJavaScript', '--console=plain',
    `-PepubcheckVersion=${EPUBCHECK_VERSION}`,
    `-PjzlibVersion=${JZLIB_VERSION}`,
  ],
  teavm,
);
if (!existsSync(engineOut)) {
  console.error(`gradle did not produce ${engineOut}`);
  process.exit(1);
}

// 2. Post-process (throws if its expected patterns are gone -- a loud signal a
// toolchain change broke the assumptions).
run('mise', ['exec', '--', 'node', join(teavm, 'fix-generated.ts'), engineOut], teavm);

// 3. Copy the engine into dist/.
mkdirSync(dist, { recursive: true });
copyFileSync(engineOut, join(dist, 'epubcheck-engine.js'));
console.log(`\nok engine -> ${join(dist, 'epubcheck-engine.js')}`);

// 4. Compile the TypeScript library into dist/ (build:ts semantics: tsc, then
// remove the stray dist/package.json tsc copies in from version.ts's import).
run('mise', ['exec', '--', 'npx', 'tsc', '-p', join(root, 'tsconfig.json')], root);
rmSync(join(dist, 'package.json'), { force: true });

console.log('\nok Built dist/epubcheck-engine.js + the TypeScript library.');
console.log('   Verify with: npm test');
