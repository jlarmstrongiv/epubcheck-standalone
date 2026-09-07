// --listChecks write-failure parity: when the dictionary cannot be written to
// the requested file (its parent directory does not exist), the jar does NOT
// treat it as a hard error. EpubChecker.dumpMessageDictionary SWALLOWS the
// exception -- it prints the ABSOLUTE path (listChecksOut.getAbsoluteFile()) via
// the "error_creating_config_file" message plus the IOException message
// ("<original path> (<os strerror>)") to stderr, but run() still returns 0 on the
// listChecks branch and its finally still prints the completion summary. So the
// run exits 0 with the summary on stdout and the two error lines on stderr.
//
// This can't be a frozen golden (the absolute path and the OS strerror are
// environment-specific), so it compares the compiled CLI (dist/cli.js) live
// against the real jar in the SAME cwd, and SKIPs cleanly when the jar or a java
// binary is absent. The jar is located by scripts/epubcheck-jar.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JAVA, resolveJarPath } from "../scripts/epubcheck-jar.ts";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "dist", "cli.js");
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

function run(bin: string, args: string[], cwd: string) {
  const r = spawnSync(bin, args, { cwd, encoding: "utf8", maxBuffer: 1 << 28 });
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

// The target's parent directory is absent, so the write fails (ENOENT ->
// FileNotFoundException). A RELATIVE path exercises the jar's getAbsoluteFile()
// absolutization on line 1 while the IOException on line 2 keeps the original
// (relative) path, so both must be reproduced.
test("listChecks: write-failure mirrors the jar (absolute path + exception line, summary, exit 0)", { skip }, () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "ecw-lc-")));
  try {
    const target = "nonexistent-subdir/checks.txt";
    const j = run(JAVA, ["-jar", JAR, "--listChecks", target], cwd);
    const c = run(process.execPath, [CLI, "--listChecks", target], cwd);
    assert.equal(c.code, j.code, "exit code");
    assert.equal(c.code, 0, "listChecks write-failure exits 0 (dumpMessageDictionary swallows)");
    assert.equal(c.stdout, j.stdout, "stdout (completion summary)");
    assert.equal(c.stderr, j.stderr, "stderr (absolute path + IO exception line)");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
