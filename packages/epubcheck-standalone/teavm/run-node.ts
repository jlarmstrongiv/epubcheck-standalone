// Minimal Node harness for the TeaVM build: feeds one epub through the
// range-read contract (__ecSize + __ecRead served by positional fs.readSync on
// one fd -- the file stays on disk) and prints the JSON report summary.
//   mise exec -- node run-node.ts <path-to-epub> [extra cli args...]
import { openSync, fstatSync, readSync } from 'node:fs';
import { basename, join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const epubPath = process.argv[2];
if (!epubPath) {
  console.error('usage: node run-node.ts <epub> [args...]');
  process.exit(2);
}

const g = globalThis as Record<string, unknown>;
const fd = openSync(epubPath, 'r');
g.__ecSize = fstatSync(fd).size;
// The engine hands an Int8Array view of its own buffer; read the range from
// disk straight into it (positional reads; loop over short reads).
g.__ecRead = (target: Uint8Array, offset: number, length: number): number => {
  let done = 0;
  while (done < length) {
    const n = readSync(fd, target, done, length - done, offset + done);
    if (n <= 0) throw new Error(`short read at ${offset + done} (wanted ${length})`);
    done += n;
  }
  return length;
};
g.__epubName = basename(epubPath);
if (process.argv.length > 3) {
  g.__epubArgs = process.argv.slice(3);
}

let json: string | null = null;
if (process.env.EC_DEBUG) g.__ecDebug = true;
g.__ecJson = (s: string) => {
  json = s;
};

// Capture epubcheck's stdout/stderr (TeaVM routes them to console.info/error).
const outLines: string[] = [];
const errLines: string[] = [];
const origInfo = console.info.bind(console);
const origError = console.error.bind(console);
console.info = (...a: unknown[]) => {
  outLines.push(a.join(' '));
};
console.error = (...a: unknown[]) => {
  errLines.push(a.join(' '));
};

const mod = require(join(here, 'build/generated/teavm/js/epubcheck.js'));

const t0 = performance.now();
mod.main([], (err: unknown) => {
  console.info = origInfo;
  console.error = origError;
  const dt = performance.now() - t0;
  console.log(`\n--- done in ${dt.toFixed(0)} ms, exit=${g.__ecExit}, err=${err ?? 'none'}`);
  if (err && (err as Error).stack) console.log((err as Error).stack.split('\n').slice(0,25).join('\n'));
  const cap = process.env.EC_DEBUG ? Infinity : 30;
  console.log(`--- stdout (${outLines.length} lines):`);
  for (const l of outLines.slice(0, cap)) console.log('  ' + l);
  console.log(`--- stderr (${errLines.length} lines):`);
  for (const l of errLines.slice(0, cap)) console.log('  ' + l);
  if (json !== null && (json as string).length > 0) {
    let parsed;
    try {
      parsed = JSON.parse(json as string);
    } catch (e) {
      console.log(`JSON REPORT MALFORMED: ${e}`);
      console.log(json);
      return;
    }
    const msgs = (parsed.messages ?? []) as { severity: string; ID: string; message: string }[];
    console.log(`report: ${msgs.length} messages`);
    for (const m of msgs.slice(0, 20)) {
      console.log(`  ${m.severity} ${m.ID}: ${m.message?.slice(0, 100)}`);
    }
  } else {
    console.log(`no JSON report received (json=${json === null ? 'null' : 'empty'})`);
  }
  if (process.env.EC_RAWJSON && json) console.log(json);
});
