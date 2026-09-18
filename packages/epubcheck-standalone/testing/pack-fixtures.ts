#!/usr/bin/env node
// Import EPUBCheck's complete fixture corpus from the exact GitHub tag selected
// by EPUBCHECK_VERSION. Expanded OCF roots are packed as deterministic EPUBs;
// fixtures that are already EPUB/ZIP files are copied byte-for-byte so malformed
// archive test cases retain their upstream behavior.
//
// By default this clones https://github.com/w3c/epubcheck.git at
// `v${EPUBCHECK_VERSION}`. For an already-cloned, clean checkout of that exact
// tag, set EPUBCHECK_SOURCE_DIR to its repository root.
//
// Usage:
//   mise exec -- node testing/pack-fixtures.ts
//   EPUBCHECK_SOURCE_DIR=/path/to/epubcheck mise exec -- node testing/pack-fixtures.ts
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CORPUS_ROOT = join(PACKAGE_ROOT, "test", "corpus");
const EXPANDED_OUT = join(CORPUS_ROOT, "epubcheck-expanded");
const PREZIPPED_OUT = join(CORPUS_ROOT, "epubcheck-prezipped");
const UPSTREAM_URL = "https://github.com/w3c/epubcheck.git";
const FIXED_ZIP_TIME = new Date("2000-01-01T00:00:00.000Z");

const version = process.env.EPUBCHECK_VERSION?.trim();
if (!version || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(
    "EPUBCHECK_VERSION must be an exact release version such as 5.4.0",
  );
}
const tag = `v${version}`;

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
  });
  return stdout.trim();
}

async function verifyCheckout(sourceDir: string): Promise<string> {
  const checkout = await git(sourceDir, "rev-parse", "HEAD");
  const taggedCommit = await git(
    sourceDir,
    "rev-parse",
    "--verify",
    `refs/tags/${tag}^{commit}`,
  );
  if (checkout !== taggedCommit) {
    throw new Error(
      `${sourceDir} is at ${checkout}, not exact tag ${tag} (${taggedCommit})`,
    );
  }
  const changes = await git(sourceDir, "status", "--porcelain");
  if (changes) {
    throw new Error(
      `${sourceDir} has local changes; corpus imports require a clean ${tag} checkout`,
    );
  }
  const resources = join(sourceDir, "src", "test", "resources");
  if (
    !(await pathExists(resources)) ||
    !(await stat(resources)).isDirectory()
  ) {
    throw new Error(`EPUBCheck test resources not found at ${resources}`);
  }
  return checkout;
}

async function acquireSource(): Promise<{
  sourceDir: string;
  cleanup?: string;
  commit: string;
}> {
  const supplied = process.env.EPUBCHECK_SOURCE_DIR?.trim();
  if (supplied) {
    const sourceDir = resolve(supplied);
    return { sourceDir, commit: await verifyCheckout(sourceDir) };
  }

  const cleanup = await mkdtemp(join(tmpdir(), `epubcheck-${version}-`));
  const sourceDir = join(cleanup, "source");
  try {
    await execFileAsync("git", [
      "clone",
      "--quiet",
      "--depth",
      "1",
      "--branch",
      tag,
      UPSTREAM_URL,
      sourceDir,
    ]);
    return {
      sourceDir,
      cleanup,
      commit: await verifyCheckout(sourceDir),
    };
  } catch (error) {
    await rm(cleanup, { recursive: true, force: true });
    throw error;
  }
}

async function walkFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walkFiles(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files.sort(compareStrings);
}

async function findExpandedRoots(resources: string): Promise<string[]> {
  const roots: string[] = [];
  async function visit(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    if (entries.some((entry) => entry.isFile() && entry.name === "mimetype")) {
      roots.push(dir);
      return;
    }
    for (const entry of entries.sort((a, b) =>
      compareStrings(a.name, b.name),
    )) {
      if (entry.isDirectory()) await visit(join(dir, entry.name));
    }
  }
  await visit(resources);
  return roots.sort(compareStrings);
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

function flattenedName(source: string, separator: string): string {
  return source
    .split("/")
    .join(separator)
    .replace(/[^A-Za-z0-9_.-]/g, "_");
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function normalizeTimes(dir: string): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await normalizeTimes(path);
    await utimes(path, FIXED_ZIP_TIME, FIXED_ZIP_TIME);
  }
  await utimes(dir, FIXED_ZIP_TIME, FIXED_ZIP_TIME);
}

async function collectZipEntries(
  dir: string,
  staging: string,
): Promise<string[]> {
  const entries: string[] = [];
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort(
    (a, b) => compareStrings(a.name, b.name),
  )) {
    if (entry.name === "mimetype" && dir === staging) continue;
    const path = join(dir, entry.name);
    const rel = toPosix(relative(staging, path));
    if (entry.isDirectory()) {
      entries.push(`${rel}/`, ...(await collectZipEntries(path, staging)));
    } else if (entry.isFile()) {
      entries.push(rel);
    }
  }
  return entries;
}

async function zipExpandedRoot(
  root: string,
  out: string,
  workRoot: string,
): Promise<void> {
  const staging = join(workRoot, basename(out, ".epub"));
  await cp(root, staging, { recursive: true, preserveTimestamps: false });
  await normalizeTimes(staging);

  const zipOptions = {
    cwd: staging,
    env: { ...process.env, TZ: "UTC" },
  };
  await execFileAsync("zip", ["-X", "-0", "-q", out, "mimetype"], zipOptions);

  const entries = await collectZipEntries(staging, staging);
  if (entries.length) {
    await execFileAsync("zip", ["-X", "-9", "-q", out, ...entries], zipOptions);
  }
}

type ManifestEntry = { name: string; source: string; sha256: string };

async function writeManifest(
  outDir: string,
  commit: string,
  fixtures: ManifestEntry[],
): Promise<void> {
  await writeFile(
    join(outDir, "_manifest.json"),
    `${JSON.stringify({ upstream: "w3c/epubcheck", version, tag, commit, fixtures }, null, 2)}\n`,
  );
}

function assertUnique(
  entries: Array<{ name: string; source: string }>,
  group: string,
): void {
  const seen = new Map<string, string>();
  for (const entry of entries) {
    const previous = seen.get(entry.name);
    if (previous) {
      throw new Error(
        `${group} filename collision: ${previous} and ${entry.source} both map to ${entry.name}`,
      );
    }
    seen.set(entry.name, entry.source);
  }
}

type DirectoryReplacement = {
  staged: string;
  destination: string;
  backup: string;
  movedOld: boolean;
  installed: boolean;
};

async function replaceDirectories(
  replacements: Array<{ staged: string; destination: string }>,
): Promise<void> {
  const nonce = `${process.pid}-${Date.now()}`;
  const states: DirectoryReplacement[] = replacements.map(
    ({ staged, destination }) => ({
      staged,
      destination,
      backup: join(
        dirname(destination),
        `.${basename(destination)}.backup-${nonce}`,
      ),
      movedOld: false,
      installed: false,
    }),
  );

  try {
    for (const state of states) {
      if (await pathExists(state.destination)) {
        await rename(state.destination, state.backup);
        state.movedOld = true;
      }
      await rename(state.staged, state.destination);
      state.installed = true;
    }
  } catch (error) {
    for (const state of states.reverse()) {
      if (state.installed) {
        await rm(state.destination, { recursive: true, force: true });
      }
      if (state.movedOld) await rename(state.backup, state.destination);
    }
    throw error;
  }

  await Promise.all(
    states.map(({ backup }) => rm(backup, { recursive: true, force: true })),
  );
}

const source = await acquireSource();
const resources = join(source.sourceDir, "src", "test", "resources");
await mkdir(join(PACKAGE_ROOT, "build"), { recursive: true });
const importRoot = await mkdtemp(
  join(PACKAGE_ROOT, "build", `corpus-import-${version}-`),
);
const expandedStage = join(importRoot, "epubcheck-expanded");
const prezippedStage = join(importRoot, "epubcheck-prezipped");
const zipWork = join(importRoot, "zip-work");
await Promise.all([
  mkdir(expandedStage),
  mkdir(prezippedStage),
  mkdir(zipWork),
]);

try {
  const expanded = (await findExpandedRoots(resources)).map((root) => {
    const sourcePath = toPosix(relative(resources, root));
    return {
      root,
      source: sourcePath,
      name: `${flattenedName(sourcePath, "__")}.epub`,
    };
  });
  assertUnique(expanded, "expanded fixture");

  const requiredImageFixtures = [
    "epub3/03-resources/files/resources-cmt-image-avif-valid",
    "epub3/03-resources/files/resources-cmt-image-jxl-valid",
  ];
  for (const required of requiredImageFixtures) {
    if (!expanded.some((entry) => entry.source === required)) {
      throw new Error(`${tag} is missing required image fixture ${required}`);
    }
  }

  const expandedManifest: ManifestEntry[] = [];
  for (const fixture of expanded) {
    const out = join(expandedStage, fixture.name);
    await zipExpandedRoot(fixture.root, out, zipWork);
    expandedManifest.push({
      name: fixture.name,
      source: fixture.source,
      sha256: await sha256(out),
    });
  }
  await writeManifest(expandedStage, source.commit, expandedManifest);

  const prezipped = (await walkFiles(resources))
    // Preserve upstream's deliberately mixed-case extension fixtures as source
    // inputs only. The parity corpus follows EPUBCheck's normal `.epub` inputs,
    // matching the existing importer and the corpus discovery code.
    .filter((path) => path.endsWith(".epub"))
    .map((path) => {
      const sourcePath = toPosix(relative(resources, path));
      return { path, source: sourcePath, name: flattenedName(sourcePath, "_") };
    });
  assertUnique(prezipped, "pre-zipped fixture");

  const prezippedManifest: ManifestEntry[] = [];
  for (const fixture of prezipped) {
    const out = join(prezippedStage, fixture.name);
    await copyFile(fixture.path, out);
    prezippedManifest.push({
      name: fixture.name,
      source: fixture.source,
      sha256: await sha256(out),
    });
  }
  await writeManifest(prezippedStage, source.commit, prezippedManifest);

  await replaceDirectories([
    { staged: expandedStage, destination: EXPANDED_OUT },
    { staged: prezippedStage, destination: PREZIPPED_OUT },
  ]);

  console.log(
    JSON.stringify(
      {
        version,
        tag,
        commit: source.commit,
        expanded: expandedManifest.length,
        prezipped: prezippedManifest.length,
        total: expandedManifest.length + prezippedManifest.length,
      },
      null,
      2,
    ),
  );
} finally {
  await rm(importRoot, { recursive: true, force: true });
  if (source.cleanup) {
    await rm(source.cleanup, { recursive: true, force: true });
  }
}
