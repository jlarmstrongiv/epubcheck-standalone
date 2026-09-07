// Behavioral test for capabilities the epubcheck-standalone engine cannot provide.
// The CLI must FAIL LOUDLY (exit code 2, a clear message on stderr, nothing on
// stdout) rather than silently producing wrong output. See the README
// "Unsupported flags" table. Needs no Java.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "fixtures");
const CLI = join(here, "..", "dist", "cli.js");
const V = "valid.epub";

function runCli(args: string[]) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: fixturesDir,
    encoding: "utf8",
    maxBuffer: 1 << 28,
  });
  return { stdout: r.stdout, stderr: r.stderr, code: r.status };
}

assert.ok(existsSync(CLI), `compiled CLI missing at ${CLI} -- run \`npm run build\` first`);

// The only capability the engine still cannot reproduce is a locale outside the
// shipped set. It must exit 2 with a clear message. (Custom message overrides,
// remote URL inputs, and expanded --mode exp / directory checking are now
// supported -- see the "now supported" cases below and url.test.ts.)
const UNSUPPORTED = [
  // Tags that resolve to a shipped bundle ONLY through Java's host-dependent
  // default-locale fallback are refused: their jar output is not provably
  // byte-identical across hosts. That is any unshipped language (ru, pl) and the
  // BARE ko/pt/zh (those ship only region-qualified: ko-KR/pt-BR/zh-TW).
  { name: "locale-unshipped", args: ["--locale", "ru", V] },
  { name: "locale-unshipped-pl", args: ["--locale", "pl", V] },
  // Bare ko/pt/zh: only the region-qualified bundle ships, so the bare tag would
  // need default-locale fallback -> refused.
  { name: "locale-bare-ko", args: ["--locale", "ko", V] },
  { name: "locale-bare-zh", args: ["--locale", "zh", V] },
  { name: "locale-bare-pt", args: ["--locale", "pt", V] },
  // An entirely unknown region-qualified tag.
  { name: "locale-unknown-region", args: ["--locale", "xx-YY", V] },
];

for (const c of UNSUPPORTED) {
  test(`unsupported: ${c.name}`, () => {
    const r = runCli(c.args);
    assert.equal(r.code, 2, "exit code should be 2 (unsupported)");
    assert.match(r.stderr, /unsupported option/, "stderr explains the limitation");
  });
}

// Flags that were previously refused but the engine now honors (passed through):
// they must NOT be rejected with exit 2 / the "unsupported option" message. Their
// exact bytes and exit codes are pinned by the golden matrix (parity.test.ts); here
// we only assert they are no longer gated.
const NOW_SUPPORTED = [
  { name: "usage-short", args: ["-u", "invalid.epub"] },
  { name: "usage-long", args: ["--usage", "invalid.epub"] },
  { name: "profile-edupub", args: ["--profile", "edupub", V] },
  { name: "profile-dict", args: ["--profile", "dict", V] },
  { name: "mode-xhtml", args: ["--mode", "xhtml", "-v", "3.0", "content.xhtml"] },
  { name: "locale-fr", args: ["--locale", "fr", "invalid.epub"] },
  { name: "locale-ja", args: ["--locale", "ja", "invalid.epub"] },
  { name: "locale-ko-KR", args: ["--locale", "ko-KR", "invalid.epub"] },
  // Region-qualified tags of shipped LANGUAGES resolve deterministically to the
  // bare-language bundle (region -> language), independent of the host default
  // locale, so they are now accepted (proven byte-identical to the jar).
  { name: "locale-en-US", args: ["--locale", "en-US", "invalid.epub"] },
  { name: "locale-fr-FR", args: ["--locale", "fr-FR", "invalid.epub"] },
  { name: "locale-de-DE", args: ["--locale", "de-DE", "invalid.epub"] },
  { name: "locale-ja-JP", args: ["--locale", "ja-JP", "invalid.epub"] },
  { name: "locale-en-GB", args: ["--locale", "en-GB", "invalid.epub"] },
  // Expanded checking is no longer refused. `--mode exp` on a packaged .epub
  // routes through the expanded path (the jar's own edge behavior: not exit 2);
  // directory parity is proven byte-for-byte in expanded.test.ts.
  { name: "mode-exp-file", args: ["--mode", "exp", V] },
  // Custom message overrides are no longer refused: -c rides through the engine.
  // Byte-for-byte parity is pinned by the golden matrix (parity.test.ts cm-*).
  { name: "custom-messages-promote", args: ["-c", "cm-promote.txt", "--mode", "xhtml", "-v", "3.0", "acc.xhtml"] },
  { name: "custom-messages-missing", args: ["-c", "cm-missing.txt", "invalid.epub"] },
  { name: "custom-messages-none", args: ["-c", "none", V] },
];

for (const c of NOW_SUPPORTED) {
  test(`now supported: ${c.name}`, () => {
    const r = runCli(c.args);
    assert.notEqual(r.code, 2, "must not be gated as unsupported");
    assert.doesNotMatch(r.stderr, /unsupported option/, "must not be rejected");
  });
}

// Options that LOOK exotic but the engine CAN honor and that leave a valid book
// clean (must NOT be rejected, and must still validate to exit 0).
const SUPPORTED = [
  // --save on a packaged .epub file is a silent no-op, exactly like the jar
  // (it only writes a file for an explicit `--mode exp` directory check --
  // the real behavior is covered by save.test.ts).
  { name: "save-on-packaged-file", args: ["--save", V] },
  { name: "profile-default", args: ["--profile", "default", V] },
  { name: "locale-english", args: ["--locale", "en", V] },
];

for (const c of SUPPORTED) {
  test(`supported: ${c.name}`, () => {
    const r = runCli(c.args);
    assert.equal(r.code, 0, "valid EPUB should validate cleanly");
    assert.doesNotMatch(r.stderr, /unsupported option/, "must not be rejected");
  });
}
