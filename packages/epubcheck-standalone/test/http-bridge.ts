#!/usr/bin/env node
// Host-neutral proof of the browser http bridge (commit 6dfb199,
// http-bridge.ts): createHttpBridgeFetch() holds a fetched body as a
// browser-managed Blob (response.blob()) and range-reads it back with
// blob.slice().arrayBuffer(), decoding ONLY the requested block. It is
// host-neutral -- Node 22+ has global fetch/Blob/response.blob(), so the exact
// read path the browser MAIN thread takes runs here unchanged.
//
// createHttpBridgeFetch is a named export of the emitted dist/http-bridge.js
// (an internal module, but importable by the same relative-dist path the other
// suites use to reach the library -- no source change needed to test it).
//
// What this asserts (the bridge's read contract, HttpBridge in http-bridge.ts):
//   - get() reports "S" NUL status NUL handle NUL byteLength for a real corpus
//     book served over a local 127.0.0.1 http server, byteLength == file size.
//   - the WHOLE body range-reads back in 8 MiB blocks (target views into one
//     Int8Array) byte-identical to the file on disk (this book is >8 MiB, so
//     the block loop iterates several times).
//   - read() returns a Promise (async per-block -- the seam the engine suspends
//     on actually runs).
//   - an unaligned mid-body range matches disk exactly.
//   - a bounded-length read returns EXACTLY that length, never the whole body
//     (only the requested range is decoded -- the whole body is never resident).
//   - an unknown handle returns 0; a read after close() returns 0.
//
//   node test/http-bridge.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpBridgeFetch } from '../dist/http-bridge.js';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// A real, committed corpus book larger than one 8 MiB block, so the whole-body
// reconstruction genuinely iterates the block loop.
const BOOK = join(
  here,
  'corpus',
  'standard-ebooks',
  'lewis-carroll_alices-adventures-in-wonderland_john-tenniel.epub',
);
const disk = new Uint8Array(readFileSync(BOOK));

const NUL = String.fromCharCode(0);

// Serve the book over http on 127.0.0.1 (the async bridge fetches it back).
const server: Server = createServer((_req, res) => {
  res.writeHead(200, {
    'Content-Type': 'application/epub+zip',
    'Content-Length': disk.length,
  });
  res.end(Buffer.from(disk));
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as { port: number }).port;
const url = `http://127.0.0.1:${port}/book.epub`;

// Start the GET through the bridge and parse the NUL-joined response header.
function bridgeGet(
  bridge: ReturnType<typeof createHttpBridgeFetch>,
): Promise<{ tag: string; status: number; handle: number; length: number }> {
  return new Promise((resolve) => {
    bridge.get(url, (response: string) => {
      const [tag, status, handle, length] = response.split(NUL);
      resolve({
        tag: tag ?? '',
        status: Number(status),
        handle: Number(handle),
        length: Number(length),
      });
    });
  });
}

test('http bridge Blob range-read: whole body, mid-range, bounds, handles', async (t) => {
  const bridge = createHttpBridgeFetch();
  t.after(async () => {
    await bridge.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const header = await bridgeGet(bridge);
  assert.equal(header.tag, 'S', 'success header tag');
  assert.equal(header.status, 200, 'http status');
  assert.equal(header.length, disk.length, 'reported byteLength equals file size');
  assert.ok(disk.length > 8 * 1024 * 1024, 'fixture is larger than one 8 MiB block');
  const handle = header.handle;

  // read() is async: the very first call returns a Promise (the @Async seam).
  const firstRead = bridge.read(new Int8Array(16), handle, 0, 16);
  assert.ok(
    typeof (firstRead as { then?: unknown }).then === 'function',
    'read() returns a Promise (async per-block)',
  );
  await firstRead;

  // Reconstruct the WHOLE body in 8 MiB blocks: each block reads into its own
  // target view (byteOffset into the shared Int8Array), exactly as the engine
  // hands the bridge a per-block Int8Array view over the requesting Java byte[].
  const BLOCK = 8 * 1024 * 1024;
  const out = new Int8Array(header.length);
  let offset = 0;
  let iterations = 0;
  while (offset < header.length) {
    const length = Math.min(BLOCK, header.length - offset);
    const target = out.subarray(offset, offset + length);
    const n = await bridge.read(target, handle, offset, length);
    assert.equal(n, length, `block at ${offset} returns exactly its length`);
    offset += n;
    iterations++;
  }
  assert.ok(iterations >= 2, `block loop iterated multiple times (was ${iterations})`);
  const reconstructed = new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
  assert.deepEqual(reconstructed, disk, 'reconstructed body is byte-identical to disk');

  // An unaligned mid-body range matches disk exactly.
  const midOffset = 1_234_567;
  const midLength = 9_999;
  const midView = new Int8Array(midLength);
  const midN = await bridge.read(midView, handle, midOffset, midLength);
  assert.equal(midN, midLength, 'mid-range read returns the requested length');
  assert.deepEqual(
    new Uint8Array(midView.buffer, midView.byteOffset, midLength),
    disk.subarray(midOffset, midOffset + midLength),
    'unaligned mid-body range is byte-identical to disk',
  );

  // A bounded-length read returns EXACTLY that length -- only the requested
  // range is decoded; the whole body is never required resident.
  const boundedLen = 100;
  const boundedN = await bridge.read(new Int8Array(boundedLen), handle, 50, boundedLen);
  assert.equal(boundedN, boundedLen, 'bounded read returns exactly the requested length');

  // An unknown handle returns 0.
  const unknownN = await bridge.read(new Int8Array(8), 9999, 0, 8);
  assert.equal(unknownN, 0, 'unknown handle returns 0');

  // A read after close() returns 0 (the bodies are dropped).
  bridge.close();
  const afterCloseN = await bridge.read(new Int8Array(8), handle, 0, 8);
  assert.equal(afterCloseN, 0, 'read after close() returns 0');
});
