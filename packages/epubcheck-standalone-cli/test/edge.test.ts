// Edge-input parity for the CLI: inputs that cannot be committed fixtures
// (permission bits, empty directories, directories named `*.epub`) are built
// fresh in a temp dir and run through BOTH the real epubcheck 5.3.0 jar and
// the compiled CLI (dist/cli.js) with identical args and cwd, asserting
// byte-identical stdout/stderr and matching exit codes -- the same live
// pattern as expanded.test.ts (and like it, these SKIP cleanly when the jar
// or java is absent).
//
// Covered (parity-audit Gaps C, D, E -- fixed 2026-09-06):
//   C  an unreadable (chmod 000) .epub file: FATAL(PKG-008) twice with Java's
//      `<abs path> (Permission denied)` message, exit 1 -- not a Node stack.
//   D  an empty directory under --mode exp (and an empty `.epub`-named
//      directory auto-detected as expanded): the jar packages/validates the
//      empty container -- not "Directory not found". (The empty-ZIP-file
//      sibling is a committed fixture: matrix.ts "empty-zip-default".)
//   E  a NON-empty directory literally named `*.epub`, auto-detected: the jar
//      validates the directory IN PLACE (locations under `junk.epub/...`),
//      never a doubled `junk.epub.epub` package name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  closeSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JAVA, resolveJarPath } from "../scripts/epubcheck-jar.ts";
import { normalizeReport } from "./normalize.ts";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "dist", "cli.js");
const fixturesDir = join(here, "fixtures");
const JAR = resolveJarPath();

assert.ok(existsSync(CLI), `compiled CLI missing at ${CLI} -- run \`npm run build\` first`);

function haveJava() {
  const r = spawnSync(JAVA, ["-version"], { encoding: "utf8" });
  return !r.error && r.status === 0;
}

const skip: false | string =
  existsSync(JAR) && haveJava()
    ? false
    : `epubcheck jar or java not available (JAR=${JAR})`;

function runBoth(args: string[], cwd: string) {
  const jar = spawnSync(JAVA, ["-jar", JAR, ...args], { cwd, encoding: "utf8", maxBuffer: 1 << 28 });
  const cli = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", maxBuffer: 1 << 28 });
  return { jar, cli };
}

function assertIdentical(args: string[], cwd: string) {
  const { jar, cli } = runBoth(args, cwd);
  assert.equal(cli.status, jar.status, "exit code");
  assert.equal(cli.stdout, jar.stdout, "stdout");
  assert.equal(cli.stderr, jar.stderr, "stderr");
}

function withTmp(fn: (tmp: string) => void) {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "ecw-edge-")));
  try {
    fn(tmp);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

test("edge: unreadable (permission-denied) .epub file", { skip }, () => {
  withTmp((tmp) => {
    const book = join(tmp, "unreadable.epub");
    copyFileSync(join(fixturesDir, "valid.epub"), book);
    chmodSync(book, 0o000);
    // If this process can still open the file (running as root), the scenario
    // does not exist on this host -- skip rather than mis-assert.
    let openable = true;
    try {
      closeSync(openSync(book, "r"));
    } catch {
      openable = false;
    }
    if (openable) return; // root: chmod 000 has no effect
    try {
      assertIdentical(["unreadable.epub"], tmp);
    } finally {
      chmodSync(book, 0o644); // let rmSync clean up
    }
  });
});

test("edge: empty directory under --mode exp", { skip }, () => {
  withTmp((tmp) => {
    mkdirSync(join(tmp, "emptydir"));
    assertIdentical(["--mode", "exp", "emptydir"], tmp);
  });
});

test("edge: empty .epub-named directory, auto-detected", { skip }, () => {
  withTmp((tmp) => {
    mkdirSync(join(tmp, "empty.epub"));
    assertIdentical(["empty.epub"], tmp);
  });
});

test("edge: .epub-named directory with content, auto-detected", { skip }, () => {
  withTmp((tmp) => {
    mkdirSync(join(tmp, "junk.epub"));
    writeFileSync(join(tmp, "junk.epub", "stray.txt"), "not an epub\n");
    assertIdentical(["junk.epub"], tmp);
  });
});

test("edge: .epub-named directory, auto-detected, --json to console", { skip }, () => {
  withTmp((tmp) => {
    mkdirSync(join(tmp, "junk.epub"));
    writeFileSync(join(tmp, "junk.epub", "stray.txt"), "not an epub\n");
    const { jar, cli } = runBoth(["--json", "-", "junk.epub"], tmp);
    assert.equal(cli.status, jar.status, "exit code");
    assert.equal(normalizeReport(cli.stdout), normalizeReport(jar.stdout), "json report");
    assert.equal(cli.stderr, jar.stderr, "stderr");
  });
});

// Non-`.epub`-named directory, no --mode, no --profile: this is NOT auto-detected
// as an expanded book (only a `.epub`-named path or a `--profile` run is). The jar's
// argument-processing prints "Mode required for non-epub files. Default version is
// 3.0." to STDOUT and exits 1 -- it never reads the tree. The library default
// dirMode is now 'direct' (bare directory name, no mode), so the CLI hits the exact
// same argument-processing branch; this pins that both stay byte-identical.
test("edge: non-`.epub`-named directory, no mode (mode_required)", { skip }, () => {
  withTmp((tmp) => {
    // A real expanded EPUB tree that simply is not named `*.epub`: the extension
    // check fires before any file read, so the content is irrelevant to the
    // outcome -- but populate it so the fixture is a genuine loose book folder.
    mkdirSync(join(tmp, "minimal", "EPUB"), { recursive: true });
    writeFileSync(join(tmp, "minimal", "mimetype"), "application/epub+zip");
    writeFileSync(join(tmp, "minimal", "EPUB", "stray.txt"), "not an epub\n");
    assertIdentical(["minimal"], tmp);
  });
});

test("edge: empty non-`.epub`-named directory, no mode (mode_required)", { skip }, () => {
  withTmp((tmp) => {
    // Same argument-processing branch, empty tree: the "Mode required" check is
    // purely on the path extension, so an empty non-epub directory is identical.
    mkdirSync(join(tmp, "minimal"));
    assertIdentical(["minimal"], tmp);
  });
});

// M4 (host-path parity, fixed 2026-09-06): the engine used to mount inputs at
// an internal `/work/<name>` and report THAT path in its no-container
// single-file error text. The wrapper now mounts the input + user.dir under
// the book's REAL host directory, so FATAL(PKG-008) prints the host path and
// the jar's trailing-slash directory location, byte-for-byte.
test("edge: single-file --mode on a DIRECTORY (PKG-008 host path)", { skip }, () => {
  withTmp((tmp) => {
    // A single-file checker (--mode xhtml) pointed at a directory: epubcheck
    // reads the directory as a file and fails with FATAL(PKG-008), the location
    // carrying the trailing-slash directory form and the message the ABSOLUTE
    // host path -- both of which used to diverge (`/work/<name>`, no slash).
    mkdirSync(join(tmp, "adir"));
    writeFileSync(join(tmp, "adir", "stray.txt"), "not xhtml\n");
    assertIdentical(["--mode", "xhtml", "adir"], tmp);
  });
});

test("edge: single-file --mode on an EMPTY directory (PKG-008 host path)", { skip }, () => {
  withTmp((tmp) => {
    mkdirSync(join(tmp, "emptydir"));
    assertIdentical(["--mode", "xhtml", "emptydir"], tmp);
  });
});

test("edge: single-file --mode on a MISSING file (file_not_found)", { skip }, () => {
  withTmp((tmp) => {
    // The missing-file path prints the bare arg (never an internal path); this
    // pins that it stays byte-identical after the mount relocation.
    assertIdentical(["--mode", "xhtml", "nope.xhtml"], tmp);
  });
});

test("edge: single-file --mode on a REAL xhtml file (host cwd)", { skip }, () => {
  withTmp((tmp) => {
    // A real single file validated in --mode xhtml: message locations are
    // working-directory-relative (`./bad.xhtml`), which is exactly what the
    // relocated user.dir must reproduce. Use a file with one error so a located
    // message is actually emitted.
    writeFileSync(
      join(tmp, "bad.xhtml"),
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>t</title></head>\n' +
        "<body><p><bogus></bogus></p></body></html>\n",
    );
    assertIdentical(["--mode", "xhtml", "bad.xhtml"], tmp);
  });
});
