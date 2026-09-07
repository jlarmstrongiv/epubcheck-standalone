#!/usr/bin/env node
// Custom-messages (-c/--customMessages) parity suite: run the TeaVM engine and
// the REAL epubcheck.jar with the SAME override files on the same inputs and
// assert BYTE-IDENTICAL stdout/stderr plus matching exit codes.
//
//   node test/custom-messages.ts
//
// Covered, all against the stock OverriddenMessages machinery:
//   promote   a SUPPRESSED message to WARNING (ACC-004), incl. the
//             " (severity overridden from ...)" prefix
//   demote    an ERROR to WARNING (OPF-049)
//   suppress  a WARNING entirely (PKG-010), and ALL messages (exit-code flip)
//   reword    custom message text with %1$s parameters (NCX-001)
//   CHK-001   missing override file (through args passthrough, no feed)
//   CHK-002/003/004/005  malformed override lines
//   bytes     the customMessages option as bytes (reported name messages.txt)
//   non-file  the customMessages option on a non-file (memory) source
//
// BYTE IDENTITY: both sides run with cwd = a temp dir and the BARE names as
// arguments (input basename, and `-c <basename>`), so epubcheck reports every
// location identically -- no marker remap. The engine mounts the override file
// under /work/<name> and points -c at that bare name, exactly like the jar's
// cwd-relative -c.
//
// Like test/flags.ts, the suite SKIPs cleanly (exit 0) when the epubcheck
// release or a java binary is absent. Set EPUBCHECK_REQUIRE_JAR=1 to fail
// instead.

import { validate } from '../dist/index.js';
import { fs, memory } from '../dist/plugins.js';
import type { EpubCheckResult, ValidateOptions } from '../dist/index.js';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, dirname } from 'node:path';
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
    console.error(`CUSTOM-MESSAGES SUITE FAILED: EPUBCHECK_REQUIRE_JAR=1 but ${why}`);
    process.exit(1);
  }
  console.log(`CUSTOM-MESSAGES SUITE SKIPPED: ${why}`);
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

/** Run the jar with cwd = the temp dir and the BARE input name (relative). */
function runJar(cwd: string, args: string[], inputRel: string): Side {
  const r = spawnSync(
    javaCmd[0] as string,
    [...javaCmd.slice(1), '-jar', jar as string, ...args, inputRel],
    { cwd, encoding: 'utf8' },
  );
  return { exit: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

async function runWasm(inputAbs: string, options: ValidateOptions): Promise<Side> {
  const r: EpubCheckResult = await validate(await fs(inputAbs), options);
  return { exit: r.exitCode, stdout: r.stdout, stderr: r.stderr };
}

function checkBytes(label: string, wasm: Side, native: Side): void {
  check(`${label}: exit codes match`, wasm.exit === native.exit, `wasm=${wasm.exit} jar=${native.exit}`);
  check(`${label}: stdout is byte-identical`, wasm.stdout === native.stdout,
    `\n--- jar ---\n${native.stdout}\n--- engine ---\n${wasm.stdout}`);
  check(`${label}: stderr is byte-identical`, wasm.stderr === native.stderr,
    `\n--- jar ---\n${native.stderr}\n--- engine ---\n${wasm.stderr}`);
}

// --- fixtures ---------------------------------------------------------------
// realpath so the temp dir path is canonical (macOS /var/folders symlink form).
const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'epubcheck-cm-')));
const severityTester = join(here, 'corpus', 'epubcheck-expanded', 'cli__files__20-severity-tester.epub');
const book = join(tmp, 'book.epub');
copyFileSync(severityTester, book);

// An EPUB 3 content document whose empty anchor triggers ACC-004 (default
// severity SUPPRESSED, so absent from a default run).
const accXhtml = join(tmp, 'acc.xhtml');
writeFileSync(accXhtml,
  '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n' +
  '<html xmlns="http://www.w3.org/1999/xhtml" lang="en" xml:lang="en">\n' +
  '  <head><title>Anchor</title></head>\n' +
  '  <body>\n' +
  '    <p><a href="#target"></a></p>\n' +
  '    <p id="target">Target paragraph.</p>\n' +
  '  </body>\n</html>\n');

// Write an override file to disk (for the jar) and return { name, content } to
// feed the engine (as the customMessages option).
const overrideFile = (name: string, content: string): { name: string; content: string } => {
  writeFileSync(join(tmp, name), content);
  return { name, content };
};

try {
  // --- 1. promote: SUPPRESSED -> WARNING (the killer use) -------------------
  console.log('promote a SUPPRESSED message (ACC-004 -> WARNING):');
  {
    const ov = overrideFile('promote.txt', 'ACC-004\tWARNING\n');
    const args = ['--mode', 'xhtml', '-v', '3.0'];
    const native = runJar(tmp, ['-c', ov.name, ...args], basename(accXhtml));
    const wasm = await runWasm(accXhtml, { args, customMessages: ov.content, customMessagesName: ov.name });
    checkBytes('promote ACC-004', wasm, native);
    check('promote ACC-004: the suppressed message became visible',
      wasm.stderr.includes('WARNING(ACC-004)') &&
        wasm.stderr.includes('(severity overridden from SUPPRESSED)'),
      wasm.stderr);
  }

  // --- 2. demote + suppress + reword on a book ------------------------------
  console.log('\ndemote an ERROR, suppress a WARNING, reword with parameters:');
  {
    const ov = overrideFile('overrides.txt',
      'OPF-049\tWARNING\n' +
      'PKG-010\tSUPPRESSED\n' +
      'NCX-001\tERROR\tCustom NCX mismatch: %1$s vs %2$s\n');
    const native = runJar(tmp, ['-c', ov.name], basename(book));
    const wasm = await runWasm(book, { customMessages: ov.content, customMessagesName: ov.name });
    checkBytes('demote/suppress/reword', wasm, native);
    check('demote: OPF-049 is a WARNING with the override prefix',
      wasm.stderr.includes('WARNING(OPF-049)') &&
        wasm.stderr.includes('(severity overridden from ERROR)'),
      wasm.stderr);
    check('suppress: PKG-010 is gone', !wasm.stderr.includes('PKG-010'), wasm.stderr);
    check('reword: the custom NCX-001 text with substituted parameters appears',
      wasm.stderr.includes('Custom NCX mismatch: q vs NOID'), wasm.stderr);
  }

  // --- 3. suppress EVERYTHING: the exit code flips 1 -> 0 -------------------
  console.log('\nsuppress every message (exit-code flip):');
  {
    const ov = overrideFile('suppress-all.txt',
      'OPF-049\tSUPPRESSED\nNCX-001\tSUPPRESSED\nRSC-008\tSUPPRESSED\nPKG-010\tSUPPRESSED\n');
    const native = runJar(tmp, ['-c', ov.name], basename(book));
    const wasm = await runWasm(book, { customMessages: ov.content, customMessagesName: ov.name });
    checkBytes('suppress-all', wasm, native);
    check('suppress-all: exit 0 (all errors suppressed)', wasm.exit === 0, `got ${wasm.exit}`);
  }

  // --- 4. CHK-001: missing override file (args passthrough, no feed) --------
  console.log('\nCHK-001 (missing override file):');
  {
    const native = runJar(tmp, ['-c', 'missing-overrides.txt'], basename(book));
    const wasm = await runWasm(book, { args: ['-c', 'missing-overrides.txt'] });
    checkBytes('CHK-001', wasm, native);
    check('CHK-001 is reported', wasm.stderr.includes('ERROR(CHK-001)'), wasm.stderr);
  }

  // --- 5. CHK-002/003/004/005: malformed override lines ---------------------
  console.log('\nCHK-002/003/004/005 (bad id, bad severity, bad parameter counts):');
  {
    const ov = overrideFile('badoverrides.txt',
      'BAD-999\tERROR\n' +
      'OPF-049\tBOGUS\n' +
      'NCX-001\tERROR\tToo many %1$s %2$s %3$s params\n' +
      'RSC-008\tERROR\t\tSuggestion with a bogus %1$s param\n');
    const native = runJar(tmp, ['-c', ov.name], basename(book));
    const wasm = await runWasm(book, { customMessages: ov.content, customMessagesName: ov.name });
    checkBytes('CHK errors', wasm, native);
    for (const id of ['CHK-002', 'CHK-003', 'CHK-004', 'CHK-005']) {
      check(`${id} is reported`, wasm.stderr.includes(`ERROR(${id})`), wasm.stderr);
    }
  }

  // --- 6. customMessages as BYTES (reported name messages.txt) --------------
  console.log('\ncustomMessages as bytes:');
  {
    const content = 'BAD-999\tERROR\nOPF-049\tWARNING\n';
    writeFileSync(join(tmp, 'messages.txt'), content); // jar reads ./messages.txt
    const native = runJar(tmp, ['-c', 'messages.txt'], basename(book));
    const wasm = await runWasm(book, { customMessages: new TextEncoder().encode(content) });
    checkBytes('bytes form', wasm, native);
    check('bytes form: CHK-002 names ./messages.txt',
      wasm.stderr.includes('"./messages.txt"'), wasm.stderr);
  }

  // --- 7. customMessages on a NON-file (memory) source ----------------------
  // The override feed is independent of the source kind; a memory source with a
  // customMessages option must apply the overrides just the same.
  console.log('\ncustomMessages applies on a memory source:');
  {
    const bytes = new Uint8Array(readFileSync(book));
    const result = await validate(memory(bytes), {
      name: 'book.epub',
      customMessages: 'OPF-049\tSUPPRESSED\nNCX-001\tSUPPRESSED\nRSC-008\tSUPPRESSED\nPKG-010\tSUPPRESSED\n',
    });
    check('memory + customMessages suppresses everything (exit 0)', result.exitCode === 0, `got ${result.exitCode}`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// --- verdict -----------------------------------------------------------------
console.log('');
if (failures) {
  console.error(`CUSTOM-MESSAGES SUITE FAILED: ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log('CUSTOM-MESSAGES SUITE PASSED');
