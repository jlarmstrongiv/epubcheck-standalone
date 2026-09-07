#!/usr/bin/env node
// Node smoke test: validate a known-good and a known-bad EPUB through the TeaVM
// engine and assert the exact expected results. This is what CI runs.
//
//   node test/smoke.ts
//
// Expected:
//   test.epub      -> valid, exit 0, 0 errors
//   test_bad.epub  -> invalid, exit 1, exactly ERROR(RSC-005) + ERROR(RSC-007)

import { validate } from '../dist/index.js';
import { fs } from '../dist/plugins.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, 'fixtures');
const validateFile = async (path: string) => validate(await fs(path));

let failures = 0;
function check(name: string, cond: unknown, detail?: string): void {
  if (cond) {
    console.log(`  ok  - ${name}`);
  } else {
    failures++;
    console.log(`  NOT OK - ${name}${detail ? ': ' + detail : ''}`);
  }
}

// --- known-good EPUB ---------------------------------------------------------
console.log('test.epub (should be VALID):');
const good = await validateFile(join(fixtures, 'test.epub'));
console.log(good.stdout.trim().split('\n').map((l) => '    ' + l).join('\n'));
check('exit code is 0', good.exitCode === 0, `got ${good.exitCode}`);
check('valid === true', good.valid === true);
check('zero errors', good.summary && good.summary.errors === 0, JSON.stringify(good.summary));
check('no ERROR/FATAL messages', !good.messages.some((m) => m.severity === 'ERROR' || m.severity === 'FATAL'));

// --- known-bad EPUB ----------------------------------------------------------
console.log('\ntest_bad.epub (should be INVALID):');
const bad = await validateFile(join(fixtures, 'test_bad.epub'));
console.log((bad.stdout + bad.stderr).trim().split('\n').map((l) => '    ' + l).join('\n'));
check('exit code is 1', bad.exitCode === 1, `got ${bad.exitCode}`);
check('valid === false', bad.valid === false);
check('summary reports 2 errors', bad.summary && bad.summary.errors === 2, JSON.stringify(bad.summary));
const codes = bad.messages.map((m) => m.id).sort();
check('reports RSC-005', codes.includes('RSC-005'), codes.join(','));
check('reports RSC-007', codes.includes('RSC-007'), codes.join(','));

// --- verdict -----------------------------------------------------------------
console.log('');
if (failures) {
  console.error(`SMOKE TEST FAILED: ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log('SMOKE TEST PASSED');
