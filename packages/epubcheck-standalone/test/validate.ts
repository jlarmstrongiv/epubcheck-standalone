#!/usr/bin/env node
// Test for the isomorphic `validate()` driven by a CUSTOM range source -- the
// in-worker escape hatch. A hand-rolled source (bytes in memory, a name, and a
// disposal spy) exercises, in one shot:
//   - the full EpubCheckResult shape (valid, exitCode, messages, features,
//     summary, stdout, stderr),
//   - the report tap collected and streamed via onMessage,
//   - the source name defaulting through when `name` is omitted,
//   - the source DISPOSED exactly once when the run ends.
//
//   node test/validate.ts

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate } from '../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, 'fixtures');

let failures = 0;
function check(name: string, cond: unknown, detail?: string): void {
  if (cond) {
    console.log(`  ok  - ${name}`);
  } else {
    failures++;
    console.log(`  NOT OK - ${name}${detail ? ': ' + detail : ''}`);
  }
}

// A hand-rolled range source over the file bytes in memory, carrying a name and
// a disposal spy. `read` returns the byte range synchronously (validate reads
// the whole source and base64-encodes it internally).
const DISPOSE: typeof Symbol.dispose =
  Symbol.dispose ?? (Symbol.for('Symbol.dispose') as typeof Symbol.dispose);
const bytes = readFileSync(join(fixtures, 'test_bad.epub'));
let disposeCalls = 0;
let liveMessages = 0;
const source = {
  size: bytes.length,
  name: 'test_bad.epub', // exercise the source-name default (no explicit name)
  read: (offset: number, length: number): Uint8Array =>
    bytes.subarray(offset, offset + length),
  [DISPOSE](): void {
    disposeCalls++;
  },
};

console.log('validate(test_bad.epub) via a custom range source (should be INVALID):');
const result = await validate(source, {
  onMessage: () => {
    liveMessages++;
  },
});

check('exit code is 1', result.exitCode === 1, `got ${result.exitCode}`);
check('valid === false', result.valid === false);
check('summary reports 2 errors', !!result.summary && result.summary.errors === 2, JSON.stringify(result.summary));
const codes = result.messages.map((m) => m.id).sort();
check('reports RSC-005', codes.includes('RSC-005'), codes.join(','));
check('reports RSC-007', codes.includes('RSC-007'), codes.join(','));
check('messages have flat location shape', result.messages.every((m) => typeof m.path === 'string' && typeof m.line === 'number' && typeof m.column === 'number'));
check('messages carry the complete fields (suggestion/context present)', result.messages.every((m) => typeof m.suggestion === 'string' && (m.context === null || typeof m.context === 'string')));
check('stdout captured (has Messages line)', /Messages:/.test(result.stdout + result.stderr));
check('result.messages collected (the complete tap list)', result.messages.length > 0, `${result.messages.length}`);
check('onMessage streamed each message', liveMessages === result.messages.length, `${liveMessages} vs ${result.messages.length}`);
check('located messages carry a container-relative path', result.messages.every((m) => m.path.length > 0));
check('source disposed exactly once', disposeCalls === 1, `disposeCalls=${disposeCalls}`);
// The live report-event tap populates result.features on EVERY run (TOOL_*
// events flow unconditionally; per-item SIZE/SHA_256 etc. follow).
check('result.features populated by the live tap', result.features.length > 0, `${result.features.length}`);
check(
  'result.features carries the TOOL_NAME event',
  result.features.some((i) => i.feature === 'TOOL_NAME' && i.value === 'epubcheck'),
);

// reports:['xml'] on an invalid book (ledger 2): the run is a single plain
// engine run whose console lines still carry the messages/summary; the XML
// document is rendered from the live tap stream, and ONLY requested formats
// appear in result.reports.
console.log('validate(test_bad.epub) with reports:[\'xml\'] (messages must survive):');
const xmlResult = await validate(
  { size: bytes.length, name: 'test_bad.epub', read: (o: number, l: number): Uint8Array => bytes.subarray(o, o + l), [DISPOSE](): void {} },
  { reports: ['xml'] },
);
check('reports-xml: valid === false', xmlResult.valid === false, `valid=${xmlResult.valid}`);
check('reports-xml: exit code is 1', xmlResult.exitCode === 1, `got ${xmlResult.exitCode}`);
check('reports-xml: messages non-empty', xmlResult.messages.length > 0, `${xmlResult.messages.length}`);
check('reports-xml: summary reports 2 errors', !!xmlResult.summary && xmlResult.summary.errors === 2, JSON.stringify(xmlResult.summary));
check('reports-xml: reports.xml produced', typeof xmlResult.reports?.xml === 'string' && xmlResult.reports.xml.length > 0);
check('reports-xml: reports.json NOT surfaced (requested formats only)', xmlResult.reports?.json === undefined);

// ASYNC range source: read() returns a PROMISE resolving on a later macrotask
// (like a real async host read -- blob.slice().arrayBuffer() on the browser
// main thread). The engine must SUSPEND at its book-read seam per cache-miss
// block and resume with the bytes, producing the identical verdict to the
// synchronous source above. Also asserts the promise path was actually taken
// and the console capture survives the suspension windows (stdout intact).
console.log('validate(test_bad.epub) via an ASYNC range source (engine suspends per block):');
let asyncReads = 0;
const asyncResult = await validate({
  size: bytes.length,
  name: 'test_bad.epub',
  read: (offset: number, length: number): Promise<Uint8Array> => {
    asyncReads++;
    return new Promise((resolve) =>
      setTimeout(() => resolve(new Uint8Array(bytes.subarray(offset, offset + length))), 0),
    );
  },
  [DISPOSE](): void {},
});
check('async: read returned promises (suspend path exercised)', asyncReads > 0, `asyncReads=${asyncReads}`);
check('async: exit code matches sync run', asyncResult.exitCode === result.exitCode, `got ${asyncResult.exitCode}`);
check('async: messages match sync run', JSON.stringify(asyncResult.messages) === JSON.stringify(result.messages));
check('async: summary matches sync run', JSON.stringify(asyncResult.summary) === JSON.stringify(result.summary));
check('async: stdout captured across suspensions', /Messages:/.test(asyncResult.stdout + asyncResult.stderr));

// A REJECTED async read must surface as a run failure (the engine sees an
// IOException carrying the host's message), never a hang or a false verdict.
console.log('validate with an async source whose read REJECTS (must fail cleanly):');
const rejected = await validate({
  size: bytes.length,
  name: 'test_bad.epub',
  read: (): Promise<Uint8Array> =>
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error('host read exploded')), 0)),
  [DISPOSE](): void {},
});
check('async-reject: run did not report valid', rejected.valid === false, `valid=${rejected.valid}`);
check('async-reject: nonzero exit', rejected.exitCode !== 0, `exit=${rejected.exitCode}`);

// A source whose read THROWS SYNCHRONOUSLY with a Java-FileNotFoundException-
// shaped message (what the CLI builds for a permission-denied file): the
// engine must experience it as an IOException carrying the RAW message and
// report it through epubcheck's own path -- FATAL(PKG-008) TWICE embedding
// the message verbatim, exit 1, 2 fatals -- exactly the jar's output for an
// unreadable file (parity-audit Gap C). A raw JS throw used to cross the
// engine boundary as "(JavaScript) Error: ..." that no catch(IOException)
// could handle.
console.log('validate with a sync source whose read THROWS (jar-parity PKG-008):');
const denied = await validate({
  size: 1770,
  name: 'unreadable.epub',
  read: (): Uint8Array => {
    throw new Error('/books/unreadable.epub (Permission denied)');
  },
  [DISPOSE](): void {},
});
const deniedLine =
  'FATAL(PKG-008): unreadable.epub/./unreadable.epub(-1,-1): ' +
  'Unable to read file "/books/unreadable.epub (Permission denied)".';
check('sync-throw: exit 1', denied.exitCode === 1, `exit=${denied.exitCode}`);
check(
  'sync-throw: 2 fatals in the summary',
  denied.summary !== null && denied.summary.fatals === 2,
  JSON.stringify(denied.summary),
);
check(
  'sync-throw: PKG-008 printed twice with the raw host message',
  denied.stderr.split('\n').filter((l) => l === deniedLine).length === 2,
  JSON.stringify(denied.stderr),
);
check(
  'sync-throw: two structured PKG-008 messages',
  denied.messages.length === 2 &&
    denied.messages.every((m) => m.id === 'PKG-008' && m.severity === 'FATAL'),
  JSON.stringify(denied.messages),
);

console.log('');
if (failures) {
  console.error(`VALIDATE TEST FAILED: ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log('VALIDATE TEST PASSED');
