// Port of com.adobe.epubcheck.util.Archive (epubcheck 5.3.0) for the CLI's
// `-s`/`--save` flag: package an expanded EPUB directory into
// `<canonical-parent>/<directory-name>.epub`, laid out the way the jar's
// commons-compress ZipArchiveOutputStream writes it.
//
// Faithful to the jar's observed output (verified against the real jar):
// - Files are collected in RAW readdir order (Java's File.listFiles order).
//   Node's fs.readdir would NOT match: libuv sorts scandir results, so this
//   walks with the promises fs.opendir (uv_fs_opendir/readdir, NOT scandir),
//   which preserves the on-disk order the jar sees -- the same raw order the old
//   opendirSync gave, since async opendir uses the identical libuv directory API.
// - `.DS_Store`, `._DS_Store`, `Thumbs.db`, `ehthumbs.db` files and `.svn`/
//   `.git` directories are skipped (Archive.collectFiles, epubcheck issue 256).
// - A root-level `mimetype` is moved to the front and STORED (method 0) with a
//   precomputed CRC and NO extra fields; every other entry is DEFLATED.
// - Entry names are UTF-8 with the language-encoding flag (0x0800) set, no
//   unicode-path extra fields (setCreateUnicodeExtraFields(NEVER)).
// - Deflated entries carry the same timestamp extra fields commons-compress
//   emits from the file's real attributes: extended-timestamp 0x5455 (local:
//   mtime/atime/birthtime seconds; central: mtime only) and NTFS 0x000a
//   (mtime/atime/birthtime as 100 ns FILETIME values).
// - Symlinks are followed (Java's File.isFile/isDirectory semantics); an entry
//   that is neither a regular file nor a directory is skipped.
//
// One deliberate divergence, impossible to close from Node: the DEFLATED
// streams differ byte-for-byte from the jar's because Node's bundled zlib and
// the JDK's zlib produce different (both valid) output for the same input.
// Entry order, names, methods, CRCs, sizes, and timestamps all match.
//
// ZIP64 (APPNOTE 6.3.x), emitted the way commons-compress's default
// Zip64Mode.AsNeeded does on seekable output: classic 32-bit headers are used
// until a field would actually overflow, and only then are ZIP64 structures
// added -- per entry and at the end -- so a packaged form that needs more than
// 4 GB of offset, a 4 GB+ entry, or 65535+ files produces a VALID archive
// instead of throwing. The trigger crosses over when a size/offset reaches
// 0xFFFFFFFF or the entry count reaches 0xFFFF (both overridable for tests via
// the `createArchive` options, which default to the real limits):
// - Per-entry ZIP64 extended-information extra field (id 0x0001), added only
//   for the entry that needs it, placed FIRST among its extra fields
//   (commons-compress's addAsFirstExtraField). The local header carries it when
//   the entry's own size overflows and always writes BOTH 8-byte sizes
//   (uncompressed then compressed); the central header carries only the values
//   that overflow, in APPNOTE order (uncompressed size, compressed size,
//   local-header offset), with the overflowing 32-bit fields set to the
//   0xFFFFFFFF sentinel and version-needed bumped to 45.
// - A ZIP64 end-of-central-directory record (0x06064b50, 56 bytes) + locator
//   (0x07064b50, 20 bytes) before the classic EOCD once any entry used ZIP64 or
//   the central-directory offset/size/entry-count would overflow; the classic
//   EOCD then carries 0xFFFF / 0xFFFFFFFF sentinels in the overflowing fields.
//
// Standard for the ZIP64 path: STRUCTURE / field placement mirrors
// commons-compress AsNeeded, NOT byte-identical output. Byte parity above 4 GB
// was never achievable anyway -- our DEFLATE stream already differs from the
// JDK's (see above) -- so the goal is a valid archive whose ZIP64 layout
// matches the jar's, verified by round-tripping through an independent
// ZIP64-aware reader. Below the threshold NO ZIP64 structures appear, so
// sub-4 GB packaging stays byte-identical to the pre-ZIP64 output.

import { opendir, readFile, realpath, stat, open } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import { basename, dirname, join } from "node:path";
import { crc32, deflateRaw } from "node:zlib";
import { promisify } from "node:util";

// zlib exposes only a callback deflateRaw; promisify it so packaging runs on the
// libuv thread pool without blocking the event loop (async law). Its output is
// byte-identical to the old deflateRawSync -- same zlib, same default options, a
// deterministic deflate stream -- which the save-parity structural test confirms.
const deflateRawAsync = promisify(deflateRaw);

interface Entry {
  /** Zip entry name ("/"-separated, relative to the base directory). */
  name: string;
  /** Absolute filesystem path. */
  path: string;
}

const IGNORED_FILES = new Set([".DS_Store", "._DS_Store", "Thumbs.db", "ehthumbs.db"]);
const IGNORED_DIRS = new Set([".svn", ".git"]);

// Sentinel values written into the classic 32-bit / 16-bit fields to say "the
// real value lives in a ZIP64 structure" (APPNOTE 4.3.9.2, 4.4.1.4). These are
// ALSO the true overflow limits commons-compress uses as its AsNeeded trigger.
const ZIP64_MAGIC = 0xffffffff;
const ZIP64_MAGIC_SHORT = 0xffff;
const ZIP64_VERSION = 45; // version-needed-to-extract for a ZIP64 entry/record

/**
 * Thresholds at which ZIP64 kicks in. They default to the real 32-bit/16-bit
 * limits (so production output is unchanged), but are overridable so the ZIP64
 * code path can be exercised on tiny inputs in tests. `size` governs the local
 * size fields, the central size/offset fields, and the central-directory
 * size/offset in the EOCD; `entries` governs the entry-count fields. A field
 * uses ZIP64 (and gets the sentinel) exactly when its value is `>= threshold`,
 * matching commons-compress's `>= ZIP64_MAGIC` / `>= ZIP64_MAGIC_SHORT`.
 */
export interface Zip64Thresholds {
  size?: number;
  entries?: number;
}

/**
 * ZIP64 local extended-information extra field (id 0x0001): commons-compress
 * always writes BOTH the 8-byte uncompressed and 8-byte compressed size in the
 * local extra when it adds one.
 */
function zip64LocalExtra(uncompressedSize: number, compressedSize: number): Buffer {
  const b = Buffer.alloc(4 + 16);
  b.writeUInt16LE(0x0001, 0);
  b.writeUInt16LE(16, 2);
  b.writeBigUInt64LE(BigInt(uncompressedSize), 4);
  b.writeBigUInt64LE(BigInt(compressedSize), 12);
  return b;
}

/**
 * ZIP64 central extended-information extra field (id 0x0001): carries ONLY the
 * values that overflow, in the fixed APPNOTE order (uncompressed size,
 * compressed size, local-header offset), matching commons-compress's
 * getCentralDirectoryData(). The two sizes are emitted together (both or
 * neither) when either overflows; the offset is emitted when it overflows. The
 * disk-start-number never overflows here (single disk), so it is never present.
 */
function zip64CentralExtra(
  needSizes: boolean,
  uncompressedSize: number,
  compressedSize: number,
  needOffset: boolean,
  offset: number,
): Buffer {
  const dataLen = (needSizes ? 16 : 0) + (needOffset ? 8 : 0);
  const b = Buffer.alloc(4 + dataLen);
  b.writeUInt16LE(0x0001, 0);
  b.writeUInt16LE(dataLen, 2);
  let o = 4;
  if (needSizes) {
    b.writeBigUInt64LE(BigInt(uncompressedSize), o);
    b.writeBigUInt64LE(BigInt(compressedSize), o + 8);
    o += 16;
  }
  if (needOffset) {
    b.writeBigUInt64LE(BigInt(offset), o);
  }
  return b;
}

/** Archive.collectFiles: depth-first, raw readdir order, junk entries skipped. */
async function collectFiles(dir: string, dirName: string, out: Entry[]): Promise<void> {
  // Drain the whole directory first (for-await auto-closes the Dir on
  // completion), so only one directory handle is open at a time down the
  // recursion. `for await` reads entries via the same libuv opendir/readdir the
  // sync path used, preserving the raw (unsorted) order the jar's File.listFiles
  // sees -- the byte-order the saved zip depends on.
  const names: string[] = [];
  const d = await opendir(dir);
  for await (const ent of d) names.push(ent.name);
  for (const name of names) {
    const full = join(dir, name);
    let st;
    try {
      st = await stat(full); // follows symlinks, like java.io.File
    } catch {
      continue; // dangling symlink: neither isFile nor isDirectory to Java
    }
    if (st.isFile()) {
      if (!IGNORED_FILES.has(name)) out.push({ name: dirName + name, path: full });
    } else if (st.isDirectory()) {
      if (!IGNORED_DIRS.has(name)) await collectFiles(full, dirName + name + "/", out);
    }
  }
}

/** MS-DOS date+time (local time, 2 s resolution) as (date << 16) | time. */
function dosDateTime(ms: number): number {
  const d = new Date(ms);
  if (d.getFullYear() < 1980) return 0x0021 << 16; // 1980-01-01 00:00:00
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  return ((date << 16) | time) >>> 0;
}

/** Windows FILETIME (100 ns intervals since 1601-01-01) from unix nanoseconds. */
function toFiletime(ns: bigint): bigint {
  return ns / 100n + 116444736000000000n;
}

/** Unix seconds as the unsigned 32-bit value the 0x5455 field stores. */
function toUnixSec(ns: bigint): number {
  return Number(BigInt.asUintN(32, ns / 1000000000n));
}

/** NTFS extra field 0x000a (36 bytes): mtime, atime, creation as FILETIME. */
function writeNtfsExtra(b: Buffer, off: number, st: BigIntStats): void {
  b.writeUInt16LE(0x000a, off);
  b.writeUInt16LE(32, off + 2);
  b.writeUInt32LE(0, off + 4); // reserved
  b.writeUInt16LE(0x0001, off + 8); // tag: times
  b.writeUInt16LE(24, off + 10);
  b.writeBigUInt64LE(toFiletime(st.mtimeNs), off + 12);
  b.writeBigUInt64LE(toFiletime(st.atimeNs), off + 20);
  b.writeBigUInt64LE(toFiletime(st.birthtimeNs), off + 28);
}

/** Local-header extra: 0x5455 (flags 7: mtime/atime/creation) + NTFS. */
function localExtra(st: BigIntStats): Buffer {
  const b = Buffer.alloc(17 + 36);
  b.writeUInt16LE(0x5455, 0);
  b.writeUInt16LE(13, 2);
  b.writeUInt8(0x07, 4);
  b.writeUInt32LE(toUnixSec(st.mtimeNs), 5);
  b.writeUInt32LE(toUnixSec(st.atimeNs), 9);
  b.writeUInt32LE(toUnixSec(st.birthtimeNs), 13);
  writeNtfsExtra(b, 17, st);
  return b;
}

/** Central-directory extra: 0x5455 (flags 7, mtime only) + NTFS. */
function centralExtra(st: BigIntStats): Buffer {
  const b = Buffer.alloc(9 + 36);
  b.writeUInt16LE(0x5455, 0);
  b.writeUInt16LE(5, 2);
  b.writeUInt8(0x07, 4);
  b.writeUInt32LE(toUnixSec(st.mtimeNs), 5);
  writeNtfsExtra(b, 9, st);
  return b;
}

/**
 * Package `baseDir` (an existing directory) into `<parent>/<name>.epub` beside
 * it, overwriting any existing file there, and return the written path. The
 * base directory is canonicalized first (Archive's makeCanonical), so a
 * symlinked input saves next to the real directory. Throws on any failure; the
 * caller maps that onto the jar's packaging-failure behavior.
 *
 * `thresholds` lets tests lower the ZIP64 trigger so the ZIP64 path runs on
 * tiny inputs; it defaults to the real 32-bit/16-bit limits, keeping production
 * output byte-identical to the pre-ZIP64 writer below 4 GB.
 */
export async function createArchive(
  baseDir: string,
  thresholds: Zip64Thresholds = {},
): Promise<string> {
  const sizeThreshold = thresholds.size ?? ZIP64_MAGIC;
  const entryThreshold = thresholds.entries ?? ZIP64_MAGIC_SHORT;
  const canonical = await realpath(baseDir);
  const epubFile = join(dirname(canonical), basename(canonical) + ".epub");

  const entries: Entry[] = [];
  await collectFiles(canonical, "", entries);

  // Make a root-level mimetype the first entry; only then is one STORED.
  const mimetypeIndex = entries.findIndex((e) => e.name === "mimetype");
  if (mimetypeIndex > -1) {
    const [m] = entries.splice(mimetypeIndex, 1);
    entries.unshift(m as Entry);
  }

  const fd = await open(epubFile, "w");
  try {
    let offset = 0;
    const central: Buffer[] = [];
    // Set once any entry emits a ZIP64 extra: it forces the ZIP64 EOCD, exactly
    // like commons-compress's hasUsedZip64 flag (independent of whether the
    // central-directory offset/size/count themselves overflow).
    let usedZip64 = false;

    for (let i = 0; i < entries.length; i++) {
      const e = entries[i] as Entry;
      const st = await stat(e.path, { bigint: true }); // attrs BEFORE the read, like the jar
      const data = await readFile(e.path);
      const stored = i === 0 && mimetypeIndex > -1;
      const comp = stored ? data : await deflateRawAsync(data);
      // crc32 is a synchronous pure-CPU checksum with no async equivalent
      // (async law's pure-CPU exemption); it runs on the already-in-memory buffer.
      const crc = crc32(data);
      const name = Buffer.from(e.name, "utf8");
      const dos = dosDateTime(Number(st.mtimeNs / 1000000n));
      const method = stored ? 0 : 8;

      // AsNeeded ZIP64 decision, per field. The local header carries a ZIP64
      // extra (both sizes) when the entry's own size overflows; the central
      // header additionally carries the local-header offset when THAT overflows.
      // The local header has no offset field, so an offset-only overflow leaves
      // the local header classic (version 20, real 32-bit sizes) -- exactly what
      // commons-compress does, since it only learns the offset overflow while
      // building the central header.
      const needSizes = data.length >= sizeThreshold || comp.length >= sizeThreshold;
      const needOffset = offset >= sizeThreshold;
      if (needSizes || needOffset) usedZip64 = true;

      const baseExtraL = stored ? Buffer.alloc(0) : localExtra(st);
      const baseExtraC = stored ? Buffer.alloc(0) : centralExtra(st);
      const extraL = needSizes
        ? Buffer.concat([zip64LocalExtra(data.length, comp.length), baseExtraL])
        : baseExtraL;
      const extraC =
        needSizes || needOffset
          ? Buffer.concat([
              zip64CentralExtra(needSizes, data.length, comp.length, needOffset, offset),
              baseExtraC,
            ])
          : baseExtraC;

      const classicVersion = stored ? 10 : 20;
      const localVersion = needSizes ? ZIP64_VERSION : classicVersion;
      const centralVersion = needSizes || needOffset ? ZIP64_VERSION : classicVersion;
      const lfhComp = needSizes ? ZIP64_MAGIC : comp.length;
      const lfhUncomp = needSizes ? ZIP64_MAGIC : data.length;

      const lfh = Buffer.alloc(30);
      lfh.writeUInt32LE(0x04034b50, 0);
      lfh.writeUInt16LE(localVersion, 4);
      lfh.writeUInt16LE(0x0800, 6); // UTF-8 names
      lfh.writeUInt16LE(method, 8);
      lfh.writeUInt32LE(dos, 10);
      lfh.writeUInt32LE(crc, 14);
      lfh.writeUInt32LE(lfhComp, 18);
      lfh.writeUInt32LE(lfhUncomp, 22);
      lfh.writeUInt16LE(name.length, 26);
      lfh.writeUInt16LE(extraL.length, 28);

      const cen = Buffer.alloc(46);
      cen.writeUInt32LE(0x02014b50, 0);
      cen.writeUInt16LE(20, 4); // version made by: 2.0, FAT
      cen.writeUInt16LE(centralVersion, 6);
      cen.writeUInt16LE(0x0800, 8);
      cen.writeUInt16LE(method, 10);
      cen.writeUInt32LE(dos, 12);
      cen.writeUInt32LE(crc, 16);
      cen.writeUInt32LE(needSizes ? ZIP64_MAGIC : comp.length, 20);
      cen.writeUInt32LE(needSizes ? ZIP64_MAGIC : data.length, 24);
      cen.writeUInt16LE(name.length, 28);
      cen.writeUInt16LE(extraC.length, 30);
      // comment length, disk start, internal and external attributes: all 0
      cen.writeUInt32LE(needOffset ? ZIP64_MAGIC : offset, 42);
      central.push(cen, name, extraC);

      await fd.write(lfh);
      await fd.write(name);
      await fd.write(extraL);
      await fd.write(comp);
      offset += lfh.length + name.length + extraL.length + comp.length;
    }

    const cdOffset = offset;
    let cdSize = 0;
    for (const b of central) {
      await fd.write(b);
      cdSize += b.length;
    }

    // ZIP64 EOCD record + locator (commons-compress writeZip64CentralDirectory):
    // written when any entry used ZIP64 or the central-directory offset/size or
    // entry count would overflow the classic 32-bit/16-bit EOCD fields.
    const eocdOffsetOverflow = cdOffset >= sizeThreshold;
    const eocdSizeOverflow = cdSize >= sizeThreshold;
    const eocdCountOverflow = entries.length >= entryThreshold;
    if (usedZip64 || eocdOffsetOverflow || eocdSizeOverflow || eocdCountOverflow) {
      const z64eocd = Buffer.alloc(56);
      z64eocd.writeUInt32LE(0x06064b50, 0);
      z64eocd.writeBigUInt64LE(44n, 4); // size of the remainder of this record (56 - 12)
      z64eocd.writeUInt16LE(ZIP64_VERSION, 12); // version made by
      z64eocd.writeUInt16LE(ZIP64_VERSION, 14); // version needed to extract
      z64eocd.writeUInt32LE(0, 16); // number of this disk
      z64eocd.writeUInt32LE(0, 20); // disk with the start of the central directory
      z64eocd.writeBigUInt64LE(BigInt(entries.length), 24); // entries on this disk
      z64eocd.writeBigUInt64LE(BigInt(entries.length), 32); // total entries
      z64eocd.writeBigUInt64LE(BigInt(cdSize), 40); // size of the central directory
      z64eocd.writeBigUInt64LE(BigInt(cdOffset), 48); // offset of the central directory
      await fd.write(z64eocd);

      const z64loc = Buffer.alloc(20);
      z64loc.writeUInt32LE(0x07064b50, 0);
      z64loc.writeUInt32LE(0, 4); // disk with the ZIP64 EOCD record
      z64loc.writeBigUInt64LE(BigInt(cdOffset + cdSize), 8); // offset of the ZIP64 EOCD record
      z64loc.writeUInt32LE(1, 16); // total number of disks
      await fd.write(z64loc);
    }

    const eocdCount = eocdCountOverflow ? ZIP64_MAGIC_SHORT : entries.length;
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(eocdCount, 8);
    eocd.writeUInt16LE(eocdCount, 10);
    eocd.writeUInt32LE(eocdSizeOverflow ? ZIP64_MAGIC : cdSize, 12);
    eocd.writeUInt32LE(eocdOffsetOverflow ? ZIP64_MAGIC : cdOffset, 16);
    await fd.write(eocd);
  } finally {
    await fd.close();
  }
  return epubFile;
}
