#!/usr/bin/env node
// Single-source-of-truth consistency checker for the monorepo.
//
// This script contains NO version literals. Every value it compares is READ
// from its source of truth at runtime:
//   * Node version   -> root mise.toml [tools] node   (the pin every workspace
//                       package.json engines.node must match).
//   * npm version    -> root package.json engines.npm (mise does not pin npm,
//                       so the root package.json is the reference the others
//                       must match).
//   * epubcheck line -> the publishable package versions themselves (their
//                       `<epubcheck>-build<n>` shape must share one prefix).
//
// It verifies, across the root package.json AND every packages/* package.json:
//   (a) engines, by package kind:
//       - PRIVATE packages (root monorepo + demo) carry the exact dev pins:
//         engines.node equals the mise node, engines.npm equals root engines.npm;
//       - PUBLISHED packages (epubcheck-standalone, epubcheck-standalone-cli) declare a
//         consumer-friendly floor range for engines.node (">=..."), pin NO npm,
//         and all agree on the same node range. No literal range lives here.
//   (b) every dependency / devDependency version is an EXACT pin -- no range
//       operators or wildcards (^ ~ >= <= > < x *) -- except a workspace-internal
//       dependency, which a PUBLISHED package must pin to that package's exact
//       version and a PRIVATE package may leave as the "*" workspace link;
//   (c) the two publishable packages (epubcheck-standalone and epubcheck-standalone-cli)
//       carry versions that share the same `<epubcheck>` prefix before "-build".
//
// Exits non-zero with a listed set of violations; exits 0 quietly when clean.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const violations: string[] = [];
const fail = (msg: string): void => {
  violations.push(msg);
};

type Json = Record<string, unknown>;

const readJson = (path: string): Json =>
  JSON.parse(readFileSync(path, "utf8")) as Json;

// --- Source of truth: Node version from mise.toml [tools] node --------------
// Simple line parsing (no toml dependency): find the `node = "..."` assignment
// inside the [tools] table.
const parseMiseNode = (tomlPath: string): string => {
  const text = readFileSync(tomlPath, "utf8");
  const lines = text.split(/\r?\n/);
  let inTools = false;
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, "").trim();
    if (line.startsWith("[")) {
      inTools = line === "[tools]";
      continue;
    }
    if (!inTools) continue;
    const m = line.match(/^node\s*=\s*"([^"]+)"\s*$/);
    if (m) return m[1];
  }
  throw new Error("Could not find `node = \"...\"` under [tools] in mise.toml");
};

// --- Enumerate every workspace package.json (root + workspaces globs) --------
const enumeratePackageJsonPaths = (rootPkg: Json): string[] => {
  const paths = [join(repoRoot, "package.json")];
  const workspaces = Array.isArray(rootPkg.workspaces)
    ? (rootPkg.workspaces as string[])
    : [];
  for (const entry of workspaces) {
    if (entry.endsWith("/*")) {
      const parent = join(repoRoot, entry.slice(0, -2));
      if (!existsSync(parent)) continue;
      for (const name of readdirSync(parent, { withFileTypes: true })) {
        if (!name.isDirectory()) continue;
        const pkg = join(parent, name.name, "package.json");
        if (existsSync(pkg)) paths.push(pkg);
      }
    } else {
      const pkg = join(repoRoot, entry, "package.json");
      if (existsSync(pkg)) paths.push(pkg);
    }
  }
  return paths;
};

// --- Exact-pin predicate -----------------------------------------------------
// A dependency spec is an exact pin when it names one concrete version with no
// range operator or wildcard. Reject the range/wildcard tokens the standing
// rules forbid.
const isExactPin = (spec: string): boolean => {
  if (/[\^~*<>=]/.test(spec)) return false; // ^ ~ * < > = (covers >=, <=)
  if (/\|\|/.test(spec)) return false; // "1 || 2"
  if (/\s/.test(spec)) return false; // "1 - 2" range, " - " hyphen range
  if (/(^|[.])[xX](?=$|[.])/.test(spec)) return false; // 1.x / 1.X wildcard
  return true;
};

const rootPkg = readJson(join(repoRoot, "package.json"));
const pkgPaths = enumeratePackageJsonPaths(rootPkg);

// Workspace-internal package names -> their own versions. A published package's
// internal dependency must pin this exact version; a private package may leave
// the "*" workspace link.
const internalNames = new Set<string>();
const internalVersions = new Map<string, string>();
for (const p of pkgPaths) {
  const pkg = readJson(p);
  if (typeof pkg.name === "string") {
    internalNames.add(pkg.name);
    if (typeof pkg.version === "string") {
      internalVersions.set(pkg.name, pkg.version);
    }
  }
}

// Sources of truth for the PRIVATE dev pins (node from mise, npm from root).
const nodeSot = parseMiseNode(join(repoRoot, "mise.toml"));
const rootEngines = (rootPkg.engines ?? {}) as Record<string, string>;
const npmSot = rootEngines.npm;
if (typeof npmSot !== "string" || npmSot.length === 0) {
  fail(
    "root package.json engines.npm is missing -- it is the source of truth every private workspace must match",
  );
}

const rel = (p: string): string => p.slice(repoRoot.length + 1) || "package.json";

// --- (a) engines + (b) exact pins, per package -------------------------------
// Collected so we can assert every published package agrees on one node floor.
const publishedNodeRanges = new Map<string, string>();
for (const p of pkgPaths) {
  const pkg = readJson(p);
  const where = rel(p);
  const engines = (pkg.engines ?? {}) as Record<string, unknown>;
  const isPrivate = pkg.private === true;

  if (isPrivate) {
    // Private (root + demo): exact dev pins.
    if (engines.node !== nodeSot) {
      fail(
        `${where}: engines.node is ${JSON.stringify(engines.node)}, must equal mise.toml node "${nodeSot}" (private dev pin)`,
      );
    }
    if (typeof npmSot === "string" && engines.npm !== npmSot) {
      fail(
        `${where}: engines.npm is ${JSON.stringify(engines.npm)}, must equal root engines.npm "${npmSot}" (private dev pin)`,
      );
    }
  } else {
    // Published: a ">=" floor on node, and NO npm entry.
    if (typeof engines.node !== "string" || !/^>=\s*\d/.test(engines.node)) {
      fail(
        `${where}: engines.node is ${JSON.stringify(engines.node)}, published packages must declare a floor range like ">=24"`,
      );
    } else {
      publishedNodeRanges.set(where, engines.node);
    }
    if (engines.npm !== undefined) {
      fail(
        `${where}: engines.npm is ${JSON.stringify(engines.npm)}, published packages must NOT pin npm (dev-only concern)`,
      );
    }
  }

  for (const field of ["dependencies", "devDependencies"] as const) {
    const deps = (pkg[field] ?? {}) as Record<string, string>;
    for (const [name, spec] of Object.entries(deps)) {
      if (internalNames.has(name)) {
        const wantVersion = internalVersions.get(name);
        if (isPrivate) {
          // Workspace link ("*") or the exact version both fine for private.
          if (spec !== "*" && spec !== wantVersion) {
            fail(
              `${where}: ${field}["${name}"] = "${spec}" -- a private package may use "*" or the exact workspace version "${wantVersion}"`,
            );
          }
        } else if (spec !== wantVersion) {
          // Published packages must never float their internal dependency.
          fail(
            `${where}: ${field}["${name}"] = "${spec}", published packages must pin the workspace-internal "${name}" to its exact version "${wantVersion}"`,
          );
        }
        continue;
      }
      if (!isExactPin(spec)) {
        fail(
          `${where}: ${field}["${name}"] = "${spec}" is not an exact pin`,
        );
      }
    }
  }
}

// Every published package must agree on the same engines.node floor.
if (new Set(publishedNodeRanges.values()).size > 1) {
  const detail = [...publishedNodeRanges.entries()]
    .map(([n, v]) => `${n} -> ${v}`)
    .join(", ");
  fail(`published packages disagree on engines.node: ${detail}`);
}

// --- (c) publishable packages share one <epubcheck> prefix -------------------
const prefixBeforeBuild = (version: string): string =>
  version.split("-build")[0];

const publishable = ["epubcheck-standalone", "epubcheck-standalone-cli"];
const prefixes = new Map<string, string>();
for (const p of pkgPaths) {
  const pkg = readJson(p);
  const name = pkg.name;
  if (typeof name === "string" && publishable.includes(name)) {
    const version = pkg.version;
    if (typeof version !== "string") {
      fail(`${rel(p)}: publishable package "${name}" has no version`);
      continue;
    }
    prefixes.set(name, prefixBeforeBuild(version));
  }
}
const distinct = new Set(prefixes.values());
if (prefixes.size === publishable.length && distinct.size > 1) {
  const detail = [...prefixes.entries()]
    .map(([n, v]) => `${n} -> ${v}`)
    .join(", ");
  fail(
    `publishable package epubcheck versions disagree before "-build": ${detail}`,
  );
}

// --- Report ------------------------------------------------------------------
if (violations.length > 0) {
  console.error(`check:versions found ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}
process.exit(0);
