#!/usr/bin/env node
// Name-defaulting proofs for the source factories that now default the reported
// `source.name` from a natural name (commit 4814d4a, plugins.ts):
//
//   opfs()      -- a FileSystemFileHandle carries its own name; a string OPFS
//                  path resolves to a handle named by its last segment. Either
//                  way the resulting RangeSource.name is defaulted from the
//                  File's name (matching blob()/fs()/opfsDir()).
//   fileList()  -- when every path shares a top-level folder segment, that
//                  segment becomes the source name. In the EXPLICIT-paths case
//                  the name is derived but the paths are used VERBATIM (not
//                  stripped); in the webkitRelativePath case the shared segment
//                  is stripped AND becomes the name.
//   an explicit { name } option still OVERRIDES the defaulted name (run path).
//   genuinely nameless sources (memory(), a bare Blob) leave name undefined.
//
// Node 22+ has global File/Blob and the async slice().arrayBuffer() read path
// these plugins take on the browser MAIN thread, so the factories run here
// unchanged. opfs()'s two inputs are faked faithfully: a FileSystemFileHandle
// is a plain { kind:'file', name, getFile()->File } object (exactly the shape
// opfs()'s isFileSystemFileHandle guard accepts), and the string-path route is
// driven by a minimal navigator.storage.getDirectory() fake that returns
// directory handles whose getFileHandle() yields such a handle -- the same
// getFile()->File.name path a real browser takes.
//
//   node test/plugins-name-defaulting.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate } from '../dist/index.js';
import { opfs, fileList, memory } from '../dist/plugins.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const BAD = join(here, 'fixtures', 'test_bad.epub');
const badBytes: Uint8Array<ArrayBuffer> = new Uint8Array(readFileSync(BAD));

// A fake FileSystemFileHandle: the { kind:'file', name, getFile()->File } shape
// opfs()'s isFileSystemFileHandle guard accepts. getFile() returns a real File
// (global in Node 22+) wrapping the given bytes, so the async slice() read path
// and the file.name the plugin defaults from are both faithful.
function fakeFileHandle(name: string, bytes: Uint8Array<ArrayBuffer>): FileSystemFileHandle {
  return {
    kind: 'file',
    name,
    async getFile() {
      return new File([bytes], name);
    },
  } as unknown as FileSystemFileHandle;
}

test('opfs(FileSystemFileHandle) defaults name from the file', async () => {
  const source = await opfs(fakeFileHandle('handle-book.epub', badBytes));
  assert.equal(source.name, 'handle-book.epub');
});

test('opfs(string OPFS path) defaults name to the last path segment', async () => {
  // Minimal navigator.storage fake: getDirectory() -> a root whose
  // getDirectoryHandle("dir") descends and getFileHandle("book.epub") yields a
  // handle named by that last segment. opfs() calls getFile() on it, and the
  // File's name (the last segment) becomes the source name.
  const root = {
    async getDirectoryHandle(part: string): Promise<unknown> {
      assert.equal(part, 'dir');
      return {
        async getFileHandle(name: string): Promise<unknown> {
          return fakeFileHandle(name, badBytes);
        },
      };
    },
    async getFileHandle(name: string): Promise<unknown> {
      return fakeFileHandle(name, badBytes);
    },
  };
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    value: { storage: { async getDirectory() { return root; } } },
    configurable: true,
  });
  try {
    const source = await opfs('dir/book.epub');
    assert.equal(source.name, 'book.epub');
  } finally {
    if (prior) Object.defineProperty(globalThis, 'navigator', prior);
    else delete (globalThis as { navigator?: unknown }).navigator;
  }
});

test('fileList() explicit paths: shared segment names the source, paths stay verbatim', () => {
  const f1 = new File([new Uint8Array([1])], 'mimetype');
  const f2 = new File([new Uint8Array([2])], 'container.xml');
  const paths = new Map<File, string>([
    [f1, 'mybook/mimetype'],
    [f2, 'mybook/META-INF/container.xml'],
  ]);
  const source = fileList([f1, f2], { paths });
  assert.equal(source.name, 'mybook');
  // Explicit paths are NOT stripped: the listing keeps the full paths verbatim.
  const listed = source.list().map((e) => e.path).sort();
  assert.deepEqual(listed, ['mybook/META-INF/container.xml', 'mybook/mimetype']);
});

test('fileList() webkitRelativePath: shared segment is stripped AND becomes the name', () => {
  const g1 = new File([new Uint8Array([1])], 'mimetype');
  (g1 as File & { webkitRelativePath: string }).webkitRelativePath = 'wbook/mimetype';
  const g2 = new File([new Uint8Array([2])], 'container.xml');
  (g2 as File & { webkitRelativePath: string }).webkitRelativePath = 'wbook/META-INF/container.xml';
  const source = fileList([g1, g2]);
  assert.equal(source.name, 'wbook');
  // The shared segment is stripped from every path in this (implicit) case.
  const listed = source.list().map((e) => e.path).sort();
  assert.deepEqual(listed, ['META-INF/container.xml', 'mimetype']);
});

test('an explicit { name } option overrides the defaulted source name (run path)', async () => {
  // The opfs() source defaults its name to the file name; the run path prefers
  // opts.name when given. Prove it end-to-end: the reported message locations
  // carry the OVERRIDE name, never the defaulted one.
  const defaulted = await validate(await opfs(fakeFileHandle('defaulted.epub', badBytes)));
  assert.ok(
    defaulted.stderr.includes('defaulted.epub'),
    'defaulted run should report the file-defaulted name',
  );

  const overridden = await validate(
    await opfs(fakeFileHandle('defaulted.epub', badBytes)),
    { name: 'OVERRIDE.epub' },
  );
  assert.ok(
    overridden.stderr.includes('OVERRIDE.epub'),
    'overridden run should report the explicit name',
  );
  assert.ok(
    !overridden.stderr.includes('defaulted.epub'),
    'the defaulted name must not leak once overridden',
  );
});

test('genuinely nameless sources leave name undefined', () => {
  // memory(bytes): no natural name.
  assert.equal(memory(badBytes).name, undefined);
});

// A bare Blob (not a File) passed to blob() also has no name. blob() is exported
// from the same module; import lazily to keep this assertion beside the others.
test('a bare Blob (not a File) leaves blob().name undefined', async () => {
  const { blob } = await import('../dist/plugins.js');
  const bare = new Blob([badBytes]);
  assert.equal(blob(bare).name, undefined);
});
