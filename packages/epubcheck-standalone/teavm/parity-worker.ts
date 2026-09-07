// Child-process entry for parity-teavm.ts: validates ONE epub through the
// TeaVM build in plain-CLI mode (__ecPlain -- no --json injection, so the
// textual output matches the jar CLI) and reports {exit, stdout, stderr} as a
// single JSON line on fd 3 (keeping fds 1/2 free for stray runtime noise).
import { openSync, fstatSync, readSync, writeSync } from 'node:fs';
import { basename, join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const epubPath = process.argv[2];
if (!epubPath) {
  console.error('usage: node parity-worker.ts <epub>');
  process.exit(2);
}

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
g.__ecPlain = true;

const outLines: string[] = [];
const errLines: string[] = [];
console.info = (...a: unknown[]) => {
  outLines.push(a.join(' '));
};
console.error = (...a: unknown[]) => {
  errLines.push(a.join(' '));
};

const mod = require(join(here, 'build/generated/teavm/js/epubcheck.js'));
mod.main([], (err: unknown) => {
  const payload = JSON.stringify({
    exit: err ? null : ((g.__ecExit as number | undefined) ?? null),
    err: err ? String((err as Error).stack ?? err) : null,
    stdout: outLines.join('\n'),
    stderr: errLines.join('\n'),
  });
  writeSync(3, payload);
  process.exit(0);
});
