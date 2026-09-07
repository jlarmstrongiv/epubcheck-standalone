// Child-process entry for reports-teavm.ts: runs ONE epub through the TeaVM
// build with epubcheck's own --json/--out/--xmp writers (relative input arg so
// report "path" fields match the jar ground-truth invocation) and reports the
// three files as JSON on fd 3.
import { openSync, fstatSync, readSync, writeSync } from 'node:fs';
import { basename, join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const epubPath = process.argv[2];
const format = process.argv[3]; // json | xml | xmp
if (!epubPath || !format) {
  console.error('usage: node report-worker.ts <epub> <json|xml|xmp>');
  process.exit(2);
}
const FLAG: Record<string, string> = { json: '--json', xml: '--out', xmp: '--xmp' };

const g = globalThis as Record<string, unknown>;
// Range-read feed: the file stays on disk, ranges served by positional
// fs.readSync into the engine-provided buffer view.
const fd = openSync(epubPath, 'r');
g.__ecSize = fstatSync(fd).size;
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
g.__epubArgs = [FLAG[format] as string, '/work/out.' + format];
g.__ecRelArg = true;
g.__ecPlain = true; // suppress the wrapper's own --json injection
// Ground truth was generated with the host-local TZ (see testing/report-groundtruth.ts).
g.__ecTZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

const files: Record<string, string> = {};
g.__ecFile = (name: string, content: string) => {
  files[name] = content;
};

console.info = () => {};
console.error = () => {};

const mod = require(join(here, 'build/generated/teavm/js/epubcheck.js'));
mod.main([], (err: unknown) => {
  const payload = JSON.stringify({
    exit: err ? null : ((g.__ecExit as number | undefined) ?? null),
    err: err ? String((err as Error).stack ?? err) : null,
    files,
  });
  writeSync(3, payload);
  process.exit(0);
});
