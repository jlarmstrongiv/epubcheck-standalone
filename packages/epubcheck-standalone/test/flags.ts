#!/usr/bin/env node
// Flag-passthrough parity suite: run the library engine and the REAL
// epubcheck.jar with IDENTICAL CLI args on the same fixtures and assert
// normalized-identical output. This is the regression guard for the
// __epubArgs passthrough contract (teavm/src/main/java/EpubCheckTeaVM.java),
// including the --mode/-m single-file checks.
//
//   node test/flags.ts
//
// Covered flags:
//   -u                      usage messages appear (and match the jar)
//   --profile edupub        a non-default validation profile
//   --mode xhtml -v 3.0     single-file check, small file
//   --mode xhtml -v 3.0     single-file check, >64 KiB file (PROVES the whole
//                           file is materialized: the range-feed marker holds
//                           only the first 64 KiB, so a truncating engine
//                           would report a parse error here)
//   --locale fr / ja        localized messages (bundle + locale data in image)
//   --mode xhtml -v 3.0     MALFORMED file: the FATAL RSC-016 path must be
//                           byte-identical to the jar (regression guard for
//                           the Xerces message bundles -- without them the
//                           parser dies with MissingResourceRegistrationError
//                           instead of reporting RSC-016)
//
// The jar side needs a java binary (the mise-provisioned java, or PATH) and
// the epubcheck release under build/epubcheck-*/ (npm run build:deps). When
// either is missing the whole suite SKIPs with exit 0, so `npm test` still
// works on a checkout that only has the compiled wasm. Set EPUBCHECK_REQUIRE_JAR=1
// to turn that skip into a FAILURE instead, so CI that is supposed to have the
// jar (e.g. after build:deps) cannot silently pass without running the jar
// comparison.
//
// Both sides run with cwd = the fixture's directory and the bare file name as
// the input argument, so location prefixes normalize identically (the engine
// side's location prefix and the jar side's relative path both collapse to
// "EPUB" by the same parity.ts normalization rules).

import { validate } from '../dist/index.js';
import { fs } from '../dist/plugins.js';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = dirname(here);

// --- locate the jar (glob build/epubcheck-*/epubcheck.jar; no hardcoded version)
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

// --- locate java (mise-provisioned java first, then PATH)
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
    console.error(`FLAGS SUITE FAILED: EPUBCHECK_REQUIRE_JAR=1 but ${why}`);
    process.exit(1);
  }
  console.log(`FLAGS SUITE SKIPPED: ${why}`);
  process.exit(0);
}

// --- normalization: same rules as test/parity.ts, extended to USAGE/SUPPRESSED
const reEsc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const MSG_RE = /^(SUPPRESSED|USAGE|INFO|WARNING|ERROR|FATAL)\(([A-Z0-9]+[-_]\d+[a-z]?)\):\s*(.*)$/;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\.epubcheck\.w3c\.org)/g;

function normalize(rawOutput: string, fileBase: string): string[] {
  const pathRe = new RegExp('[^\\s(]*' + reEsc(fileBase), 'g');
  const msgs: string[] = [];
  for (let line of rawOutput.split('\n')) {
    line = line.replace(pathRe, 'EPUB').replace(UUID_RE, 'UUID');
    const m = line.match(MSG_RE);
    if (m) msgs.push(`${m[1]}(${m[2]}): ${m[3]}`);
  }
  msgs.sort();
  return msgs;
}

interface Side { exit: number | null; messages: string[]; raw: string; }

function runJar(file: string, args: string[]): Side {
  const j = java as string[];
  const r = spawnSync(
    j[0] as string,
    [...j.slice(1), '-jar', jar as string, ...args, basename(file)],
    { cwd: dirname(file), encoding: 'utf8' },
  );
  const raw = (r.stdout || '') + '\n' + (r.stderr || '');
  return { exit: r.status, messages: normalize(raw, basename(file)), raw };
}

async function runWasm(file: string, args: string[]): Promise<Side> {
  const r = await validate(await fs(file), args.length > 0 ? { args } : {});
  const raw = r.stdout + '\n' + r.stderr;
  return { exit: r.exitCode, messages: normalize(raw, basename(file)), raw };
}

let failures = 0;
function check(name: string, cond: unknown, detail?: string): void {
  if (cond) {
    console.log(`  ok  - ${name}`);
  } else {
    failures++;
    console.log(`  NOT OK - ${name}${detail ? ': ' + detail : ''}`);
  }
}

function checkParity(name: string, wasm: Side, native: Side): void {
  check(`${name}: exit codes match`, wasm.exit === native.exit, `wasm=${wasm.exit} jar=${native.exit}`);
  const same = JSON.stringify(wasm.messages) === JSON.stringify(native.messages);
  let detail = '';
  if (!same) {
    const onlyJar = native.messages.filter((m) => !wasm.messages.includes(m));
    const onlyWasm = wasm.messages.filter((m) => !native.messages.includes(m));
    detail = `\n      - jar only:  ${onlyJar.join('\n      - jar only:  ') || '(none)'}` +
             `\n      + wasm only: ${onlyWasm.join('\n      + wasm only: ') || '(none)'}`;
  }
  check(`${name}: messages match (${native.messages.length} normalized)`, same, detail);
}

const fixtures = join(here, 'fixtures');
const severityTester = join(here, 'corpus', 'epubcheck-expanded', 'cli__files__20-severity-tester.epub');

// --- 1. -u: usage messages appear and match ---------------------------------
console.log('-u (usage messages):');
{
  const args = ['-u'];
  const [wasm, native] = [await runWasm(severityTester, args), runJar(severityTester, args)];
  checkParity('-u', wasm, native);
  check('-u: wasm emits USAGE messages', wasm.messages.some((m) => m.startsWith('USAGE(')),
    wasm.messages.join(' | '));
}

// --- 2. --profile edupub: a non-default validation profile ------------------
console.log('\n--profile edupub:');
{
  const args = ['--profile', 'edupub'];
  const file = join(fixtures, 'test.epub');
  const [wasm, native] = [await runWasm(file, args), runJar(file, args)];
  checkParity('--profile edupub', wasm, native);
  // The plain default validation of test.epub is clean (see smoke.ts), so any
  // error here proves the profile flag reached epubcheck's parser.
  check('--profile edupub: profile checks fired (exit 1)', wasm.exit === 1, `got ${wasm.exit}`);
}

// --- 3. --mode xhtml (small file) -------------------------------------------
console.log('\n--mode xhtml -v 3.0 (small file):');
{
  const args = ['--mode', 'xhtml', '-v', '3.0'];
  const file = join(fixtures, 'content.xhtml');
  const [wasm, native] = [await runWasm(file, args), runJar(file, args)];
  checkParity('--mode xhtml small', wasm, native);
  check('--mode xhtml small: valid (exit 0)', wasm.exit === 0, `got ${wasm.exit}\n${wasm.raw}`);
}

// --- 4. --mode xhtml (>64 KiB file): proves full materialization ------------
// The range-feed marker file holds only the input's first 64 KiB. A >64 KiB
// single-file check therefore FAILS (truncated parse) unless the engine
// materialized the whole file. Built deterministically at test time so no
// large fixture needs committing.
console.log('\n--mode xhtml -v 3.0 (>64 KiB file, full-materialize proof):');
{
  const tmp = mkdtempSync(join(tmpdir(), 'epubcheck-flags-'));
  try {
    const filler = '  <p>Filler paragraph to push the document past the 64 KiB marker size.</p>\n';
    const big =
      '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n' +
      '<html xmlns="http://www.w3.org/1999/xhtml" lang="en" xml:lang="en">\n' +
      '  <head><title>Big</title></head>\n  <body>\n' +
      filler.repeat(Math.ceil((80 * 1024) / filler.length)) +
      '  </body>\n</html>\n';
    const file = join(tmp, 'big.xhtml');
    writeFileSync(file, big);
    const args = ['--mode', 'xhtml', '-v', '3.0'];
    const [wasm, native] = [await runWasm(file, args), runJar(file, args)];
    checkParity('--mode xhtml >64KiB', wasm, native);
    check('--mode xhtml >64KiB: valid (exit 0, whole file was read)', wasm.exit === 0,
      `got ${wasm.exit}\n${wasm.raw}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// --- 5. --locale fr / ja: localized messages --------------------------------
console.log('\n--locale (fr, ja):');
{
  const file = join(fixtures, 'test_bad.epub');
  const en = await runWasm(file, []);
  for (const locale of ['fr', 'ja']) {
    const args = ['--locale', locale];
    const [wasm, native] = [await runWasm(file, args), runJar(file, args)];
    checkParity(`--locale ${locale}`, wasm, native);
    check(`--locale ${locale}: message text is localized (differs from en run)`,
      JSON.stringify(wasm.messages) !== JSON.stringify(en.messages),
      wasm.messages.join(' | '));
  }
}

// --- 6. --mode xhtml (malformed file): FATAL RSC-016, byte-identical ---------
// Golden for the Xerces resource bundles baked into the image: a non-well-
// formed input must produce epubcheck's FATAL RSC-016 with the parser's full
// localized message. Compared BYTE-IDENTICALLY (not just normalized message
// sets): the only difference between the two sides is the input path they were
// given, so normalizing the engine's location prefix to the ./<name> the jar
// prints (it relativizes against its cwd) must make stdout and stderr equal
// down to the last byte.
console.log('\n--mode xhtml -v 3.0 (malformed file, RSC-016 golden):');
{
  // realpath so the jar's cwd-based relativization works: mkdtemp returns the
  // /var/folders symlinked form on macOS while user.dir is canonical, and a
  // mismatched prefix would leave the jar printing absolute locations.
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'epubcheck-flags-')));
  try {
    const malformed =
      '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n' +
      '<html xmlns="http://www.w3.org/1999/xhtml">\n' +
      '  <head><title>Broken</title></head>\n' +
      '  <body><p>unclosed\n</html>\n';
    const file = join(tmp, 'malformed.xhtml');
    writeFileSync(file, malformed);
    const args = ['--mode', 'xhtml', '-v', '3.0'];
    // Both sides run with cwd = the file's directory and the BARE file name as
    // input, so both relativize every reported location to the same form. The
    // engine reports locations under the bare name (cwd is /work); the jar with a
    // relative arg does the same, so no remap is needed for byte identity.
    const j = java as string[];
    const r = spawnSync(
      j[0] as string,
      [...j.slice(1), '-jar', jar as string, ...args, 'malformed.xhtml'],
      { cwd: tmp, encoding: 'utf8' },
    );
    const wasm = await validate(await fs(file), { args });
    check('RSC-016: exit codes match', wasm.exitCode === r.status,
      `wasm=${wasm.exitCode} jar=${r.status}`);
    check('RSC-016: FATAL RSC-016 is reported',
      (wasm.stdout + wasm.stderr).includes('FATAL(RSC-016)'),
      wasm.stdout + '\n' + wasm.stderr);
    check('RSC-016: stdout is byte-identical',
      wasm.stdout === (r.stdout || ''),
      `\n--- jar ---\n${r.stdout}\n--- wasm ---\n${wasm.stdout}`);
    check('RSC-016: stderr is byte-identical',
      wasm.stderr === (r.stderr || ''),
      `\n--- jar ---\n${r.stderr}\n--- wasm ---\n${wasm.stderr}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// --- verdict -----------------------------------------------------------------
console.log('');
if (failures) {
  console.error(`FLAGS SUITE FAILED: ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log('FLAGS SUITE PASSED');
