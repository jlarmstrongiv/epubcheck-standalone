// -s/--save behavior, matching the real epubcheck 5.3.0 jar (ground truth
// observed live on 2026-09-05, and mirrored in EpubChecker.processFile +
// util/Archive.java):
//
// - With an EXPLICIT `--mode exp` on a directory, the jar packages it into
//   `<parent>/<dir-name>.epub` BEFORE validating (overwriting anything already
//   at that path) and prints nothing extra about it.
// - After the check, the file is KEPT only when the reporting-level-filtered
//   counts show no errors and no fatals: warnings keep it (even with
//   --failonwarnings, which still exits 1), and `-f` on an error-only book
//   keeps it too (the errors fall below the reporting level). A failing check
//   prints the localized "\nEpub creation cancelled due to detected errors.\n"
//   on stderr (after "Check finished with errors") and deletes the file -- so a
//   pre-existing same-named file is overwritten and then deleted.
// - Auto-detected expanded checking (a `.epub`-NAMED directory with no
//   `--mode exp`) never saves: the jar builds its Archive only on the explicit
//   exp path. --save on a packaged .epub file or any single-file mode is a
//   silent no-op.
// - Zip layout (Archive.createArchive): entries in raw readdir order, a
//   root-level `mimetype` moved first and STORED with no extra fields,
//   everything else DEFLATED with UTF-8 names; `.DS_Store`/`._DS_Store`/
//   `Thumbs.db`/`ehthumbs.db` files and `.svn`/`.git` directories skipped.
//   The CLI's saved zip is structurally identical to the jar's (order, names,
//   methods, CRCs, sizes, timestamps); only the DEFLATED stream bytes differ,
//   because Node's zlib and the JDK's zlib emit different (equally valid)
//   compressed output. Byte-identity is therefore NOT asserted anywhere.
//
// The parity cases at the bottom compare live against the jar and SKIP (never
// fail) when the jar or java is absent, exactly like expanded.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync, crc32 } from "node:zlib";
import { JAVA, resolveJarPath } from "../scripts/epubcheck-jar.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "fixtures");
const CLI = join(here, "..", "dist", "cli.js");
const JAR = resolveJarPath();

assert.ok(existsSync(CLI), `compiled CLI missing at ${CLI} -- run \`npm run build\` first`);

const CANCEL_NOTE = "\nEpub creation cancelled due to detected errors.\n\n";

function runCli(args: string[], cwd: string) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 1 << 28,
  });
  return { stdout: r.stdout, stderr: r.stderr, code: r.status };
}

/** Unzip a fixture .epub into <tmp>/<name> and return the tmp root. */
function makeDir(fixture: string, name: string): string {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "ecw-save-")));
  const dir = join(tmp, name);
  mkdirSync(dir);
  const unzip = spawnSync("unzip", ["-q", join(fixturesDir, fixture), "-d", dir], {
    encoding: "utf8",
  });
  assert.equal(unzip.status, 0, `unzip failed: ${unzip.stderr || unzip.status}`);
  return tmp;
}

interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  versionNeeded: number;
  crc: number;
  uncompSize: number;
  dosTime: number;
  centralExtraLen: number;
  /** Raw extra-field bytes from the local file header and central directory. */
  localExtra: Buffer;
  centralExtra: Buffer;
  content: Buffer;
}

/** Minimal central-directory reader for asserting the saved zip's structure. */
function readZip(file: string): ZipEntry[] {
  const b = readFileSync(file);
  let e = b.length - 22;
  while (e >= 0 && b.readUInt32LE(e) !== 0x06054b50) e--;
  assert.ok(e >= 0, "no end-of-central-directory record");
  const count = b.readUInt16LE(e + 10);
  let off = b.readUInt32LE(e + 16);
  const out: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    assert.equal(b.readUInt32LE(off), 0x02014b50, "central header signature");
    const nameLen = b.readUInt16LE(off + 28);
    const extraLen = b.readUInt16LE(off + 30);
    const commentLen = b.readUInt16LE(off + 32);
    const compSize = b.readUInt32LE(off + 20);
    const method = b.readUInt16LE(off + 10);
    const lfh = b.readUInt32LE(off + 42);
    const lfhNameLen = b.readUInt16LE(lfh + 26);
    const lfhExtraLen = b.readUInt16LE(lfh + 28);
    const dataStart = lfh + 30 + lfhNameLen + lfhExtraLen;
    const raw = b.subarray(dataStart, dataStart + compSize);
    out.push({
      name: b.toString("utf8", off + 46, off + 46 + nameLen),
      method,
      flags: b.readUInt16LE(off + 8),
      versionNeeded: b.readUInt16LE(off + 6),
      crc: b.readUInt32LE(off + 16),
      uncompSize: b.readUInt32LE(off + 24),
      dosTime: b.readUInt32LE(off + 12),
      centralExtraLen: extraLen,
      localExtra: Buffer.from(b.subarray(lfh + 30 + lfhNameLen, lfh + 30 + lfhNameLen + lfhExtraLen)),
      centralExtra: Buffer.from(b.subarray(off + 46 + nameLen, off + 46 + nameLen + extraLen)),
      content: method === 0 ? Buffer.from(raw) : inflateRawSync(raw),
    });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

interface ExtraField {
  id: number;
  size: number;
  body: Buffer;
}

/** Parse a zip extra-field block into its (id, size, body) records, in order. */
function parseExtra(buf: Buffer): ExtraField[] {
  const fields: ExtraField[] = [];
  let o = 0;
  while (o + 4 <= buf.length) {
    const id = buf.readUInt16LE(o);
    const size = buf.readUInt16LE(o + 2);
    fields.push({ id, size, body: buf.subarray(o + 4, o + 4 + size) });
    o += 4 + size;
  }
  return fields;
}

/**
 * Assert that a CLI-written extra-field block is STRUCTURALLY identical to the
 * jar's on the same file, and that the DETERMINISTIC timestamp (mtime) matches
 * exactly, while tolerating the host-dependent atime/birthtime VALUES.
 *
 * Field IDs, order, sizes, the 0x5455 flags byte, and the 0x000a NTFS record
 * layout are all deterministic and must match the jar byte-for-byte. The mtime
 * -- carried in 0x5455 (first 4 bytes after the flags) and as the first FILETIME
 * in 0x000a -- is tied to the file's modification time (unchanged by the jar's
 * and the CLI's reads), so it must match too. atime and birthtime are NOT
 * compared by value: a read between the two runs can advance atime, and Java's
 * vs Node's creation-time reporting can differ on filesystems without a native
 * birth time -- their PRESENCE and position are asserted via the field sizes,
 * which is the deterministic part.
 *
 * `local` selects the local-header shape (0x5455 size 13: mtime+atime+birthtime)
 * vs the central shape (0x5455 size 5: mtime only), exactly as commons-compress
 * writes them.
 */
function assertExtraParity(label: string, jarExtra: Buffer, cliExtra: Buffer, local: boolean): void {
  const j = parseExtra(jarExtra);
  const c = parseExtra(cliExtra);
  assert.deepEqual(
    c.map((f) => [f.id, f.size]),
    j.map((f) => [f.id, f.size]),
    `${label}: extra-field ids/sizes/order`,
  );
  for (let k = 0; k < j.length; k++) {
    const jf = j[k] as ExtraField;
    const cf = c[k] as ExtraField;
    if (jf.id === 0x5455) {
      // Extended timestamp: flags byte then mtime[, atime, birthtime].
      assert.equal(cf.body[0], jf.body[0], `${label}: 0x5455 flags byte`);
      assert.equal(cf.body[0], 0x07, `${label}: 0x5455 flags = mtime|atime|creation`);
      assert.equal(cf.body.readUInt32LE(1), jf.body.readUInt32LE(1), `${label}: 0x5455 mtime value`);
      assert.equal(jf.size, local ? 13 : 5, `${label}: 0x5455 size (${local ? "local" : "central"})`);
    } else if (jf.id === 0x000a) {
      // NTFS: 4 reserved + tag 0x0001 + tagsize 24 + mtime/atime/birthtime FILETIME.
      assert.equal(jf.size, 32, `${label}: 0x000a size`);
      assert.equal(cf.body.readUInt32LE(0), jf.body.readUInt32LE(0), `${label}: 0x000a reserved`);
      assert.equal(cf.body.readUInt16LE(4), 0x0001, `${label}: 0x000a tag`);
      assert.equal(cf.body.readUInt16LE(6), 24, `${label}: 0x000a tag size`);
      assert.equal(
        cf.body.readBigUInt64LE(8),
        jf.body.readBigUInt64LE(8),
        `${label}: 0x000a mtime FILETIME`,
      );
    } else {
      assert.fail(`${label}: unexpected extra field 0x${jf.id.toString(16)}`);
    }
  }
}

test("save: valid directory writes <dir>.epub beside the input, console output unchanged", () => {
  const tmp = makeDir("valid.epub", "book");
  try {
    const plain = runCli(["--mode", "exp", "book"], tmp);
    const saved = runCli(["--mode", "exp", "--save", "book"], tmp);
    assert.equal(saved.code, 0, "exit code");
    assert.equal(saved.stdout, plain.stdout, "--save adds nothing to stdout");
    assert.equal(saved.stderr, plain.stderr, "--save adds nothing to stderr");

    const epub = join(tmp, "book.epub");
    assert.ok(existsSync(epub), "book.epub written beside the input directory");

    const entries = readZip(epub);
    const first = entries[0] as ZipEntry;
    assert.equal(first.name, "mimetype", "mimetype is the first entry");
    assert.equal(first.method, 0, "mimetype is STORED");
    assert.equal(first.versionNeeded, 10, "mimetype needs version 1.0");
    assert.equal(first.centralExtraLen, 0, "mimetype has no extra fields");
    assert.equal(first.content.toString(), "application/epub+zip");
    for (const entry of entries.slice(1)) {
      assert.equal(entry.method, 8, `${entry.name} is DEFLATED`);
      assert.equal(entry.versionNeeded, 20, `${entry.name} needs version 2.0`);
    }
    for (const entry of entries) {
      assert.equal(entry.flags, 0x0800, `${entry.name} carries only the UTF-8 flag`);
      const onDisk = readFileSync(join(tmp, "book", entry.name));
      assert.ok(onDisk.equals(entry.content), `${entry.name} content round-trips`);
      assert.equal(entry.crc, crc32(onDisk), `${entry.name} CRC`);
      assert.equal(entry.uncompSize, onDisk.length, `${entry.name} size`);
    }
    assert.equal(entries.length, 5, "all files packaged, nothing extra");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("save: errors delete the file (overwriting a stale one first) with the jar's stderr note", () => {
  const tmp = makeDir("invalid.epub", "book");
  try {
    // A pre-existing same-named file is overwritten by the packaging step and
    // then deleted by the failing check -- the jar destroys it too.
    const stale = join(tmp, "book.epub");
    writeFileSync(stale, "stale bytes, not a zip");
    const r = runCli(["--mode", "exp", "--save", "book"], tmp);
    assert.equal(r.code, 1, "exit code");
    assert.ok(
      r.stderr.endsWith("\nCheck finished with errors\n" + CANCEL_NOTE),
      `cancel note follows the errors line, got tail: ${JSON.stringify(r.stderr.slice(-120))}`,
    );
    assert.ok(!existsSync(stale), "the packaged (and stale) file is deleted");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("save: warnings keep the file, even when --failonwarnings exits 1", () => {
  const tmp = makeDir("warning.epub", "book");
  try {
    const r = runCli(["--mode", "exp", "--save", "--failonwarnings", "book"], tmp);
    assert.equal(r.code, 1, "--failonwarnings still exits 1");
    assert.ok(!r.stderr.includes("Epub creation cancelled"), "no cancel note");
    assert.ok(existsSync(join(tmp, "book.epub")), "warnings do not delete the file");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("save: deletion follows the reporting-level-filtered counts (-f keeps an error-only book)", () => {
  const tmp = makeDir("invalid.epub", "book");
  try {
    const r = runCli(["--mode", "exp", "--save", "-f", "book"], tmp);
    assert.equal(r.code, 0, "errors below the reporting level exit 0 (jar behavior)");
    assert.ok(!r.stderr.includes("Epub creation cancelled"), "no cancel note");
    assert.ok(existsSync(join(tmp, "book.epub")), "file kept at fatal-only level");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("save: without --save no file is written", () => {
  const tmp = makeDir("valid.epub", "book");
  try {
    const r = runCli(["--mode", "exp", "book"], tmp);
    assert.equal(r.code, 0);
    assert.ok(!existsSync(join(tmp, "book.epub")), "no packaged file without --save");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("save: auto-detected .epub-named directory never saves (jar builds no Archive there)", () => {
  const tmp = makeDir("valid.epub", "book.epub");
  try {
    const r = runCli(["--save", "book.epub"], tmp);
    assert.equal(r.code, 0, "the directory still validates");
    assert.ok(!existsSync(join(tmp, "book.epub.epub")), "no book.epub.epub written");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("save: junk files and folders are excluded from the package", () => {
  const tmp = makeDir("valid.epub", "book");
  try {
    writeFileSync(join(tmp, "book", ".DS_Store"), "junk");
    writeFileSync(join(tmp, "book", "OPS", "Thumbs.db"), "junk");
    mkdirSync(join(tmp, "book", ".git"));
    writeFileSync(join(tmp, "book", ".git", "config"), "junk");
    const r = runCli(["--mode", "exp", "--save", "book"], tmp);
    assert.equal(r.code, 0);
    const names = readZip(join(tmp, "book.epub")).map((e) => e.name);
    assert.ok(!names.some((n) => n.includes("DS_Store") || n.includes("Thumbs") || n.startsWith(".git")),
      `junk excluded, got: ${names.join(", ")}`);
    assert.equal(names.length, 5, "only the real book files are packaged");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("save: localized cancel note (--locale fr)", () => {
  const tmp = makeDir("invalid.epub", "book");
  try {
    const r = runCli(["--mode", "exp", "--save", "--locale", "fr", "book"], tmp);
    assert.equal(r.code, 1);
    assert.ok(
      r.stderr.includes("\nLa création de l’epub a été annulée suite aux erreurs détectées.\n\n"),
      "the jar's French deleting_archive text",
    );
    assert.ok(!existsSync(join(tmp, "book.epub")), "file deleted");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// --- live-jar parity (skips cleanly without jar/java, like expanded.test.ts) ---

function haveJava() {
  const r = spawnSync(JAVA, ["-version"], { encoding: "utf8" });
  return !r.error && r.status === 0;
}

const skip: false | string =
  existsSync(JAR) && haveJava()
    ? false
    : `epubcheck jar or java not available (JAR=${JAR})`;

test("save-parity: identical console bytes and structurally identical zips (valid book)", { skip }, () => {
  const tmp = makeDir("valid.epub", "book");
  try {
    const epub = join(tmp, "book.epub");
    const jarRun = spawnSync(JAVA, ["-jar", JAR, "--mode", "exp", "--save", "book"], {
      cwd: tmp,
      encoding: "utf8",
      maxBuffer: 1 << 28,
    });
    assert.ok(existsSync(epub), "jar wrote book.epub");
    const jarZip = readZip(epub);
    rmSync(epub);

    const cliRun = runCli(["--mode", "exp", "--save", "book"], tmp);
    assert.ok(existsSync(epub), "CLI wrote book.epub");
    const cliZip = readZip(epub);

    assert.equal(cliRun.code, jarRun.status, "exit code");
    assert.equal(cliRun.stdout, jarRun.stdout ?? "", "stdout");
    assert.equal(cliRun.stderr, jarRun.stderr ?? "", "stderr");

    assert.equal(cliZip.length, jarZip.length, "entry count");
    for (let i = 0; i < jarZip.length; i++) {
      const a = jarZip[i] as ZipEntry;
      const c = cliZip[i] as ZipEntry;
      assert.equal(c.name, a.name, `entry ${i} name/order`);
      assert.equal(c.method, a.method, `${a.name} method`);
      assert.equal(c.flags, a.flags, `${a.name} flags`);
      assert.equal(c.versionNeeded, a.versionNeeded, `${a.name} version needed`);
      assert.equal(c.crc, a.crc, `${a.name} CRC`);
      assert.equal(c.uncompSize, a.uncompSize, `${a.name} size`);
      assert.equal(c.dosTime, a.dosTime, `${a.name} DOS timestamp`);
      assert.ok(c.content.equals(a.content), `${a.name} decompressed content`);
      // Extra-field parity (M6): the STORED mimetype carries none; every DEFLATED
      // entry carries the extended-timestamp (0x5455) + NTFS (0x000a) fields
      // commons-compress emits. Their structure, sizes, flags, and the mtime value
      // must match the jar exactly; atime/birthtime values are host-dependent and
      // asserted only by shape (see assertExtraParity).
      if (a.method === 0) {
        assert.equal(a.localExtra.length, 0, `${a.name} STORED: jar has no local extra`);
        assert.equal(c.localExtra.length, 0, `${a.name} STORED: CLI has no local extra`);
        assert.equal(a.centralExtra.length, 0, `${a.name} STORED: jar has no central extra`);
        assert.equal(c.centralExtra.length, 0, `${a.name} STORED: CLI has no central extra`);
      } else {
        assertExtraParity(`${a.name} local`, a.localExtra, c.localExtra, true);
        assertExtraParity(`${a.name} central`, a.centralExtra, c.centralExtra, false);
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("save-parity: failing book, identical console bytes, both delete the file", { skip }, () => {
  const tmp = makeDir("invalid.epub", "book");
  try {
    const epub = join(tmp, "book.epub");
    const jarRun = spawnSync(JAVA, ["-jar", JAR, "--mode", "exp", "--save", "book"], {
      cwd: tmp,
      encoding: "utf8",
      maxBuffer: 1 << 28,
    });
    const jarLeft = existsSync(epub);
    rmSync(epub, { force: true });

    const cliRun = runCli(["--mode", "exp", "--save", "book"], tmp);
    const cliLeft = existsSync(epub);

    assert.equal(cliRun.code, jarRun.status, "exit code");
    assert.equal(cliRun.stdout, jarRun.stdout ?? "", "stdout");
    assert.equal(cliRun.stderr, jarRun.stderr ?? "", "stderr");
    assert.equal(jarLeft, false, "jar deletes the file on errors");
    assert.equal(cliLeft, false, "CLI deletes the file on errors");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
