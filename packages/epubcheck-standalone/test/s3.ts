#!/usr/bin/env node
// S3 source-plugin suite -- proves s3() (single packaged .epub) and s3Dir()
// (expanded book under a key prefix) against a REAL S3-compatible server.
//
//   node test/s3.ts
//
// The server is a pure-Node, dependency-free, in-process HTTP server that
// speaks enough of the S3 REST API for the plugins: HeadObject, ranged
// GetObject (Range: bytes=start-end, end INCLUSIVE), and ListObjectsV2 with
// ContinuationToken PAGINATION (page size 2, so multi-object books force
// several pages). It is portable (no Docker, no MinIO) and records every GET's
// Range header so the test can assert the plugins issue BOUNDED ranged reads
// and NEVER a whole-object GET.
//
// The client is the real @aws-sdk/client-s3 S3Client, driven through the
// library's own s3ClientBackend() convenience adapter (which itself only uses
// aws-sdk via a dynamic import -- the library core stays dependency-free). So
// this exercises the full path: aws-sdk client -> real S3 wire protocol ->
// s3ClientBackend -> s3()/s3Dir() -> engine.
//
// Part 1: plugin contract (no engine, no server) -- input validation, prefix
//         stripping, name defaulting, sorted listing, safe-path + short-read
//         guards, using a hand-written structural backend (the dependency-free
//         Option-A path).
// Part 2: s3() vs blob() PARITY on a packaged .epub + ranged-read proof.
// Part 3: s3Dir() vs fsDir() PARITY on an expanded book + ranged-read proof.

import { createServer, type Server } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { validate } from '../dist/index.js';
import { s3, s3Dir, s3ClientBackend, blob } from '../dist/plugins.js';
import type { S3DirBackend } from '../dist/plugins.js';
import {
  readFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { fsDir } from '../dist/plugins.js';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  S3Client,
  HeadObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';

const here = dirname(fileURLToPath(import.meta.url));

let failures = 0;
function check(name: string, cond: unknown, detail?: string): void {
  if (cond) {
    console.log(`  ok  - ${name}`);
  } else {
    failures++;
    console.log(`  NOT OK - ${name}${detail ? ': ' + detail : ''}`);
  }
}
async function rejects(fn: () => Promise<unknown> | unknown, match: RegExp): Promise<string | null> {
  try {
    await fn();
    return 'did not throw';
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return match.test(message) ? null : `threw the wrong error: ${message}`;
  }
}

// ---------------------------------------------------------------------------
// A pure-Node, in-process, S3-compatible HTTP server (path-style addressing).
// ---------------------------------------------------------------------------
interface StoredObject {
  bytes: Uint8Array;
  etag: string;
}
interface RangeRecord {
  key: string;
  range: string | null; // null = a whole-object GET (no Range header)
  bytes: number;
}
interface MockS3 {
  endpoint: string;
  put(key: string, bytes: Uint8Array): void;
  ranges: RangeRecord[];
  resetRanges(): void;
  close(): Promise<void>;
  server: Server;
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// A Blob over bytes -- cast past the DOM lib's ArrayBuffer/SharedArrayBuffer
// BlobPart narrowing (the bytes are always a plain-ArrayBuffer-backed view).
function toBlob(bytes: Uint8Array): Blob {
  return new Blob([bytes as unknown as BlobPart]);
}

const PAGE_SIZE = 2; // deliberately tiny: forces ListObjectsV2 pagination

async function startMockS3(): Promise<MockS3> {
  const store = new Map<string, StoredObject>();
  const ranges: RangeRecord[] = [];

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const slash = path.indexOf('/');
    const bucket = slash === -1 ? path : path.slice(0, slash);
    const key = slash === -1 ? '' : path.slice(slash + 1);

    // ListObjectsV2 (GET /<bucket>?list-type=2&prefix=...&continuation-token=...)
    if (url.searchParams.get('list-type') === '2') {
      const prefix = url.searchParams.get('prefix') ?? '';
      const token = url.searchParams.get('continuation-token') ?? undefined;
      const all = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = token ? all.indexOf(token) + 1 : 0;
      const page = all.slice(start, start + PAGE_SIZE);
      const truncated = start + PAGE_SIZE < all.length;
      const next = truncated ? page[page.length - 1] : undefined;
      const contents = page
        .map((k) => {
          const o = store.get(k)!;
          return (
            `<Contents><Key>${xmlEscape(k)}</Key>` +
            `<LastModified>2020-01-01T00:00:00.000Z</LastModified>` +
            `<ETag>&quot;${o.etag}&quot;</ETag><Size>${o.bytes.length}</Size>` +
            `<StorageClass>STANDARD</StorageClass></Contents>`
          );
        })
        .join('');
      const body =
        `<?xml version="1.0" encoding="UTF-8"?>` +
        `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` +
        `<Name>${xmlEscape(bucket)}</Name><Prefix>${xmlEscape(prefix)}</Prefix>` +
        `<KeyCount>${page.length}</KeyCount><MaxKeys>${PAGE_SIZE}</MaxKeys>` +
        `<IsTruncated>${truncated}</IsTruncated>` +
        (next ? `<NextContinuationToken>${xmlEscape(next)}</NextContinuationToken>` : '') +
        contents +
        `</ListBucketResult>`;
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      res.end(body);
      return;
    }

    const obj = store.get(key);
    if (!obj) {
      res.writeHead(404, { 'Content-Type': 'application/xml' });
      res.end(`<?xml version="1.0"?><Error><Code>NoSuchKey</Code><Key>${xmlEscape(key)}</Key></Error>`);
      return;
    }

    // HeadObject
    if (req.method === 'HEAD') {
      res.writeHead(200, {
        'Content-Length': String(obj.bytes.length),
        'Accept-Ranges': 'bytes',
        ETag: `"${obj.etag}"`,
        'Last-Modified': new Date(0).toUTCString(),
      });
      res.end();
      return;
    }

    // GetObject (optionally ranged)
    const rangeHeader = req.headers['range'] ?? null;
    const m = rangeHeader ? /^bytes=(\d+)-(\d+)$/.exec(String(rangeHeader)) : null;
    if (m) {
      const s = Number(m[1]);
      const e = Number(m[2]); // INCLUSIVE
      const slice = obj.bytes.subarray(s, e + 1);
      ranges.push({ key, range: String(rangeHeader), bytes: slice.length });
      res.writeHead(206, {
        'Content-Range': `bytes ${s}-${e}/${obj.bytes.length}`,
        'Content-Length': String(slice.length),
        'Accept-Ranges': 'bytes',
        ETag: `"${obj.etag}"`,
      });
      res.end(Buffer.from(slice));
    } else {
      ranges.push({ key, range: null, bytes: obj.bytes.length });
      res.writeHead(200, { 'Content-Length': String(obj.bytes.length), ETag: `"${obj.etag}"` });
      res.end(Buffer.from(obj.bytes));
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  return {
    endpoint: `http://127.0.0.1:${port}`,
    server,
    ranges,
    resetRanges(): void {
      ranges.length = 0;
    },
    put(key: string, bytes: Uint8Array): void {
      store.set(key, { bytes, etag: createHash('md5').update(bytes).digest('hex') });
    },
    close(): Promise<void> {
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// Build a valid EPUB whose PACKAGED size exceeds the engine's 8 MiB per-pull
// cap, so validating it forces MULTIPLE bounded ranged reads (no single range
// can cover the whole object). Done by adding a ~9 MiB INCOMPRESSIBLE resource
// (random bytes -> the zip cannot shrink it) declared in the manifest, then
// re-zipping mimetype-first per OCF. Returns the packaged .epub bytes.
function makeBigEpub(srcEpub: string): Uint8Array {
  const tmp = mkdtempSync(join(tmpdir(), 'epubcheck-s3-big-'));
  try {
    const dir = join(tmp, 'book');
    mkdirSync(dir);
    if (spawnSync('unzip', ['-q', srcEpub, '-d', dir], { encoding: 'utf8' }).status !== 0) {
      throw new Error('unzip failed building the big epub');
    }
    // ~9 MiB of random (incompressible) bytes as a manifest resource.
    const big = randomBytes(9 * 1024 * 1024);
    writeFileSync(join(dir, 'EPUB', 'big.bin'), big);
    const opfPath = join(dir, 'EPUB', 'package.opf');
    const opf = readFileSync(opfPath, 'utf8').replace(
      '</manifest>',
      '  <item id="big" href="big.bin" media-type="application/octet-stream"/>\n</manifest>',
    );
    writeFileSync(opfPath, opf);
    const out = join(tmp, 'big.epub');
    // mimetype first, stored (no compression); then the rest.
    if (spawnSync('zip', ['-X', '-0', out, 'mimetype'], { cwd: dir }).status !== 0) {
      throw new Error('zip (mimetype) failed');
    }
    if (spawnSync('zip', ['-X', '-r', out, 'META-INF', 'EPUB'], { cwd: dir }).status !== 0) {
      throw new Error('zip (contents) failed');
    }
    return new Uint8Array(readFileSync(out));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// Assert a batch of recorded reads were BOUNDED ranged GETs, never a
// whole-object GET, and never overran the object.
function assertBoundedRanges(prefix: string, recs: RangeRecord[], objectSizes: Map<string, number>): void {
  check(`${prefix}: at least one ranged GET was issued`, recs.length > 0, `records=${recs.length}`);
  check(
    `${prefix}: NO whole-object (Range-less) GET was ever issued`,
    recs.every((r) => r.range !== null),
    JSON.stringify(recs.filter((r) => r.range === null)),
  );
  const EIGHT_MIB = 8 * 1024 * 1024;
  check(
    `${prefix}: every range is <= 8 MiB (the engine's per-pull cap)`,
    recs.every((r) => r.bytes <= EIGHT_MIB),
    `max=${Math.max(...recs.map((r) => r.bytes))}`,
  );
  check(
    `${prefix}: every range stays within its object (bounded, never past EOF)`,
    recs.every((r) => {
      const size = objectSizes.get(r.key);
      const mm = /^bytes=(\d+)-(\d+)$/.exec(r.range ?? '');
      return size !== undefined && mm !== null && Number(mm[2]) < size;
    }),
    'a range exceeded its object size',
  );
}

// ---------------------------------------------------------------------------
// Part 1 -- plugin contract (no engine, no server): the dependency-free
// Option-A structural backend, driven directly.
// ---------------------------------------------------------------------------
console.log('s3 plugin contract (structural backend, no engine):');
{
  // A hand-written, dependency-free backend over an in-memory object map --
  // exactly the ~10-line adapter a caller writes over their own S3 client.
  const objects = new Map<string, Uint8Array>([
    ['books/mybook/mimetype', new TextEncoder().encode('application/epub+zip')],
    ['books/mybook/EPUB/nested/file.bin', new Uint8Array([1, 2, 3, 4, 5])],
    ['books/mybook/', new Uint8Array(0)], // a "directory marker" object -> skipped
  ]);
  const reads: Array<[string, number, number]> = [];
  const backend: S3DirBackend = {
    async size(key) {
      const b = objects.get(key);
      if (!b) throw new Error(`no such key ${key}`);
      return b.length;
    },
    async read(key, offset, length) {
      reads.push([key, offset, length]);
      const b = objects.get(key);
      if (!b) throw new Error(`no such key ${key}`);
      return b.subarray(offset, offset + length); // ranged read
    },
    async list(prefix) {
      return [...objects]
        .filter(([k]) => k.startsWith(prefix))
        .map(([key, b]) => ({ key, size: b.length }));
    },
  };

  const dir = await s3Dir('books/mybook/', { backend });
  const listing = dir.list();
  check(
    's3Dir: strips the prefix, skips the marker, lists sorted with sizes',
    JSON.stringify(listing) ===
      JSON.stringify([
        { path: 'EPUB/nested/file.bin', size: 5 },
        { path: 'mimetype', size: 20 },
      ]),
    JSON.stringify(listing),
  );
  check('s3Dir: name defaults to the prefix last segment', dir.name === 'mybook', dir.name);
  const slice = (await dir.read('EPUB/nested/file.bin', 1, 3)) as Uint8Array;
  check(
    's3Dir: read maps rel path back to the full key, returns the range',
    slice.length === 3 && slice[0] === 2 && slice[2] === 4,
    JSON.stringify([...slice]),
  );
  check(
    's3Dir: read issued a ranged read on the FULL key (prefix + rel)',
    reads.some(([k, o, l]) => k === 'books/mybook/EPUB/nested/file.bin' && o === 1 && l === 3),
    JSON.stringify(reads),
  );
  check(
    's3Dir: rejects a path not in the listing',
    (await rejects(() => dir.read('nope', 0, 1), /not in this listing/)) === null,
  );

  const one = await s3('books/mybook/mimetype', { backend });
  check('s3: size comes from the backend (HeadObject)', one.size === 20, String(one.size));
  check('s3: name defaults to the key last segment', one.name === 'mimetype', one.name);
  check('s3: no hostDir (injected/remote source)', one.hostDir === undefined, one.hostDir);
  const head = (await one.read(0, 11)) as Uint8Array;
  check(
    's3: read returns exactly the requested range',
    new TextDecoder().decode(head) === 'application',
    new TextDecoder().decode(head),
  );

  // Input validation
  check('s3: rejects empty key', (await rejects(() => s3('', { backend }), /non-empty object key/)) === null);
  check(
    's3: rejects a missing backend',
    (await rejects(() => s3('k', {} as { backend: S3DirBackend }), /options\.backend must implement/)) === null,
  );
  check(
    's3Dir: rejects an unsafe relative path (".." segment survives prefix strip)',
    (await rejects(
      () =>
        s3Dir('p/', {
          backend: {
            size: async () => 0,
            read: async () => new Uint8Array(0),
            list: async () => [{ key: 'p/a/../secret', size: 1 }],
          },
        }),
      /unsafe relative path/,
    )) === null,
  );
  // short-read guard
  const shortBackend: S3DirBackend = {
    size: async () => 100,
    read: async () => new Uint8Array(3), // fewer bytes than asked
    list: async () => [],
  };
  const shorty = await s3('k', { backend: shortBackend });
  check('s3: short read is caught', (await rejects(() => shorty.read(0, 10), /short read/)) === null);
}

// ---------------------------------------------------------------------------
// Shared setup for the engine parity parts: the real aws-sdk client + the
// library's s3ClientBackend adapter, pointed at the in-process mock server.
// ---------------------------------------------------------------------------
const BUCKET = 'epubcheck-test';
const mock = await startMockS3();
const client = new S3Client({
  endpoint: mock.endpoint,
  region: 'us-east-1',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  forcePathStyle: true,
});
// Smoke-check the adapter wiring against the real client shape before we lean
// on it (constructs the aws-sdk command classes via the library's dynamic import).
void HeadObjectCommand;
void GetObjectCommand;
void ListObjectsV2Command;
const backend = await s3ClientBackend(client, BUCKET);

try {
  // ---- Part 2: packaged .epub -- s3() vs blob() parity + ranged reads ------
  console.log('\ns3() single packaged .epub -- parity with blob() + ranged reads:');
  {
    // (a) A real, clean book: prove s3() == blob() and validates clean (exit 0).
    const bookPath = join(here, 'corpus', 'standard-ebooks', 'arthur-conan-doyle_the-adventures-of-sherlock-holmes.epub');
    check('corpus book exists', existsSync(bookPath), bookPath);
    const bytes = new Uint8Array(readFileSync(bookPath));
    const key = 'books/mybook.epub';
    mock.put(key, bytes);
    mock.resetRanges();

    const src = await s3(key, { backend });
    check('s3: reported size matches the object', src.size === bytes.length, `${src.size} vs ${bytes.length}`);
    const rS3 = await validate(src, { name: 'mybook.epub' });
    // Baseline: the SAME bytes through blob() (no hostDir, like s3), same name.
    const rBlob = await validate(blob(toBlob(bytes)), { name: 'mybook.epub' });

    check('s3 vs blob: identical exitCode', rS3.exitCode === rBlob.exitCode, `${rS3.exitCode} vs ${rBlob.exitCode}`);
    check('s3 vs blob: identical valid flag', rS3.valid === rBlob.valid);
    check('s3 vs blob: identical stdout', rS3.stdout === rBlob.stdout, rS3.stdout.slice(0, 160));
    check('s3 vs blob: identical stderr', rS3.stderr === rBlob.stderr, rS3.stderr.slice(0, 160));
    check('s3 vs blob: identical message list', JSON.stringify(rS3.messages) === JSON.stringify(rBlob.messages));
    check('s3 vs blob: identical summary', JSON.stringify(rS3.summary) === JSON.stringify(rBlob.summary));
    check('s3: the book validated clean (exit 0)', rS3.exitCode === 0, `exit=${rS3.exitCode}`);
    // Every read was a bounded ranged GET, never a Range-less whole-object GET.
    assertBoundedRanges('s3', mock.ranges.filter((r) => r.key === key), new Map([[key, bytes.length]]));

    // (b) A >8 MiB book so the engine MUST pull multiple sub-object ranges: the
    // "never downloads the whole object, only the ranges it asks for" proof.
    // Built from the MINIMAL book (known EPUB/ layout) so the padding lands in
    // a predictable place.
    const minimalBook = join(here, 'corpus', 'epubcheck-prezipped', 'epub3_00-minimal_files_minimal.epub');
    const bigBytes = makeBigEpub(minimalBook);
    check('big epub exceeds the 8 MiB per-pull cap', bigBytes.length > 8 * 1024 * 1024, `size=${bigBytes.length}`);
    const bigKey = 'books/big.epub';
    mock.put(bigKey, bigBytes);
    mock.resetRanges();
    const rBigS3 = await validate(await s3(bigKey, { backend }), { name: 'big.epub' });
    const rBigBlob = await validate(blob(toBlob(bigBytes)), { name: 'big.epub' });
    check('s3 vs blob (big): identical exitCode', rBigS3.exitCode === rBigBlob.exitCode, `${rBigS3.exitCode} vs ${rBigBlob.exitCode}`);
    check('s3 vs blob (big): identical stdout', rBigS3.stdout === rBigBlob.stdout, rBigS3.stdout.slice(0, 160));
    check('s3 vs blob (big): identical message list', JSON.stringify(rBigS3.messages) === JSON.stringify(rBigBlob.messages));

    const recs = mock.ranges.filter((r) => r.key === bigKey);
    assertBoundedRanges('s3 (big)', recs, new Map([[bigKey, bigBytes.length]]));
    check('s3 (big): issued MULTIPLE bounded ranges (not one whole-object read)', recs.length >= 2, `range count=${recs.length}`);
    check(
      's3 (big): NO single range covered the whole object',
      recs.every((r) => r.bytes < bigBytes.length),
      `object size=${bigBytes.length}, max range=${Math.max(...recs.map((r) => r.bytes))}`,
    );
    check(
      's3 (big): reads used random access (some range does not start at offset 0)',
      recs.some((r) => !/^bytes=0-/.test(r.range ?? '')),
      JSON.stringify(recs.map((r) => r.range).slice(0, 10)),
    );
  }

  // ---- Part 3: expanded book -- s3Dir() vs fsDir() parity + ranged reads ---
  console.log('\ns3Dir() expanded book under a prefix -- parity with fsDir() + ranged reads:');
  {
    const bookPath = join(here, 'corpus', 'epubcheck-prezipped', 'epub3_00-minimal_files_minimal.epub');
    check('unzip binary is available', spawnSync('unzip', ['-v'], { encoding: 'utf8' }).status === 0);
    const tmp = mkdtempSync(join(tmpdir(), 'epubcheck-s3-exp-'));
    try {
      const dir = join(tmp, 'expanded');
      mkdirSync(dir);
      spawnSync('unzip', ['-q', bookPath, '-d', dir], { encoding: 'utf8' });

      // Upload every file in the expanded tree under a key prefix.
      const prefix = 'expanded/mybook/';
      const objectSizes = new Map<string, number>();
      const walk = (d: string): void => {
        for (const entry of readdirSync(d, { withFileTypes: true })) {
          const abs = join(d, entry.name);
          if (entry.isDirectory()) {
            walk(abs);
          } else {
            const rel = relative(dir, abs).split(sep).join('/');
            const key = prefix + rel;
            const bytes = readFileSync(abs);
            mock.put(key, bytes);
            objectSizes.set(key, bytes.length);
          }
        }
      };
      walk(dir);
      mock.resetRanges();

      const listing = (await s3Dir(prefix, { backend })).list().map((e) => e.path);
      check(
        's3Dir: listing (prefix stripped, sorted) matches the tree',
        JSON.stringify(listing) ===
          JSON.stringify([
            'EPUB/content_001.xhtml',
            'EPUB/nav.xhtml',
            'EPUB/package.opf',
            'META-INF/container.xml',
            'mimetype',
          ]),
        JSON.stringify(listing),
      );
      check(
        's3Dir: name defaults to the prefix last segment',
        (await s3Dir(prefix, { backend })).name === 'mybook',
        (await s3Dir(prefix, { backend })).name,
      );

      // fsDir baseline uses an INJECTED backend (so it carries NO hostDir,
      // exactly like the injected/remote s3Dir), same reported name -> the
      // ONLY remaining variable is the storage, so any output difference is a
      // real s3Dir bug.
      const injectedFs = await import('node:fs');

      // (a) DEFAULT-mode parity: whatever the directory default produces, s3Dir
      // must produce byte-identical output to fsDir over the same tree.
      {
        const rS3 = await validate(await s3Dir(prefix, { backend }), { name: 'mybook' });
        const rFs = await validate(await fsDir(dir, { fs: injectedFs }), { name: 'mybook' });
        check('s3Dir vs fsDir (default mode): identical exitCode', rS3.exitCode === rFs.exitCode, `${rS3.exitCode} vs ${rFs.exitCode}`);
        check('s3Dir vs fsDir (default mode): identical stdout', rS3.stdout === rFs.stdout, rS3.stdout.slice(0, 200));
        check('s3Dir vs fsDir (default mode): identical stderr', rS3.stderr === rFs.stderr, rS3.stderr.slice(0, 200));
        check(
          's3Dir vs fsDir (default mode): identical message list',
          JSON.stringify(rS3.messages) === JSON.stringify(rFs.messages),
        );
      }

      // (b) EXP-mode functional read proof: package + validate the tree so the
      // engine actually PULLS every file's bytes (dirMode 'exp'), proving the
      // ranged per-file GetObject feed end to end and clean parity + exit 0.
      mock.resetRanges();
      const rS3 = await validate(await s3Dir(prefix, { backend }), { name: 'mybook', dirMode: 'exp' });
      const rFs = await validate(await fsDir(dir, { fs: injectedFs }), { name: 'mybook', dirMode: 'exp' });
      check('s3Dir vs fsDir (exp): identical exitCode', rS3.exitCode === rFs.exitCode, `${rS3.exitCode} vs ${rFs.exitCode}`);
      check('s3Dir vs fsDir (exp): identical valid flag', rS3.valid === rFs.valid);
      check('s3Dir vs fsDir (exp): identical stdout', rS3.stdout === rFs.stdout, rS3.stdout.slice(0, 200));
      check('s3Dir vs fsDir (exp): identical stderr', rS3.stderr === rFs.stderr, rS3.stderr.slice(0, 200));
      check(
        's3Dir vs fsDir (exp): identical message list',
        JSON.stringify(rS3.messages) === JSON.stringify(rFs.messages),
      );
      check(
        's3Dir vs fsDir (exp): identical summary',
        JSON.stringify(rS3.summary) === JSON.stringify(rFs.summary),
      );
      check('s3Dir (exp): the expanded book validated clean (exit 0)', rS3.exitCode === 0, `exit=${rS3.exitCode}`);

      // Range proof across all the per-file objects (only the exp run's reads).
      assertBoundedRanges('s3Dir', mock.ranges, objectSizes);
      check(
        's3Dir: reads hit MULTIPLE distinct objects (per-file ranged GETs)',
        new Set(mock.ranges.map((r) => r.key)).size >= 2,
        JSON.stringify([...new Set(mock.ranges.map((r) => r.key))]),
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
} finally {
  await mock.close();
}

console.log('');
if (failures) {
  console.error(`S3 SUITE FAILED: ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log('S3 SUITE PASSED');
