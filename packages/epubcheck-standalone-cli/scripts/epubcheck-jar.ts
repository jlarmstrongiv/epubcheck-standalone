// Shared locator for the official epubcheck jar and the Java binary used to run
// it. The jar lives inside the sibling library package, fetched by its
// `build:deps` step (packages/epubcheck-standalone/scripts/fetch-deps.ts) into
// build/epubcheck-<version>/epubcheck.jar. NOTHING here hardcodes a version:
// the path is derived from the EPUBCHECK_VERSION env var (set by the repo-root
// mise.toml) and, failing that, by globbing the build directory. This is used
// by the golden generator, the live jar-parity suite, and the CLI-data
// generator so the jar is located ONE way everywhere.

import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// scripts/ -> package root -> ../epubcheck-standalone/build
const buildDir = join(here, "..", "..", "epubcheck-standalone", "build");

/** The `java` binary to run the jar with (mise provisions it on PATH). */
export const JAVA = process.env["JAVA"] ?? "java";

/**
 * Absolute path to epubcheck.jar. Resolution order:
 *   1. EPUBCHECK_JAR env var (an explicit override), if set.
 *   2. build/epubcheck-<EPUBCHECK_VERSION>/epubcheck.jar, if that env is set
 *      and the file exists.
 *   3. glob build/epubcheck-<any-version>/epubcheck.jar (first match).
 * If none exist, returns the best-guess path so callers can print a useful
 * "not found at <path>" error. Never throws.
 */
export function resolveJarPath(): string {
  const override = process.env["EPUBCHECK_JAR"];
  if (override) return override;

  const version = process.env["EPUBCHECK_VERSION"];
  if (version) {
    const byEnv = join(buildDir, `epubcheck-${version}`, "epubcheck.jar");
    if (existsSync(byEnv)) return byEnv;
  }

  if (existsSync(buildDir)) {
    for (const name of readdirSync(buildDir)) {
      if (!/^epubcheck-\d/.test(name)) continue;
      const candidate = join(buildDir, name, "epubcheck.jar");
      if (existsSync(candidate)) return candidate;
    }
  }

  return version
    ? join(buildDir, `epubcheck-${version}`, "epubcheck.jar")
    : join(buildDir, "epubcheck-<version>", "epubcheck.jar");
}
