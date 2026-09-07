// ZIP64 support in the -s/--save packager (src/archive.ts). A genuine >4 GB
// fixture is impractical, so createArchive takes an overridable ZIP64 threshold:
// lowering it to a handful of bytes makes a tiny tree cross the boundary and
// exercise the exact same code path a 4 GB+ EPUB would, byte-for-byte in the
// header/offset logic (only the trigger constant differs).
//
// The goal (per the owner's standard) is STRUCTURAL parity with commons-compress
// Zip64Mode.AsNeeded, not byte-identity: a VALID ZIP64 archive whose field
// placement mirrors the jar's, verified by
//   (a) round-tripping every file through an independent ZIP64-aware reader
//       (python3's zipfile, plus `unzip -t`), and
//   (b) asserting the ZIP64 structures are present and well-formed (local/central
//       0x0001 extra fields with the right payloads, the ZIP64 EOCD record +
//       locator, and the classic-EOCD sentinels).
// A companion test proves the DEFAULT threshold emits NO ZIP64 bytes, so
// sub-4 GB packaging stays byte-identical to the pre-ZIP64 writer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createArchive } from "../src/archive.ts";

/** Build a small EPUB-shaped tree under a fresh tmp dir; return { tmp, dir }. */
function makeTree(): { tmp: string; dir: string; files: Record<string, Buffer> } {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "ecw-zip64-")));
  const dir = join(tmp, "book");
  mkdirSync(join(dir, "OEBPS"), { recursive: true });
  const files: Record<string, Buffer> = {
    mimetype: Buffer.from("application/epub+zip"),
    "OEBPS/content.opf": Buffer.from("<package>the content document, well over ten bytes long</package>\n"),
    "OEBPS/chapter1.xhtml": Buffer.from("<html><body><p>" + "chapter one ".repeat(40) + "</p></body></html>"),
    "OEBPS/nav.xhtml": Buffer.from("<html><body><nav>toc goes here, comfortably past the threshold</nav></body></html>"),
  };
  for (const [name, buf] of Object.entries(files)) writeFileSync(join(dir, name), buf);
  return { tmp, dir, files };
}

interface Field {
  id: number;
  size: number;
  body: Buffer;
}
function parseExtra(buf: Buffer): Field[] {
  const out: Field[] = [];
  let o = 0;
  while (o + 4 <= buf.length) {
    const id = buf.readUInt16LE(o);
    const size = buf.readUInt16LE(o + 2);
    out.push({ id, size, body: buf.subarray(o + 4, o + 4 + size) });
    o += 4 + size;
  }
  return out;
}

interface ParsedEntry {
  name: string;
  centralVersionNeeded: number;
  localVersionNeeded: number;
  centralComp: number;
  centralUncomp: number;
  centralOffsetField: number;
  localComp: number;
  localUncomp: number;
  centralExtra: Buffer;
  localExtra: Buffer;
}

interface ParsedZip {
  entries: ParsedEntry[];
  classic: { count: number; cdSize: number; cdOffset: number };
  zip64Eocd: null | {
    versionMadeBy: number;
    versionNeeded: number;
    totalEntries: bigint;
    cdSize: bigint;
    cdOffset: bigint;
  };
  zip64Locator: null | { diskWithEocd: number; eocdOffset: bigint; totalDisks: number };
}

/**
 * A from-scratch ZIP64-aware structural reader: it locates the classic EOCD,
 * the ZIP64 EOCD locator + record that precede it, and walks the central
 * directory from the REAL (ZIP64) offset, capturing both the sentinel-bearing
 * classic fields and the values that live in the 0x0001 extras.
 */
function parseZip(file: string): ParsedZip {
  const b = readFileSync(file);
  let e = b.length - 22;
  while (e >= 0 && b.readUInt32LE(e) !== 0x06054b50) e--;
  assert.ok(e >= 0, "classic EOCD present");
  const classic = {
    count: b.readUInt16LE(e + 10),
    cdSize: b.readUInt32LE(e + 12),
    cdOffset: b.readUInt32LE(e + 16),
  };

  // ZIP64 EOCD locator sits immediately before the classic EOCD (20 bytes).
  let zip64Eocd: ParsedZip["zip64Eocd"] = null;
  let zip64Locator: ParsedZip["zip64Locator"] = null;
  let cdStart = classic.cdOffset;
  let count = classic.count;
  const locPos = e - 20;
  if (locPos >= 0 && b.readUInt32LE(locPos) === 0x07064b50) {
    zip64Locator = {
      diskWithEocd: b.readUInt32LE(locPos + 4),
      eocdOffset: b.readBigUInt64LE(locPos + 8),
      totalDisks: b.readUInt32LE(locPos + 16),
    };
    const r = Number(zip64Locator.eocdOffset);
    assert.equal(b.readUInt32LE(r), 0x06064b50, "ZIP64 EOCD record at locator offset");
    zip64Eocd = {
      versionMadeBy: b.readUInt16LE(r + 12),
      versionNeeded: b.readUInt16LE(r + 14),
      totalEntries: b.readBigUInt64LE(r + 32),
      cdSize: b.readBigUInt64LE(r + 40),
      cdOffset: b.readBigUInt64LE(r + 48),
    };
    cdStart = Number(zip64Eocd.cdOffset);
    count = Number(zip64Eocd.totalEntries);
  }

  const entries: ParsedEntry[] = [];
  let off = cdStart;
  for (let i = 0; i < count; i++) {
    assert.equal(b.readUInt32LE(off), 0x02014b50, `central header ${i} signature`);
    const nameLen = b.readUInt16LE(off + 28);
    const extraLen = b.readUInt16LE(off + 30);
    const commentLen = b.readUInt16LE(off + 32);
    const name = b.toString("utf8", off + 46, off + 46 + nameLen);
    const centralExtra = Buffer.from(b.subarray(off + 46 + nameLen, off + 46 + nameLen + extraLen));
    const lfh = b.readUInt32LE(off + 42); // may be the 0xffffffff sentinel

    // Resolve the true local-header offset from the central 0x0001 extra when the
    // 32-bit field is a sentinel, so we can also read the local header back.
    let trueLfh = lfh;
    const cz64 = parseExtra(centralExtra).find((f) => f.id === 0x0001);
    if (lfh === 0xffffffff && cz64) {
      // offset is the LAST value in the central extra; sizes (if present) precede it.
      const sizesPresent = b.readUInt32LE(off + 20) === 0xffffffff || b.readUInt32LE(off + 24) === 0xffffffff;
      trueLfh = Number(cz64.body.readBigUInt64LE(sizesPresent ? 16 : 0));
    }
    assert.equal(b.readUInt32LE(trueLfh), 0x04034b50, `local header ${i} signature`);
    const lNameLen = b.readUInt16LE(trueLfh + 26);
    const lExtraLen = b.readUInt16LE(trueLfh + 28);
    const localExtra = Buffer.from(
      b.subarray(trueLfh + 30 + lNameLen, trueLfh + 30 + lNameLen + lExtraLen),
    );

    entries.push({
      name,
      centralVersionNeeded: b.readUInt16LE(off + 6),
      localVersionNeeded: b.readUInt16LE(trueLfh + 4),
      centralComp: b.readUInt32LE(off + 20),
      centralUncomp: b.readUInt32LE(off + 24),
      centralOffsetField: lfh,
      localComp: b.readUInt32LE(trueLfh + 18),
      localUncomp: b.readUInt32LE(trueLfh + 22),
      centralExtra,
      localExtra,
    });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return { entries, classic, zip64Eocd, zip64Locator };
}

test("zip64: a lowered threshold packages a small tree into a valid ZIP64 archive", async () => {
  const { tmp, dir, files } = makeTree();
  try {
    // Threshold 10: every file (>= 10 bytes) crosses the size boundary, and every
    // entry after the first also crosses the offset boundary -- so this exercises
    // the local size extra, the central size+offset extra, and the ZIP64 EOCD.
    const epub = realpathSync(tmp) + "/book.epub";
    {
      const written = await createArchive(dir, { size: 10 });
      assert.equal(written, epub, "writes <dir>.epub beside the input");
      const z = parseZip(epub);

      // --- ZIP64 end-of-central-directory record + locator present & well-formed
      assert.ok(z.zip64Eocd, "ZIP64 EOCD record present");
      assert.ok(z.zip64Locator, "ZIP64 EOCD locator present");
      assert.equal(z.zip64Eocd!.versionMadeBy, 45, "ZIP64 EOCD version made by = 45");
      assert.equal(z.zip64Eocd!.versionNeeded, 45, "ZIP64 EOCD version needed = 45");
      assert.equal(Number(z.zip64Eocd!.totalEntries), 4, "ZIP64 EOCD total entries");
      assert.equal(z.zip64Locator!.totalDisks, 1, "locator total disks = 1");
      assert.equal(z.zip64Locator!.diskWithEocd, 0, "locator disk-with-EOCD = 0");

      // --- classic EOCD carries sentinels for the overflowing size/offset fields
      assert.equal(z.classic.cdSize, 0xffffffff, "classic EOCD CD size is the 0xffffffff sentinel");
      assert.equal(z.classic.cdOffset, 0xffffffff, "classic EOCD CD offset is the 0xffffffff sentinel");
      assert.equal(z.classic.count, 4, "classic EOCD count fits in 16 bits (not sentinelled)");
      // The ZIP64 EOCD holds the true values the sentinels stand in for.
      assert.equal(Number(z.zip64Eocd!.cdSize) > 0, true, "ZIP64 EOCD reports a real CD size");
      assert.equal(Number(z.zip64Eocd!.cdOffset) > 0, true, "ZIP64 EOCD reports a real CD offset");

      // --- per-entry ZIP64 extra fields (AsNeeded field-presence rules)
      const names = z.entries.map((en) => en.name);
      assert.equal(names[0], "mimetype", "mimetype is moved to the front");
      assert.deepEqual(
        [...names].sort(),
        Object.keys(files).sort(),
        "all files packaged (raw readdir order is filesystem-dependent)",
      );
      for (const en of z.entries) {
        const onDisk = files[en.name]!;
        // Every entry's size overflows threshold 10 -> local + central size extra.
        assert.equal(en.localComp, 0xffffffff, `${en.name}: local comp-size sentinel`);
        assert.equal(en.localUncomp, 0xffffffff, `${en.name}: local uncomp-size sentinel`);
        assert.equal(en.centralComp, 0xffffffff, `${en.name}: central comp-size sentinel`);
        assert.equal(en.centralUncomp, 0xffffffff, `${en.name}: central uncomp-size sentinel`);
        assert.equal(en.localVersionNeeded, 45, `${en.name}: local version needed = 45`);
        assert.equal(en.centralVersionNeeded, 45, `${en.name}: central version needed = 45`);

        // Local 0x0001 extra: FIRST field, both 8-byte sizes, real values.
        const lFields = parseExtra(en.localExtra);
        assert.equal(lFields[0]!.id, 0x0001, `${en.name}: local ZIP64 extra is first`);
        assert.equal(lFields[0]!.size, 16, `${en.name}: local ZIP64 extra is 16 bytes`);
        assert.equal(
          Number(lFields[0]!.body.readBigUInt64LE(0)),
          onDisk.length,
          `${en.name}: local ZIP64 uncompressed size`,
        );

        // Central 0x0001 extra: FIRST field; sizes (16) for every entry, plus an
        // 8-byte offset for every entry except the first (offset 0 < threshold).
        const cFields = parseExtra(en.centralExtra);
        assert.equal(cFields[0]!.id, 0x0001, `${en.name}: central ZIP64 extra is first`);
        const isFirst = en.name === "mimetype";
        assert.equal(cFields[0]!.size, isFirst ? 16 : 24, `${en.name}: central ZIP64 extra payload size`);
        assert.equal(
          Number(cFields[0]!.body.readBigUInt64LE(0)),
          onDisk.length,
          `${en.name}: central ZIP64 uncompressed size`,
        );
        if (isFirst) {
          assert.equal(en.centralOffsetField, 0, "mimetype offset (0) is not sentinelled");
        } else {
          assert.equal(en.centralOffsetField, 0xffffffff, `${en.name}: central offset sentinel`);
          // offset value is the 3rd 8-byte value in the extra (after the 2 sizes).
          assert.ok(
            Number(cFields[0]!.body.readBigUInt64LE(16)) > 0,
            `${en.name}: central ZIP64 offset value`,
          );
        }
        // mimetype stays STORED even under ZIP64.
        if (isFirst) {
          const lfhMethod = readFileSync(epub).readUInt16LE(0 + 8); // first LFH at offset 0
          assert.equal(lfhMethod, 0, "mimetype is still STORED (method 0)");
        }
      }

      // --- round-trip through independent ZIP64-aware readers -----------------
      const out = join(tmp, "extracted");
      const py = spawnSync(
        "python3",
        [
          "-c",
          [
            "import sys, zipfile",
            "z = zipfile.ZipFile(sys.argv[1])",
            "bad = z.testzip()",
            "assert bad is None, ('CRC failure: ' + str(bad))",
            "z.extractall(sys.argv[2])",
            "print('ok', len(z.infolist()))",
          ].join("\n"),
          epub,
          out,
        ],
        { encoding: "utf8" },
      );
      assert.equal(py.status, 0, `python3 zipfile extraction failed: ${py.stderr || py.stdout}`);
      for (const [name, buf] of Object.entries(files)) {
        const extracted = readFileSync(join(out, name));
        assert.ok(extracted.equals(buf), `${name} round-trips byte-for-byte via python3 zipfile`);
      }

      const t = spawnSync("unzip", ["-t", epub], { encoding: "utf8" });
      assert.equal(t.status, 0, `unzip -t failed: ${t.stderr || t.stdout}`);
      assert.ok(/No errors detected/.test(t.stdout), "unzip -t reports no errors");
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("zip64: the default threshold emits NO ZIP64 bytes (sub-4 GB output unchanged)", async () => {
  const { tmp, dir } = makeTree();
  try {
    const epub = await createArchive(dir); // real 0xffffffff / 0xffff limits
    const z = parseZip(epub);
    assert.equal(z.zip64Eocd, null, "no ZIP64 EOCD record below the threshold");
    assert.equal(z.zip64Locator, null, "no ZIP64 EOCD locator below the threshold");
    assert.notEqual(z.classic.cdSize, 0xffffffff, "classic CD size is a real value");
    assert.notEqual(z.classic.cdOffset, 0xffffffff, "classic CD offset is a real value");
    for (const en of z.entries) {
      assert.equal(
        parseExtra(en.localExtra).some((f) => f.id === 0x0001),
        false,
        `${en.name}: no 0x0001 extra in the local header`,
      );
      assert.equal(
        parseExtra(en.centralExtra).some((f) => f.id === 0x0001),
        false,
        `${en.name}: no 0x0001 extra in the central header`,
      );
      assert.notEqual(en.localVersionNeeded, 45, `${en.name}: local version is classic`);
      assert.notEqual(en.centralVersionNeeded, 45, `${en.name}: central version is classic`);
    }
    // The whole file must be free of any ZIP64 signature.
    const raw = readFileSync(epub);
    assert.equal(raw.includes(Buffer.from([0x50, 0x4b, 0x06, 0x06])), false, "no ZIP64 EOCD signature");
    assert.equal(raw.includes(Buffer.from([0x50, 0x4b, 0x06, 0x07])), false, "no ZIP64 locator signature");
    assert.ok(readdirSync(tmp).includes("book.epub"), "the archive was written");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
