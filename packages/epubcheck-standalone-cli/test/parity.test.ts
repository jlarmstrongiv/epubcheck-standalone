// CI-safe parity suite: runs the COMPILED CLI (dist/cli.js) across the parity
// matrix and asserts byte-for-byte equality with the frozen golden outputs
// captured from the real epubcheck 5.3.0 jar (test/expected/*.json, regenerated
// by test/generate-goldens.ts). Only the documented run-varying report fields
// are normalized (see test/normalize.ts); every other byte must match.
//
// This needs only the epubcheck-standalone engine (no Java), so it runs in CI. For a
// live side-by-side comparison against the actual jar, see test/jar-parity.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CASES } from "./matrix.ts";
import { normalizeReport } from "./normalize.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "fixtures");
const expectedDir = join(here, "expected");
const CLI = join(here, "..", "dist", "cli.js");

assert.ok(existsSync(CLI), `compiled CLI missing at ${CLI} -- run \`npm run build\` first`);

function runCli(args: string[]) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: fixturesDir,
    encoding: "utf8",
    maxBuffer: 1 << 28,
  });
  if (r.error) throw r.error;
  return { stdout: r.stdout, stderr: r.stderr, code: r.status };
}

for (const c of CASES) {
  test(c.name, () => {
    const golden = JSON.parse(readFileSync(join(expectedDir, c.name + ".json"), "utf8"));

    const tmp = mkdtempSync(join(tmpdir(), "ecw-test-"));
    let outFile = null;
    const args = c.args.map((a) => {
      if (a === "OUTFILE") {
        outFile = join(tmp, "report." + c.outExt);
        return outFile;
      }
      return a;
    });

    try {
      const got = runCli(args);
      assert.equal(got.code, golden.code, "exit code");
      assert.equal(normalizeReport(got.stdout), golden.stdout, "stdout");
      assert.equal(normalizeReport(got.stderr), golden.stderr, "stderr");
      if (golden.file !== undefined) {
        assert.ok(outFile && existsSync(outFile), "expected an output file to be written");
        assert.equal(normalizeReport(readFileSync(outFile, "utf8")), golden.file, "report file");
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
}
