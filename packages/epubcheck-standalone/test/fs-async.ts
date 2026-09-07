#!/usr/bin/env node
// Test for the `fs()` range source over ASYNC and SYNC-ONLY backends.
//
// The plugin PREFERS a promise-based FileHandle API (node:fs/promises shape)
// and falls back to the synchronous fd API only when no async open exists.
// This suite wraps the real node:fs promises API into a fake async-only
// backend (no sync methods at all) and proves, with instrumented method
// counters:
//   (a) a clean book validates with a verdict IDENTICAL to the sync path's;
//   (b) an error book's results are IDENTICAL too;
//   (c) when BOTH APIs are present the ASYNC one is chosen (sync untouched);
//   (d) the SYNC-ONLY fallback still works (async absent -> sync methods used);
//   (e) an async read that REJECTS surfaces as a clean validation failure, and
//       the engine is REUSABLE afterwards (a clean run after the failure).
//
//   node test/fs-async.ts

import { open as fspOpen } from 'node:fs/promises';
import {
  openSync as realOpenSync,
  fstatSync as realFstatSync,
  readSync as realReadSync,
  closeSync as realCloseSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate } from '../dist/index.js';
import { fs as fsSource } from '../dist/plugins.js';
import type { EpubCheckResult } from '../dist/index.js';
import type { FsBackend } from '../dist/plugins.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, 'fixtures');
const CLEAN = join(fixtures, 'test.epub');
const BAD = join(fixtures, 'test_bad.epub');

let failures = 0;
function check(name: string, cond: unknown, detail?: string): void {
  if (cond) {
    console.log(`  ok  - ${name}`);
  } else {
    failures++;
    console.log(`  NOT OK - ${name}${detail ? ': ' + detail : ''}`);
  }
}

interface Counters {
  openSync: number;
  fstatSync: number;
  readSync: number;
  closeSync: number;
  open: number;
  stat: number;
  read: number;
  close: number;
}
const zero = (): Counters => ({
  openSync: 0,
  fstatSync: 0,
  readSync: 0,
  closeSync: 0,
  open: 0,
  stat: 0,
  read: 0,
  close: 0,
});

// A promises-only backend: exactly the node:fs/promises FileHandle shape, no
// sync methods and no `.promises` namespace -- so the plugin uses it directly.
// Every call is counted.
function asyncOnlyBackend(c: Counters): FsBackend {
  return {
    open: async (path: string, flags: 'r') => {
      c.open++;
      const fh = await fspOpen(path, flags);
      return {
        stat: async () => {
          c.stat++;
          return { size: (await fh.stat()).size };
        },
        read: async (buffer: Uint8Array, offset: number, length: number, position: number) => {
          c.read++;
          const r = await fh.read(buffer, offset, length, position);
          return { bytesRead: r.bytesRead };
        },
        close: async () => {
          c.close++;
          await fh.close();
        },
      };
    },
  };
}

// A sync-only backend: exactly the four fd calls, no async open anywhere -- so
// the plugin takes the sync fallback. Every call is counted.
function syncOnlyBackend(c: Counters): FsBackend {
  return {
    openSync: (path: string, flags: 'r') => {
      c.openSync++;
      return realOpenSync(path, flags);
    },
    fstatSync: (fd: number) => {
      c.fstatSync++;
      return { size: realFstatSync(fd).size };
    },
    readSync: (fd: number, buffer: Uint8Array, offset: number, length: number, position: number) => {
      c.readSync++;
      return realReadSync(fd, buffer, offset, length, position);
    },
    closeSync: (fd: number) => {
      c.closeSync++;
      realCloseSync(fd);
    },
  };
}

// A backend carrying BOTH APIs: sync fd methods AND a `.promises` namespace
// (exactly node:fs's shape). The plugin must PREFER the async one.
function bothBackend(c: Counters): FsBackend {
  const sync = syncOnlyBackend(c) as Record<string, unknown>;
  const asyncNs = asyncOnlyBackend(c) as { open: unknown };
  return { ...sync, promises: { open: asyncNs.open } } as unknown as FsBackend;
}

// Compare only the caller-facing verdict fields (stdout carries timing-free
// text but is kept out of the identity check to stay robust).
function verdict(r: EpubCheckResult): string {
  return JSON.stringify({
    valid: r.valid,
    exitCode: r.exitCode,
    summary: r.summary,
    messages: r.messages,
  });
}

// --- (a)+(b): async verdict === sync verdict, on a clean AND an error book ---
for (const [label, path] of [
  ['clean', CLEAN],
  ['error', BAD],
] as const) {
  console.log(`fs() ${label} book: async-only backend must match the sync path:`);
  const syncCounters = zero();
  const syncResult = await validate(await fsSource(path, { fs: syncOnlyBackend(syncCounters) }), {
    name: `${label}.epub`,
  });
  const asyncCounters = zero();
  const asyncResult = await validate(await fsSource(path, { fs: asyncOnlyBackend(asyncCounters) }), {
    name: `${label}.epub`,
  });

  check(`${label}: sync fallback used readSync`, syncCounters.readSync > 0, JSON.stringify(syncCounters));
  check(`${label}: sync fallback made no async calls`, syncCounters.open === 0 && syncCounters.read === 0);
  check(`${label}: async backend used the promise read (suspend path)`, asyncCounters.read > 0, JSON.stringify(asyncCounters));
  check(`${label}: async backend made no sync calls`, asyncCounters.readSync === 0 && asyncCounters.openSync === 0);
  check(
    `${label}: verdict identical (async === sync)`,
    verdict(asyncResult) === verdict(syncResult),
    `async=${verdict(asyncResult)} sync=${verdict(syncResult)}`,
  );
  check(`${label}: async handle closed once`, asyncCounters.close === 1, `close=${asyncCounters.close}`);
}

// --- (c): both APIs present -> the ASYNC one is chosen, sync untouched ---
console.log('fs() with BOTH sync + async APIs present: async must win:');
const bothCounters = zero();
const bothResult = await validate(await fsSource(CLEAN, { fs: bothBackend(bothCounters) }), { name: 'both.epub' });
check('both: async open used', bothCounters.open > 0, JSON.stringify(bothCounters));
check('both: async read used', bothCounters.read > 0, JSON.stringify(bothCounters));
check('both: async stat used', bothCounters.stat > 0, JSON.stringify(bothCounters));
check(
  'both: NO sync method touched',
  bothCounters.openSync === 0 &&
    bothCounters.fstatSync === 0 &&
    bothCounters.readSync === 0 &&
    bothCounters.closeSync === 0,
  JSON.stringify(bothCounters),
);
check('both: clean book still valid', bothResult.valid === true, `valid=${bothResult.valid}`);

// --- (e): a rejecting async read fails cleanly, engine reusable afterwards ---
console.log('fs() async read that REJECTS: must fail cleanly, engine reusable:');
// open + stat succeed on a real handle; read always rejects; close releases it.
function rejectingBackend(): FsBackend {
  return {
    open: async (path: string, flags: 'r') => {
      const fh = await fspOpen(path, flags);
      return {
        stat: async () => ({ size: (await fh.stat()).size }),
        read: async (): Promise<{ bytesRead: number }> => {
          throw new Error('host read exploded');
        },
        close: async () => {
          await fh.close();
        },
      };
    },
  };
}
const rejected = await validate(await fsSource(BAD, { fs: rejectingBackend() }), { name: 'boom.epub' });
check('reject: run did not report valid', rejected.valid === false, `valid=${rejected.valid}`);
check('reject: nonzero exit', rejected.exitCode !== 0, `exit=${rejected.exitCode}`);

// Engine must be reusable: a clean async validation right after the failure.
const afterCounters = zero();
const after = await validate(await fsSource(CLEAN, { fs: asyncOnlyBackend(afterCounters) }), { name: 'after.epub' });
check('reuse: clean run after failure is valid', after.valid === true, `valid=${after.valid}`);
check('reuse: clean run after failure exit 0', after.exitCode === 0, `exit=${after.exitCode}`);

// --- (f): an UNREADABLE file (open EACCES/EPERM) is DEFERRED, not thrown ---
// fs() used to throw EACCES/EPERM at open(); it now DEFERS like the jar,
// returning a source whose reads throw the Java-shaped message so EPUBCheck
// reports FATAL(PKG-008) itself. A backend whose open() rejects with the code
// stands in for a permission-locked file (the injected path never reaches a
// real host stat, so the size floors at 1). CLEAN is a readable real file, so
// node:fs/promises.stat gives its real size on this path.
function unreadableBackend(code: 'EACCES' | 'EPERM'): FsBackend {
  return {
    open: async (_path: string, _flags: 'r'): Promise<never> => {
      const err = new Error('open denied by test backend') as Error & { code: string };
      err.code = code;
      throw err;
    },
  };
}
for (const [code, reason] of [
  ['EACCES', 'Permission denied'],
  ['EPERM', 'Operation not permitted'],
] as const) {
  console.log(`fs() unreadable file (${code}): must DEFER, not throw at open:`);
  let source: Awaited<ReturnType<typeof fsSource>> | undefined;
  let threwAtOpen = false;
  try {
    source = await fsSource(CLEAN, { fs: unreadableBackend(code) });
  } catch {
    threwAtOpen = true;
  }
  check(`${code}: fs() returned a source instead of throwing`, !threwAtOpen && source !== undefined);
  if (source) {
    check(`${code}: deferred source size floored >= 1`, source.size >= 1, `size=${source.size}`);
    let readErr: unknown;
    try {
      source.read(0, 1);
    } catch (e) {
      readErr = e;
    }
    check(
      `${code}: deferred read throws the Java-shaped message`,
      readErr instanceof Error && readErr.message === `${CLEAN} (${reason})`,
      String((readErr as Error | undefined)?.message),
    );
    // Drive the deferred source through the engine: it must surface as an
    // invalid run (FATAL PKG-008) with a nonzero exit, and the engine stays
    // reusable afterwards.
    const deferredRun = await validate(await fsSource(CLEAN, { fs: unreadableBackend(code) }), {
      name: 'locked.epub',
    });
    check(`${code}: deferred run reports invalid`, deferredRun.valid === false, `valid=${deferredRun.valid}`);
    check(`${code}: deferred run nonzero exit`, deferredRun.exitCode !== 0, `exit=${deferredRun.exitCode}`);
  }
}

// A non-permission open error still throws right away (fail fast).
console.log('fs() open error other than EACCES/EPERM: must still throw:');
let enoentThrew = false;
try {
  await fsSource(CLEAN, {
    fs: {
      open: async (): Promise<never> => {
        const e = new Error('no such file') as Error & { code: string };
        e.code = 'ENOENT';
        throw e;
      },
    } as FsBackend,
  });
} catch {
  enoentThrew = true;
}
check('ENOENT open error is rethrown (fail fast, not deferred)', enoentThrew);

// A NORMAL fs() run is unchanged: a clean async validation still passes right
// after all the deferral machinery above exercised the failure paths.
console.log('fs() normal run after the deferral cases: must be unchanged:');
const normalAfterCounters = zero();
const normalAfter = await validate(
  await fsSource(CLEAN, { fs: asyncOnlyBackend(normalAfterCounters) }),
  { name: 'normal-after.epub' },
);
check('normal: clean run still valid', normalAfter.valid === true, `valid=${normalAfter.valid}`);
check('normal: clean run exit 0', normalAfter.exitCode === 0, `exit=${normalAfter.exitCode}`);
check('normal: real read path exercised', normalAfterCounters.read > 0, JSON.stringify(normalAfterCounters));

console.log('');
if (failures) {
  console.error(`FS-ASYNC TEST FAILED: ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log('FS-ASYNC TEST PASSED');
