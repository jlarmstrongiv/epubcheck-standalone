#!/usr/bin/env node
// Generate packages/epubcheck-standalone/THIRD-PARTY-NOTICES.txt.
//
//   node scripts/generate-notices.ts            # (re)write the notices file
//   node scripts/generate-notices.ts --check    # fail if the committed file is stale
//
// Run directly with Node 26+ (native TypeScript). No build step, no deps.
//
// EVERYTHING that can drift is read from tracked sources -- nothing is
// hardcoded here except the fixed template prose:
//   - the bundled-dependency inventory + primary copyright come from the
//     epubcheck release files build/epubcheck-THIRD-PARTY.txt and
//     build/epubcheck-LICENSE.txt (tracked copies of the fetched release);
//   - the epubcheck / JZlib VERSIONS come from mise.toml [env] (the single
//     source of truth for the pinned build inputs);
//   - the TeaVM version comes from teavm/build.gradle.kts (the teavmVersion val);
//   - the JZlib sha256 comes from scripts/fetch-deps.ts (where the download
//     is verified against it).
// Same inputs -> byte-identical output (determinism), so `--check` can guard
// against a hand-edited or stale committed file in CI.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const pkgRoot = dirname(scriptDir);
const repoRoot = dirname(dirname(pkgRoot));

const paths = {
  thirdParty: join(pkgRoot, "build", "epubcheck-THIRD-PARTY.txt"),
  license: join(pkgRoot, "build", "epubcheck-LICENSE.txt"),
  miseToml: join(repoRoot, "mise.toml"),
  teavmBuildGradle: join(pkgRoot, "teavm", "build.gradle.kts"),
  fetchDeps: join(scriptDir, "fetch-deps.ts"),
  out: join(pkgRoot, "THIRD-PARTY-NOTICES.txt"),
};

const read = (p: string): string => readFileSync(p, "utf8");

// --- version + checksum inputs ----------------------------------------------

function must(re: RegExp, text: string, what: string): string {
  const m = text.match(re);
  if (!m) throw new Error(`could not read ${what} from source`);
  return m[1];
}

function readVersions() {
  const mise = read(paths.miseToml);
  const teavmGradle = read(paths.teavmBuildGradle);
  const fetchDeps = read(paths.fetchDeps);
  const epubcheck = must(/^EPUBCHECK_VERSION\s*=\s*"([^"]+)"/m, mise, "EPUBCHECK_VERSION (mise.toml [env])");
  const jzlib = must(/^JZLIB_VERSION\s*=\s*"([^"]+)"/m, mise, "JZLIB_VERSION (mise.toml [env])");
  // val teavmVersion = "0.15.0"
  const teavm = must(/\bteavmVersion\s*=\s*"([^"]+)"/, teavmGradle, "teavmVersion (teavm/build.gradle.kts)");
  const jzlibSha = must(/JZLIB_SHA256\s*=\s*['"]([0-9a-f]+)['"]/, fetchDeps, "JZLIB_SHA256 (scripts/fetch-deps.ts)");
  return { epubcheck, jzlib, teavm, jzlibSha };
}

// --- primary component copyright (verbatim from epubcheck-LICENSE.txt) -------

function readPrimaryCopyright(): string[] {
  return read(paths.license)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^Copyright\b/.test(l));
}

// --- bundled dependency inventory (verbatim from epubcheck-THIRD-PARTY.txt) --

type Dep = { name: string; version: string; licenses: string[] };

function readInventory(): Dep[] {
  const blocks = read(paths.thirdParty)
    .replace(/\r\n/g, "\n")
    .split(/\n\s*\n/)
    .map((b) => b.split("\n").map((l) => l.trim()).filter(Boolean))
    .filter((lines) => lines.length > 0);

  const deps: Dep[] = [];
  for (const lines of blocks) {
    const head = lines[0];
    // Skip the title block ("Licenses of third-party dependencies\n-----"),
    // separator lines, and the trailing "Copies of the licenses..." note.
    if (/^Licenses of /i.test(head) || /^Copies of /i.test(head) || /^-+$/.test(head)) continue;
    const sep = head.lastIndexOf(", ");
    if (sep === -1) continue; // not a "Name, version" line
    deps.push({
      name: head.slice(0, sep),
      version: head.slice(sep + 2),
      licenses: lines.slice(1),
    });
  }
  return deps;
}

function renderInventory(deps: Dep[]): string {
  const lefts = deps.map((d) => `${d.name}, ${d.version}`);
  // Align the license column to the longest name -- but cap it so a single
  // outlier (e.g. Guava's "9999.0-empty-to-avoid-conflict-with-guava"
  // placeholder version) does not push every line far to the right. Entries
  // longer than the cap simply get a one-dot separator.
  const col = Math.min(Math.max(...lefts.map((l) => l.length)) + 2, 62);
  return deps
    .map((d, i) => {
      const left = lefts[i];
      const dots = ".".repeat(Math.max(1, col - left.length - 1));
      return `  ${left} ${dots} ${d.licenses.join(" / ")}`;
    })
    .join("\n");
}

// --- assemble ---------------------------------------------------------------

const RULE = "-".repeat(80);

function generate(): string {
  const v = readVersions();
  const copyrights = readPrimaryCopyright();
  const inventory = renderInventory(readInventory());

  return `THIRD-PARTY NOTICES for epubcheck-standalone
============================================

GENERATED FILE -- do not hand-edit.
Produced by scripts/generate-notices.ts from the epubcheck release license
inventory (build/epubcheck-THIRD-PARTY.txt, build/epubcheck-LICENSE.txt), the
build-input versions pinned in mise.toml, and the TeaVM version pinned in
teavm/build.gradle.kts. To update, run: npm run generate:notices

The shipped engine (dist/epubcheck-engine.js) is produced by compiling epubcheck
${v.epubcheck} and its Java dependencies to plain JavaScript with TeaVM
(github.com/konsoletyper/teavm). It therefore embeds code from the components
below. This file reproduces the license inventory published with epubcheck
${v.epubcheck}, plus the extra components this project adds for the engine build,
plus the toolchain that generated the engine.

${RULE}
1. Primary component
${RULE}

epubcheck, ${v.epubcheck}  (w3c/epubcheck)
  BSD 3-Clause License.
${copyrights.map((c) => `  ${c}`).join("\n")}
  https://github.com/w3c/epubcheck

${RULE}
2. Dependencies bundled inside epubcheck ${v.epubcheck} (compiled into the engine)
   (verbatim from the epubcheck ${v.epubcheck} THIRD-PARTY.txt inventory)
${RULE}

${inventory}

Full license texts for the above are published by the epubcheck project in its
release under the \`licenses/\` directory.

${RULE}
3. Extra components this project adds for the engine build
${RULE}

JZlib, ${v.jzlib}  (com.jcraft:jzlib)
  BSD 3-Clause / BSD-style License.
  Copyright (c) 2000-2011 ymnk, JCraft, Inc.
  https://github.com/ymnk/jzlib
  sha256 ${v.jzlibSha}
  Used to provide a pure-Java Inflater (deflate decompression) in place of the
  JDK's native java.util.zip native code, which the TeaVM backend cannot load.

${RULE}
4. Toolchain that produced the engine
${RULE}

TeaVM, ${v.teavm}  (org.teavm)
  Apache License, Version 2.0.
  https://github.com/konsoletyper/teavm
  The engine JavaScript (dist/epubcheck-engine.js) is produced by TeaVM's
  JavaScript backend, so it embeds the TeaVM runtime and classlib. This project
  also forks parts of the TeaVM classlib under teavm/shims to bridge gaps between
  the epubcheck stack and the stock classlib; those forked sources are Apache-2.0
  as well. Only the OUTPUT is redistributed here; the toolchain itself is not
  vendored (see agent-docs/BUILDING.md).
`;
}

// --- entrypoint -------------------------------------------------------------

const content = generate();

if (process.argv.includes("--check")) {
  let committed = "";
  try {
    committed = read(paths.out);
  } catch {
    committed = "";
  }
  if (committed !== content) {
    console.error(
      "THIRD-PARTY-NOTICES.txt is stale or hand-edited.\n" +
        "Run: npm run generate:notices",
    );
    process.exit(1);
  }
  console.log("THIRD-PARTY-NOTICES.txt is up to date.");
} else {
  writeFileSync(paths.out, content);
  console.log(`Wrote ${paths.out}`);
}
