// URL-input parity for the CLI: serve the committed fixtures over a LOCAL http
// server (never the network) and validate them by URL through the compiled CLI
// (dist/cli.js), comparing against the REAL epubcheck.jar run against the SAME
// URLs.
//
// PARITY MODEL (jar-identical, mirroring the library's own test/url.ts): the
// url() plugin hands the URL to epubcheck as the input path and the engine
// SUSPENDS mid-run while the library's async http bridge downloads it, so a
// URL run is byte-identical to the jar validating that same URL -- message
// locations carry the URL PREFIX (e.g. ERROR(OPF-049): <url>/OPS/package.opf),
// NOT the downloaded basename as the retired fetch-then-validate model did.
// A same-protocol redirect is followed by both sides and locations keep the
// ORIGINAL (redirecting) URL.
//
// The ONE unreproducible token of a success run is the random temp file the
// download is named after: messages located on the container file itself (e.g.
// PKG-010) embed it -- the jar prints <TMPDIR>/epub<random>.epub, the engine
// /tmp/epub<random>.epub in its VFS. That single token is normalized on both
// sides (normalizeTempDownload) and nothing else is allowed to differ.
//
// Download failures (404 / connection refused) are jar-identical too: the
// engine emits the jar's exception HEADLINE to stderr ("java.lang.Runtime-
// Exception: java.io.FileNotFoundException: <url>" / "java.net.ConnectException:
// Connection refused"), prints the completion summary to stdout, and exits 1.
// The stack FRAMES under the headline are runtime internals (JDK socket frames
// vs TeaVM function frames) and are stripped on both sides before comparison.
//
// The jar-comparison cases need the jar + java and SKIP cleanly when either is
// absent (the jar is located by scripts/epubcheck-jar.ts); the failure test also
// asserts the CLI's own deterministic contract, which needs no jar and always
// runs. The server lives in THIS process, so the CLI/jar (child processes) never
// read from it directly -- they download over http -- and both are spawned
// ASYNChronously so a spawnSync cannot deadlock the event loop the server needs.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JAVA, resolveJarPath } from "../scripts/epubcheck-jar.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "fixtures");
const CLI = join(here, "..", "dist", "cli.js");
const JAR = resolveJarPath();

assert.ok(existsSync(CLI), `compiled CLI missing at ${CLI} -- run \`npm run build\` first`);

// The completion summary the jar prints (via run()'s finally) even when a URL
// download fails -- 0 counts at the default INFO reporting level.
const COMPLETION_SUMMARY =
  "Messages: 0 fatals / 0 errors / 0 warnings / 0 infos\n\nEPUBCheck completed\n";

function haveJava() {
  const r = spawnSync(JAVA, ["-version"], { encoding: "utf8" });
  return !r.error && r.status === 0;
}

// SKIP (do not fail) the jar-comparison cases when the jar/java are not
// provisioned. Provision the jar via the library: (cd ../epubcheck-standalone &&
// npm run build:deps), and ensure `java` is on PATH (or set JAVA / EPUBCHECK_JAR).
const skip: false | string =
  existsSync(JAR) && haveJava()
    ? false
    : `epubcheck jar or java not available (JAR=${JAR})`;

interface Side {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Spawn a command asynchronously and collect its output (see the deadlock note). */
function runAsync(bin: string, args: string[]): Promise<Side> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
  });
}

const runCli = (url: string): Promise<Side> => runAsync(process.execPath, [CLI, url]);
// Run the real jar on the URL itself (the jar downloads it), matching the
// engine's URL-as-input-path model -- NOT a local copy.
const runJar = (url: string): Promise<Side> => runAsync(JAVA, ["-jar", JAR, url]);

// --- the pinned normalizations (mirror the library's test/url.ts) ------------

/** Normalize the ONE unreproducible token of a success run: the random temp file
 *  the download is named after. Jar: <TMPDIR>/epub<random>.epub (macOS
 *  /var/folders/... or /tmp/... on Linux); engine: /tmp/epub<random>.epub in its
 *  VFS. Anchored on the temp roots and the epub<digits>.epub basename so it can
 *  never touch the URL itself. */
const normalizeTempDownload = (text: string): string =>
  text.replace(/\/(?:private\/)?(?:var|tmp)\/[^\s()]*?epub\d+\.epub/g, "/TMP/epub.epub");

/** Keep only the reproducible stderr lines of a FAILURE run: drop stack frames. */
const stripFrames = (text: string): string =>
  text
    .split("\n")
    .filter((line) => !/^\s+at /.test(line) && !/^\s*\.\.\. \d+ more$/.test(line))
    .join("\n");

/** Assert a success run is byte-identical to the jar (temp token normalized). */
function assertSuccessParity(label: string, c: Side, j: Side): void {
  assert.equal(c.code, j.code, `${label}: exit code (cli=${c.code} jar=${j.code})`);
  assert.equal(normalizeTempDownload(c.stdout), normalizeTempDownload(j.stdout), `${label}: stdout`);
  assert.equal(normalizeTempDownload(c.stderr), normalizeTempDownload(j.stderr), `${label}: stderr`);
}

// --- the local HTTP server (serves fixtures to the CLI/jar url download) -------
const server: Server = createServer((req, res) => {
  const path = req.url ?? "/";
  // A same-protocol redirect: both sides follow it and report locations under
  // the ORIGINAL (redirecting) URL.
  if (path === "/redirect.epub") {
    res.writeHead(302, { Location: "/invalid.epub" });
    res.end();
    return;
  }
  const file =
    path === "/invalid.epub"
      ? join(fixturesDir, "invalid.epub")
      : path === "/valid.epub"
        ? join(fixturesDir, "valid.epub")
        : null;
  if (!file) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found\n");
    return;
  }
  const bytes = readFileSync(file);
  res.writeHead(200, { "Content-Type": "application/epub+zip", "Content-Length": bytes.length });
  res.end(bytes);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

// A port with NOTHING listening (bound once to reserve it, then released).
const refusedPort: number = await new Promise((r) => {
  const s = createServer();
  s.listen(0, "127.0.0.1", () => {
    const p = (s.address() as { port: number }).port;
    s.close(() => r(p));
  });
});

after(() => new Promise<void>((r) => server.close(() => r())));

// --- happy path: a book with messages (exit 1), locations carry the URL --------
test("url: happy path (book with messages)", { skip }, async () => {
  const url = `${base}/invalid.epub`;
  const [c, j] = [await runCli(url), await runJar(url)];
  assertSuccessParity("invalid.epub", c, j);
  assert.equal(c.code, 1, "a book with errors exits 1");
  assert.ok(
    c.stderr.includes(`ERROR(OPF-049): ${url}/OPS/package.opf`),
    `location carries the URL prefix (not the downloaded basename): ${c.stderr}`,
  );
});

// --- happy path: a clean book (exit 0) ----------------------------------------
test("url: happy path (clean book, exit 0)", { skip }, async () => {
  const url = `${base}/valid.epub`;
  const [c, j] = [await runCli(url), await runJar(url)];
  assertSuccessParity("valid.epub", c, j);
  assert.equal(c.code, 0, "clean book exits 0");
});

// --- same-protocol redirect: locations keep the ORIGINAL (redirecting) URL -----
test("url: same-protocol redirect keeps the original URL", { skip }, async () => {
  const url = `${base}/redirect.epub`;
  const [c, j] = [await runCli(url), await runJar(url)];
  assertSuccessParity("redirect.epub", c, j);
  assert.ok(
    c.stderr.includes(`ERROR(OPF-049): ${url}/OPS/package.opf`),
    `location carries the ORIGINAL redirecting URL: ${c.stderr}`,
  );
});

// --- download failures (404 + connection refused): exit 1 + jar headline -------
// The CLI's own contract (exit 1, completion summary on stdout, the jar-identical
// exception headline on stderr) is deterministic and always runs; the byte-level
// jar-parity comparison runs only when the jar + java are available.
test("url: download failures exit 1 with the exception headline", async () => {
  // 404: java.io.FileNotFoundException, named after the URL.
  {
    const url = `${base}/missing.epub`;
    const c = await runCli(url);
    assert.equal(c.code, 1, "404: exit code");
    assert.equal(c.stdout, COMPLETION_SUMMARY, "404: completion summary on stdout");
    assert.ok(
      c.stderr.startsWith(`java.lang.RuntimeException: java.io.FileNotFoundException: ${url}`),
      `404: FileNotFoundException headline names the URL: ${c.stderr}`,
    );
    if (!skip) {
      const j = await runJar(url);
      assert.equal(c.code, j.code, "404: exit code matches jar");
      assert.equal(c.stdout, j.stdout, "404: stdout matches jar");
      assert.equal(stripFrames(c.stderr), stripFrames(j.stderr), "404: stderr headlines match jar");
    }
  }

  // Connection refused: java.net.ConnectException.
  {
    const url = `http://127.0.0.1:${refusedPort}/nothing.epub`;
    const c = await runCli(url);
    assert.equal(c.code, 1, "refused: exit code");
    assert.equal(c.stdout, COMPLETION_SUMMARY, "refused: completion summary on stdout");
    assert.ok(
      c.stderr.includes("java.net.ConnectException: Connection refused"),
      `refused: ConnectException headline on stderr: ${c.stderr}`,
    );
    if (!skip) {
      const j = await runJar(url);
      assert.equal(c.code, j.code, "refused: exit code matches jar");
      assert.equal(c.stdout, j.stdout, "refused: stdout matches jar");
      assert.equal(stripFrames(c.stderr), stripFrames(j.stderr), "refused: stderr headlines match jar");
    }
  }
});
