// Expanded-directory (--mode exp) parity for the CLI: unzip a spread of corpus
// books into temp directories and run BOTH the real epubcheck 5.3.0 jar and the
// compiled CLI (dist/cli.js) over each directory with identical args and cwd,
// asserting byte-identical stdout/stderr and matching exit codes.
//
// Unlike parity.test.ts (frozen goldens, no Java), a directory cannot be a
// committed golden -- it is unzipped fresh and compared live against the jar, so
// these cases SKIP cleanly (never fail) when the jar or a java binary is absent,
// exactly like jar-parity.ts. The jar is located by scripts/epubcheck-jar.ts.
//
// Byte identity needs no path normalization: epubcheck's expanded mode reports
// every location under a synthetic `./<dir-name>.epub` container relative to the
// working directory, and both tools run with cwd = the temp parent and the
// directory named by its basename, so the bytes line up.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, realpathSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JAVA, resolveJarPath } from "../scripts/epubcheck-jar.ts";
import { normalizeReport } from "./normalize.ts";

// The report-content normalizer, matching jar-parity.ts: on top of the shared
// timestamp/order normalization, canonicalize the random UUID epubcheck mints for
// a generated OPF identifier so a jar run and a CLI run compare equal.
function normReport(text: string): string {
  return normalizeReport(text).replace(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
    "UUID",
  );
}

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "dist", "cli.js");
const CORPUS = join(here, "..", "..", "epubcheck-standalone", "test", "corpus");
const JAR = resolveJarPath();

assert.ok(existsSync(CLI), `compiled CLI missing at ${CLI} -- run \`npm run build\` first`);

function haveJava() {
  const r = spawnSync(JAVA, ["-version"], { encoding: "utf8" });
  return !r.error && r.status === 0;
}

// SKIP (do not fail) when the jar/java are not provisioned, so this never blocks
// a Java-free CI run. Provision the jar via the library: (cd ../epubcheck-standalone &&
// npm run build:deps), and ensure `java` is on PATH (or set JAVA / EPUBCHECK_JAR).
const skip: false | string =
  existsSync(JAR) && haveJava()
    ? false
    : `epubcheck jar or java not available (JAR=${JAR})`;

// A spread of the parity corpus: clean and erroring, EPUB 2 and 3, warning-only,
// minimal and full-featured (images/fonts/CSS in the standard-ebooks title).
const BOOKS = [
  "epubcheck-expanded/cli__files__20-severity-tester.epub", // 1 warning + 3 errors
  "epubcheck-expanded/cli__files__30-valid-test.epub", // clean EPUB 3
  "epubcheck-expanded/cli__files__20-warning-tester.epub", // warning only (clean exit)
  "epubcheck-expanded/cli__files__30-mimetype-invalid.epub", // mimetype content error
  "epubcheck-prezipped/epub2_files_epub_ocf-minimal-valid.epub", // clean minimal EPUB 2
  "epubcheck-prezipped/epub3_00-minimal_files_minimal.epub", // clean minimal EPUB 3
  "standard-ebooks/lewis-carroll_alices-adventures-in-wonderland_john-tenniel.epub",
];

for (const rel of BOOKS) {
  const name = basename(rel, ".epub");
  test(`dir-golden: ${name}`, { skip }, () => {
    const book = join(CORPUS, rel);
    assert.ok(existsSync(book), `corpus book missing: ${book}`);
    // realpath so the jar's cwd-based location relativization lines up with the
    // CLI's process.cwd() (macOS mkdtemp returns the /var symlinked form while
    // user.dir is canonical; a mismatched prefix would leave absolute paths).
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), "ecw-dir-")));
    try {
      const dir = join(tmp, name);
      mkdirSync(dir);
      const unzip = spawnSync("unzip", ["-q", book, "-d", dir], { encoding: "utf8" });
      assert.equal(unzip.status, 0, `unzip failed: ${unzip.stderr || unzip.status}`);

      const jarRun = spawnSync(JAVA, ["-jar", JAR, "--mode", "exp", name], {
        cwd: tmp,
        encoding: "utf8",
        maxBuffer: 1 << 28,
      });
      const cliRun = spawnSync(process.execPath, [CLI, "--mode", "exp", name], {
        cwd: tmp,
        encoding: "utf8",
        maxBuffer: 1 << 28,
      });

      assert.equal(cliRun.status, jarRun.status, "exit code");
      assert.equal(cliRun.stdout, jarRun.stdout ?? "", "stdout");
      assert.equal(cliRun.stderr, jarRun.stderr ?? "", "stderr");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
}

// Directory-input report parity. When a report flag (-j/-o/-x) is given with no
// filename and the input is a directory, epubcheck writes the derived report
// BESIDE the directory, at <absolute-parent>/<basename>check.<ext>
// (EpubChecker.processArguments, the -o/-j/-x auto-derive branch). Both tools are
// run over an erroring book so message rows are exercised.
//
// LOCATION parity is asserted for every format below. CONTENT parity is asserted
// for JSON, where the report is fully deterministic: checker.path and
// checker.filename take the synthetic `<dir-name>.epub` container name (not the
// bare directory name) and message locations resolve under it, matching the jar
// byte-for-byte. XML content is NOT byte-compared in expanded mode, because the
// jar embeds the container's ABSOLUTE filesystem path in <repInfo uri> and the
// source files' mtimes in property values -- neither is reproducible across
// environments, and mirroring the absolute path would make the report machine-
// specific and break the (portable, relative) JSON checker.path.
{
  const rel = "epubcheck-expanded/cli__files__20-severity-tester.epub"; // 1 warning + 3 errors
  const name = basename(rel, ".epub");
  for (const [flag, ext, compareContent] of [
    ["-j", "json", true],
    ["-o", "xml", false],
  ] as const) {
    test(`dir-report-parity: ${name} ${flag}`, { skip }, () => {
      const book = join(CORPUS, rel);
      assert.ok(existsSync(book), `corpus book missing: ${book}`);
      const tmp = realpathSync(mkdtempSync(join(tmpdir(), "ecw-dir-")));
      try {
        const dir = join(tmp, name);
        mkdirSync(dir);
        const unzip = spawnSync("unzip", ["-q", book, "-d", dir], { encoding: "utf8" });
        assert.equal(unzip.status, 0, `unzip failed: ${unzip.stderr || unzip.status}`);

        // Auto-derive: the report flag is last, so it takes no filename and each
        // tool derives <basename>check.<ext> beside the directory.
        const derived = join(tmp, name + "check." + ext);

        const jarRun = spawnSync(JAVA, ["-jar", JAR, name, "--mode", "exp", flag], {
          cwd: tmp,
          encoding: "utf8",
          maxBuffer: 1 << 28,
        });
        assert.ok(existsSync(derived), `jar did not write the derived report at ${derived}`);
        const jarReport = normReport(readFileSync(derived, "utf8"));
        rmSync(derived, { force: true });

        const cliRun = spawnSync(process.execPath, [CLI, name, "--mode", "exp", flag], {
          cwd: tmp,
          encoding: "utf8",
          maxBuffer: 1 << 28,
        });
        assert.ok(existsSync(derived), `CLI did not write the derived report at ${derived}`);
        const cliReport = normReport(readFileSync(derived, "utf8"));

        assert.equal(cliRun.status, jarRun.status, "exit code");
        if (compareContent) assert.equal(cliReport, jarReport, "report content");
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  }
}
