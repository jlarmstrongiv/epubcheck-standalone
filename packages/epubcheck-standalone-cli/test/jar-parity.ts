#!/usr/bin/env node
// CLI parity in two phases:
//   1. flag/scenario MATRIX (test/matrix.ts) -- runs the REAL epubcheck jar and
//      the compiled CLI side by side over the committed fixtures and diffs
//      stdout, stderr, exit code, and report bytes. This is CLI-flag-specific
//      behavior, so it stays a live jar comparison; it auto-skips when the jar
//      or java is absent (unless EPUBCHECK_REQUIRE_JAR=1, then it hard-fails).
//   2. corpus CONSOLE PARITY -- validates a dial-controlled sample of the real
//      committed corpus through the CLI and compares its normalized console
//      output to the COMMITTED JAR CONSOLE CACHE
//      (../epubcheck-standalone/test/expected/<group>.json). NO live jar: it
//      reads the same cache the library's engine is tested against, so the CLI
//      is proven to match Java without spawning it. Runs anywhere, jar or not.
//
//   node test/jar-parity.ts                 default: ~50 stable-sampled books
//   PARITY=full node test/jar-parity.ts     every book in the corpus
//   PARITY=120 node test/jar-parity.ts      ~120 stable-sampled books
//
// Config via env: EPUBCHECK_JAR, JAVA, EPUBCHECK_CORPUS, EPUBCHECK_REQUIRE_JAR.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, existsSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { CASES } from "./matrix.ts";
import { normalizeReport } from "./normalize.ts";
import { JAVA, resolveJarPath } from "../scripts/epubcheck-jar.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "fixtures");
const CLI = join(here, "..", "dist", "cli.js");

// The corpus and its committed jar console cache live under the sibling library
// package. The cache path is anchored to that package (not to EPUBCHECK_CORPUS)
// because the cache is generated for the committed corpus specifically.
const LIB_PKG = join(here, "..", "..", "epubcheck-standalone");
const REPO_CORPUS = join(LIB_PKG, "test", "corpus");
const CACHE_DIR = join(LIB_PKG, "test", "expected");
const JAR = resolveJarPath();
const CORPUS = process.env["EPUBCHECK_CORPUS"] || REPO_CORPUS;
const REQUIRE_JAR = process.env["EPUBCHECK_REQUIRE_JAR"] === "1";

function haveJava() {
  const r = spawnSync(JAVA, ["-version"], { encoding: "utf8" });
  return !r.error && r.status === 0;
}
const jarAvailable = existsSync(JAR) && haveJava();

if (!existsSync(CLI)) {
  console.error(`compiled CLI missing at ${CLI} -- run \`npm run build\` first.`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// PARITY dial + STABLE per-book sampling. This MIRRORS the canonical definition
// in epubcheck-standalone/test/sample.ts and MUST stay in sync with it, so the
// CLI checks the same sampled set as the library runners. It is inlined rather
// than imported because this package's type-check (tsconfig.tests.json, rootDir
// ".") cannot reach a file in the sibling package.
const DEFAULT_SAMPLE = 50;
const SAMPLE_GRID = 446; // fixed reference (see sample.ts) -- NOT the live corpus size
const HASH_RESOLUTION = 1_000_000;
interface Dial { full: boolean; n: number; label: string; }
function parseDial(): Dial {
  const v = (process.env["PARITY"] ?? "").trim().toLowerCase();
  if (v === "") return { full: false, n: DEFAULT_SAMPLE, label: String(DEFAULT_SAMPLE) };
  if (v === "full" || v === "all") return { full: true, n: Infinity, label: "full" };
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
    throw new Error(`invalid PARITY=${process.env["PARITY"]} -- use a non-negative integer or "full"`);
  }
  return { full: false, n, label: String(n) };
}
function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}
function inSample(relPath: string, dial: Dial): boolean {
  if (dial.full || dial.n >= SAMPLE_GRID) return true;
  if (dial.n <= 0) return false;
  return (fnv1a(relPath) % HASH_RESOLUTION) / HASH_RESOLUTION < dial.n / SAMPLE_GRID;
}
const dial = parseDial();

// ---------------------------------------------------------------------------
// Normalization.
// normConsole: report-field masking + the per-run UUID host, used by the matrix
// to compare full CLI stdout/stderr against the live jar.
function normConsole(text: string): string {
  return normalizeReport(text).replace(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\.epubcheck\.w3c\.org)/g,
    "UUID",
  );
}
// normalizeMessages: collapse console output to the SORTED message-token set the
// console cache stores (byte-identical rules to the library's cache builder --
// mask the container path to "EPUB" and the per-run UUID host; everything else
// literal). Used by Phase 2 to compare the CLI against the cache.
const reEsc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const MSG_RE = /^(FATAL|ERROR|WARNING|INFO)\(([A-Z0-9]+[-_]\d+[a-z]?)\):\s*(.*)$/;
function normalizeMessages(raw: string, epubBase: string): string[] {
  const pathRe = new RegExp("[^\\s(]*" + reEsc(epubBase), "g");
  const uuidRe = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\.epubcheck\.w3c\.org)/g;
  const msgs: string[] = [];
  for (let line of raw.split("\n")) {
    line = line.replace(pathRe, "EPUB").replace(uuidRe, "UUID");
    const m = line.match(MSG_RE);
    if (m) msgs.push(`${m[1]}(${m[2]}): ${m[3]}`);
  }
  msgs.sort();
  return msgs;
}

function run(bin: string[], argv: string[], cwd: string) {
  const r = spawnSync(bin[0] as string, [...bin.slice(1), ...argv], {
    cwd,
    encoding: "utf8",
    maxBuffer: 1 << 28,
  });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status };
}

let pass = 0;
let fail = 0;
const failures: string[] = [];

// Matrix comparison: CLI vs live jar (stdout/stderr/exit/report bytes).
function compareMatrix(label: string, args: string[], cwd: string, withFile: string | null | undefined) {
  const tmp = withFile ? mkdtempSync(join(tmpdir(), "ecw-jp-")) : null;
  let outFile: string | null = null;
  const mapArg = (a: string): string => {
    if (a === "OUTFILE") {
      outFile = join(tmp as string, "report." + withFile);
      return outFile;
    }
    return a;
  };
  const jargs = args.map(mapArg);
  const j = run([JAVA, "-jar", JAR], jargs, cwd);
  const jFile = outFile ? normalizeReport(readFileSync(outFile, "utf8")) : null;

  outFile = null;
  const cargs = args.map(mapArg);
  const c = run([process.execPath, CLI], cargs, cwd);
  const cFile = outFile ? normalizeReport(readFileSync(outFile, "utf8")) : null;

  const diffs = [];
  if (j.code !== c.code) diffs.push(`code jar=${j.code} cli=${c.code}`);
  if (normConsole(j.stdout) !== normConsole(c.stdout)) diffs.push("stdout");
  if (normConsole(j.stderr) !== normConsole(c.stderr)) diffs.push("stderr");
  if (jFile !== null && jFile !== cFile) diffs.push("file");
  if (tmp) rmSync(tmp, { recursive: true, force: true });

  if (diffs.length === 0) pass++;
  else { fail++; failures.push(`${label}: ${diffs.join(", ")}`); }
}

// --- Phase 1: the matrix (live jar) ---
let matrixPass = 0;
let matrixFail = 0;
let matrixRan = false;
if (jarAvailable) {
  matrixRan = true;
  console.log("== Phase 1: flag/scenario matrix (CLI vs live jar) ==");
  for (const cse of CASES) compareMatrix(cse.name, cse.args, fixturesDir, cse.outExt);
  console.log(`matrix: ${pass} pass / ${fail} fail`);
  matrixPass = pass;
  matrixFail = fail;
  pass = 0;
  fail = 0;
} else if (REQUIRE_JAR) {
  console.error(
    `Phase 1 matrix needs the epubcheck jar + java but EPUBCHECK_REQUIRE_JAR=1 (JAR=${JAR}).\n` +
      `Provision the jar: (cd ../epubcheck-standalone && npm run build:deps), and ensure java is on PATH.`,
  );
  process.exit(1);
} else {
  console.log(
    "== Phase 1: flag/scenario matrix ==\n" +
      `SKIP matrix: epubcheck jar or java not available (JAR=${JAR}). Phase 2 still runs against the console cache.`,
  );
}

// --- Phase 2: corpus console parity (CLI vs committed jar cache, no live jar) ---
interface CacheEntry { exit: number | null; messages: string[]; }
console.log(`\n== Phase 2: corpus console parity (CLI vs jar cache; dial PARITY=${dial.label}) ==`);
if (!existsSync(CORPUS)) {
  console.log("SKIP corpus parity: corpus not found.");
} else {
  const groups = readdirSync(CORPUS)
    .filter((d) => {
      try { return statSync(join(CORPUS, d)).isDirectory() && readdirSync(join(CORPUS, d)).some((f) => f.toLowerCase().endsWith(".epub")); }
      catch { return false; }
    })
    .sort();
  let selected = 0;
  let total = 0;
  for (const group of groups) {
    const dir = join(CORPUS, group);
    const cachePath = join(CACHE_DIR, `${group}.json`);
    if (!existsSync(cachePath)) {
      fail++;
      failures.push(`sweep:${group}: no console cache at ${cachePath} -- run epubcheck-standalone: npm run test:parity:generate`);
      continue;
    }
    const cache = JSON.parse(readFileSync(cachePath, "utf8")) as Record<string, CacheEntry>;
    const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".epub")).sort();
    total += files.length;
    for (const file of files) {
      if (!inSample(`${group}/${file}`, dial)) continue;
      selected++;
      const exp = cache[file];
      if (!exp) {
        fail++;
        failures.push(`sweep:${file}: no cache entry in ${group}.json`);
        continue;
      }
      const c = run([process.execPath, CLI], [file], dir);
      const gotMsgs = normalizeMessages(`${c.stdout}\n${c.stderr}`, file);
      const diffs: string[] = [];
      if (exp.exit !== c.code) diffs.push(`code cache=${exp.exit} cli=${c.code}`);
      if (JSON.stringify(exp.messages) !== JSON.stringify(gotMsgs)) {
        const onlyCache = exp.messages.filter((m) => !gotMsgs.includes(m));
        const onlyCli = gotMsgs.filter((m) => !exp.messages.includes(m));
        diffs.push(
          "messages" +
            onlyCache.map((m) => `\n      - cache only: ${m}`).join("") +
            onlyCli.map((m) => `\n      + cli only:   ${m}`).join(""),
        );
      }
      if (diffs.length === 0) pass++;
      else { fail++; failures.push(`sweep:${group}/${file}: ${diffs.join(", ")}`); }
    }
  }
  console.log(`sweep: ${pass} pass / ${fail} fail (${selected} of ${total} books at dial PARITY=${dial.label})`);
}
const sweepFail = fail;

console.log("\n== Summary ==");
console.log(matrixRan ? `matrix: ${matrixPass} pass / ${matrixFail} fail` : "matrix: SKIPPED (no jar)");
console.log(`sweep:  ${pass} pass / ${sweepFail} fail`);
if (failures.length) {
  console.log("\nFailures:");
  for (const f of failures) console.log("  " + f);
}
process.exit(matrixFail + sweepFail === 0 ? 0 : 1);
