#!/usr/bin/env node
// Regenerates the committed golden outputs (test/expected/*.json) by running the
// REAL epubcheck jar across the parity matrix. These goldens are the frozen
// "ground truth" the CI-safe parity test (parity.test.ts) checks the CLI
// against -- so the jar is needed only to (re)generate them, never in CI.
//
//   node test/generate-goldens.ts
//
// Java + jar are located by scripts/epubcheck-jar.ts (env/glob, never
// hardcoded); override with the EPUBCHECK_JAR / JAVA env vars.
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CASES } from "./matrix.ts";
import { normalizeReport } from "./normalize.ts";
import { JAVA, resolveJarPath } from "../scripts/epubcheck-jar.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "fixtures");
const expectedDir = join(here, "expected");

const JAR = resolveJarPath();

if (!existsSync(JAR)) {
  console.error(
    `epubcheck jar not found at ${JAR}.\n` +
      `Fetch it via the library's build inputs:\n` +
      `  (cd ../epubcheck-standalone && npm run build:deps)\n` +
      `or set EPUBCHECK_JAR to a copy of the epubcheck.jar.`,
  );
  process.exit(1);
}
if (!existsSync(expectedDir)) mkdirSync(expectedDir, { recursive: true });

for (const c of CASES) {
  const tmp = mkdtempSync(join(tmpdir(), "ecw-gold-"));
  let outFile: string | null = null;
  const args = c.args.map((a) => {
    if (a === "OUTFILE") {
      outFile = join(tmp, "report." + c.outExt);
      return outFile;
    }
    return a;
  });
  const r = spawnSync(JAVA, ["-jar", JAR, ...args], {
    cwd: fixturesDir,
    encoding: "utf8",
    maxBuffer: 1 << 28,
  });
  const golden: {
    args: string[];
    stdout: string;
    stderr: string;
    code: number | null;
    file?: string;
  } = {
    args: c.args,
    stdout: normalizeReport(r.stdout),
    stderr: normalizeReport(r.stderr),
    code: r.status,
  };
  if (outFile) {
    golden.file = normalizeReport(readFileSync(outFile, "utf8"));
  }
  writeFileSync(join(expectedDir, c.name + ".json"), JSON.stringify(golden, null, 2) + "\n");
  rmSync(tmp, { recursive: true, force: true });
  console.log(`captured ${c.name} (exit ${r.status})`);
}
console.log(`\nWrote ${CASES.length} goldens to ${expectedDir}`);
