#!/usr/bin/env node
// Async-path proofs for the file-backed range/directory PLUGINS that read
// through the async platform APIs -- blob() and fileList().
//
// Since the async-first sweep (2026-09-06) these plugins have ONE read path:
// they await `blob.slice(offset, end).arrayBuffer()` on every thread (no
// FileReaderSync preference anymore). Node has global `Blob`/`File` and no
// `FileReaderSync`, so the exact async read path these plugins take on the
// browser MAIN thread runs here unchanged -- letting us prove in Node:
//   (a) read() returns a PROMISE (async-first, the seam that suspends the
//       engine actually runs);
//   (b) the verdict is IDENTICAL to the same bytes fed a different way
//       (blob === memory; fileList === fsDir over the unzipped tree);
//   (c) a rejecting async read surfaces as a proper failure and the engine
//       stays REUSABLE afterwards (a clean run right after the failure).
//
// opfs()/opfsDir() need Worker-only-or-not OPFS APIs that Node lacks; their
// main-thread async paths are proven by testing/browser/main-thread-check.ts.
//
//   node test/plugins-async.ts

import { validate } from '../dist/index.js';
import { blob, memory, fileList, fsDir } from '../dist/plugins.js';
import type { EpubCheckResult } from '../dist/index.js';
import type { RangeSource, FsDirBackend } from '../dist/plugins.js';
import {
  readFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
  openSync as realOpenSync,
  fstatSync as realFstatSync,
  readSync as realReadSync,
  closeSync as realCloseSync,
  statSync as realStatSync,
  readdirSync as realReaddirSync,
} from 'node:fs';
import {
  open as fspOpen,
  readdir as fspReaddir,
  stat as fspStat,
} from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, 'fixtures');
const CLEAN = join(fixtures, 'test.epub');
const BAD = join(fixtures, 'test_bad.epub');

const DISPOSE: typeof Symbol.dispose =
  Symbol.dispose ?? (Symbol.for('Symbol.dispose') as typeof Symbol.dispose);

let failures = 0;
function check(name: string, cond: unknown, detail?: string): void {
  if (cond) {
    console.log(`  ok  - ${name}`);
  } else {
    failures++;
    console.log(`  NOT OK - ${name}${detail ? ': ' + detail : ''}`);
  }
}

// Caller-facing verdict fields only (stdout carries timing-free text but is
// kept out of the identity check to stay robust).
function verdict(r: EpubCheckResult): string {
  return JSON.stringify({
    valid: r.valid,
    exitCode: r.exitCode,
    summary: r.summary,
    messages: r.messages,
  });
}

function isPromise(v: unknown): v is Promise<unknown> {
  return typeof v === 'object' && v !== null && typeof (v as { then?: unknown }).then === 'function';
}

// --- blob(): async read, verdict identity vs memory() -----------------------
for (const [label, path] of [
  ['clean', CLEAN],
  ['error', BAD],
] as const) {
  console.log(`blob() ${label} book: async read path, verdict must match memory():`);
  const bytes = new Uint8Array(readFileSync(path));
  const file = new File([bytes], `${label}.epub`);

  // (a) async-first: a fresh source's read() returns a promise, then dispose.
  const probe = blob(file);
  const readResult = probe.read(0, Math.min(16, bytes.length));
  check(`${label}: blob().read returns a promise (async path)`, isPromise(readResult));
  await readResult;
  probe[DISPOSE]();
  check(`${label}: blob() carries the File name`, probe.name === `${label}.epub`, probe.name);

  // (b) verdict identity: blob(file) === memory(bytes).
  const viaBlob = await validate(blob(file));
  const viaMemory = await validate(memory(bytes), { name: `${label}.epub` });
  check(
    `${label}: blob() verdict identical to memory()`,
    verdict(viaBlob) === verdict(viaMemory),
    `blob=${verdict(viaBlob)} memory=${verdict(viaMemory)}`,
  );
}

// (c) blob-shaped rejecting async read fails cleanly; engine reusable after.
console.log('blob(): a rejecting async read fails cleanly, engine reusable:');
{
  const bytes = new Uint8Array(readFileSync(BAD));
  const rejecting: RangeSource = {
    size: bytes.length,
    name: 'boom.epub',
    read: async () => {
      throw new Error('blob read exploded');
    },
    [DISPOSE]() {},
  };
  const rejected = await validate(rejecting);
  check('reject: run did not report valid', rejected.valid === false, `valid=${rejected.valid}`);
  check('reject: nonzero exit', rejected.exitCode !== 0, `exit=${rejected.exitCode}`);

  const after = await validate(blob(new File([bytes], 'after.epub')));
  check('reuse: clean run after failure completes', typeof after.exitCode === 'number', `exit=${after.exitCode}`);
}

// --- fileList(): async read, verdict identity vs fsDir() --------------------
console.log('\nfileList() expanded book: async read path, verdict must match fsDir():');
{
  const src = join(here, 'corpus', 'epubcheck-prezipped', 'epub3_00-minimal_files_minimal.epub');
  const haveUnzip = spawnSync('unzip', ['-v'], { encoding: 'utf8' }).status === 0;
  check('unzip binary is available', haveUnzip);
  check('corpus book exists', existsSync(src), src);
  if (haveUnzip && existsSync(src)) {
    const tmp = mkdtempSync(join(tmpdir(), 'epubcheck-plugasync-'));
    try {
      const dir = join(tmp, 'minimal');
      mkdirSync(dir);
      spawnSync('unzip', ['-q', src, '-d', dir], { encoding: 'utf8' });

      // Build a File[] plus an explicit path map (Node's File has no
      // webkitRelativePath), exactly the shape a folder drop produces.
      const walk = (d: string, acc: string[]): string[] => {
        for (const entry of readdirSync(d, { withFileTypes: true })) {
          const abs = join(d, entry.name);
          if (entry.isDirectory()) walk(abs, acc);
          else acc.push(abs);
        }
        return acc;
      };
      const absPaths = walk(dir, []);
      const files: File[] = [];
      const paths = new Map<File, string>();
      for (const abs of absPaths) {
        const rel = relative(dir, abs).split(/[\\/]/).join('/');
        const f = new File([new Uint8Array(readFileSync(abs))], rel.split('/').pop()!);
        files.push(f);
        paths.set(f, rel);
      }

      // (a) async-first: read() returns a promise.
      const probe = fileList(files, { paths });
      const first = probe.list()[0]!;
      const readResult = probe.read(first.path, 0, Math.min(4, first.size));
      check('fileList().read returns a promise (async path)', isPromise(readResult));
      await readResult;

      // (b) verdict identity: fileList === fsDir over the same tree. dirMode is
      // explicit 'exp' throughout this suite: the library default is 'direct',
      // which errors "Mode required" on a non-`.epub`-named directory, so a
      // clean-book run needs packaging. Backend identity is what's under test.
      const viaFileList = await validate(fileList(files, { paths }), { name: 'minimal', dirMode: 'exp' });
      const viaFsDir = await validate(await fsDir(dir), { name: 'minimal', dirMode: 'exp' });
      check('fileList() validates (exit 0)', viaFileList.exitCode === 0, `exit=${viaFileList.exitCode}`);
      check(
        'fileList() engine really ran (version line present)',
        /Validating using EPUB version/.test(viaFileList.stdout),
        viaFileList.stdout.slice(0, 120),
      );
      check(
        'fileList() verdict identical to fsDir()',
        verdict(viaFileList) === verdict(viaFsDir),
        `fileList=${verdict(viaFileList)} fsDir=${verdict(viaFsDir)}`,
      );

      // (c) a rejecting fileList read fails cleanly; engine reusable after.
      const rejecting = {
        name: 'minimal',
        list: () => probe.list(),
        read: async (): Promise<Uint8Array> => {
          throw new Error('fileList read exploded');
        },
        [DISPOSE]() {},
      };
      const rejected = await validate(rejecting, { dirMode: 'exp' });
      check('fileList reject: not valid', rejected.valid === false, `valid=${rejected.valid}`);
      check('fileList reject: nonzero exit', rejected.exitCode !== 0, `exit=${rejected.exitCode}`);
      const after = await validate(fileList(files, { paths }), { name: 'minimal', dirMode: 'exp' });
      check('fileList reuse: clean run after failure exit 0', after.exitCode === 0, `exit=${after.exitCode}`);

      // --- fsDir(): async-first backend injection over the same tree ----------
      // fsDir now mirrors fs(): it PREFERS a promise-based backend (async
      // readdir/stat walk + FileHandle reads) and falls back to the sync
      // FsDirLike surface only when the backend has no promise-based open.
      console.log('\nfsDir() expanded book: async-first backend injection:');

      interface DirCounters {
        openSync: number; readSync: number; readdirSync: number; statSync: number;
        open: number; readdir: number; stat: number; read: number;
      }
      const dirZero = (): DirCounters => ({
        openSync: 0, readSync: 0, readdirSync: 0, statSync: 0,
        open: 0, readdir: 0, stat: 0, read: 0,
      });

      // A promises-ONLY backend: node:fs/promises shape (open/readdir/stat),
      // NO sync methods and no `.promises` namespace -- so fsDir uses it
      // directly. Every call is counted.
      function asyncOnlyDirBackend(c: DirCounters): FsDirBackend {
        return {
          open: async (p: string, flags: 'r') => {
            c.open++;
            const fh = await fspOpen(p, flags);
            return {
              stat: async () => ({ size: (await fh.stat()).size }),
              read: async (buffer: Uint8Array, offset: number, length: number, position: number) => {
                c.read++;
                const r = await fh.read(buffer, offset, length, position);
                return { bytesRead: r.bytesRead };
              },
              close: async () => { await fh.close(); },
            };
          },
          readdir: async (p: string, options: { withFileTypes: true }) => {
            c.readdir++;
            return fspReaddir(p, options);
          },
          stat: async (p: string) => {
            c.stat++;
            const s = await fspStat(p);
            return { size: s.size, isDirectory: () => s.isDirectory() };
          },
        } as unknown as FsDirBackend;
      }

      // A sync-only backend: the six FsDirLike calls, no async open anywhere --
      // so fsDir takes the sync fallback. Every call is counted.
      function syncOnlyDirBackend(c: DirCounters): FsDirBackend {
        return {
          openSync: (p: string, flags: 'r') => { c.openSync++; return realOpenSync(p, flags); },
          fstatSync: (fd: number) => ({ size: realFstatSync(fd).size }),
          readSync: (fd: number, buffer: Uint8Array, offset: number, length: number, position: number) => {
            c.readSync++;
            return realReadSync(fd, buffer, offset, length, position);
          },
          closeSync: (fd: number) => { realCloseSync(fd); },
          readdirSync: (p: string, options: { withFileTypes: true }) => {
            c.readdirSync++;
            return realReaddirSync(p, options);
          },
          statSync: (p: string) => {
            c.statSync++;
            const s = realStatSync(p);
            return { size: s.size, isDirectory: () => s.isDirectory() };
          },
        } as unknown as FsDirBackend;
      }

      // Baseline: default node:fs. It carries a `.promises` namespace, so fsDir
      // MUST take the preferred async path -- its read() returns a promise.
      const defProbe = await fsDir(dir);
      const defFirst = defProbe.list()[0]!;
      const defRead = defProbe.read(defFirst.path, 0, Math.min(4, defFirst.size));
      check('fsDir(node:fs): read() returns a promise (preferred path taken)', isPromise(defRead));
      await defRead;
      defProbe[DISPOSE]();
      const viaDefault = await validate(await fsDir(dir), { name: 'minimal', dirMode: 'exp' });

      // Promises-only backend: validates successfully, verdict identical, and
      // the async methods (not any sync method) were used.
      const asyncC = dirZero();
      const asyncProbe = await fsDir(dir, { fs: asyncOnlyDirBackend(asyncC) });
      const asyncFirst = asyncProbe.list()[0]!;
      const asyncRead = asyncProbe.read(asyncFirst.path, 0, Math.min(4, asyncFirst.size));
      check('fsDir(async-only): read() returns a promise', isPromise(asyncRead));
      await asyncRead;
      asyncProbe[DISPOSE]();
      const viaAsync = await validate(await fsDir(dir, { fs: asyncOnlyDirBackend(asyncC) }), { name: 'minimal', dirMode: 'exp' });
      check('fsDir(async-only): validates (exit 0)', viaAsync.exitCode === 0, `exit=${viaAsync.exitCode}`);
      check('fsDir(async-only): async readdir + stat + read used', asyncC.readdir > 0 && asyncC.stat > 0 && asyncC.read > 0, JSON.stringify(asyncC));
      check('fsDir(async-only): NO sync method touched', asyncC.openSync === 0 && asyncC.readSync === 0 && asyncC.readdirSync === 0 && asyncC.statSync === 0, JSON.stringify(asyncC));
      check('fsDir(async-only): verdict identical to node:fs', verdict(viaAsync) === verdict(viaDefault), `async=${verdict(viaAsync)} default=${verdict(viaDefault)}`);

      // Sync-only backend: the fallback still works -- read() is synchronous
      // (a Uint8Array, not a promise), verdict identical, no async touched.
      const syncC = dirZero();
      const syncProbe = await fsDir(dir, { fs: syncOnlyDirBackend(syncC) });
      const syncFirst = syncProbe.list()[0]!;
      const syncRead = syncProbe.read(syncFirst.path, 0, Math.min(4, syncFirst.size));
      check('fsDir(sync-only): read() is synchronous (Uint8Array, fallback path)', syncRead instanceof Uint8Array);
      syncProbe[DISPOSE]();
      const viaSync = await validate(await fsDir(dir, { fs: syncOnlyDirBackend(syncC) }), { name: 'minimal', dirMode: 'exp' });
      check('fsDir(sync-only): fallback readSync used, no async open', syncC.readSync > 0 && syncC.open === 0, JSON.stringify(syncC));
      check('fsDir(sync-only): verdict identical to node:fs', verdict(viaSync) === verdict(viaDefault), `sync=${verdict(viaSync)} default=${verdict(viaDefault)}`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
}

console.log('');
if (failures) {
  console.error(`PLUGINS-ASYNC TEST FAILED: ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log('PLUGINS-ASYNC TEST PASSED');
