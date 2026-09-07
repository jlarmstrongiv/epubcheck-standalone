#!/usr/bin/env node
// Upstream release check for the auto-update pipeline. Zero-arg by default:
//   * reads the currently-baked EPUBCHECK_VERSION (mise.toml [env]),
//   * asks the GitHub API for w3c/epubcheck's latest release,
//   * decides whether that release is NEWER and past the 14-day supply-chain
//     cooldown (same policy as the rest of the repo: mise minimum_release_age,
//     renovate minimumReleaseAge), and
//   * emits GitHub Actions outputs (has_update, eligible, ...) plus a readable
//     log, so the workflow can branch without any extra parsing.
//
// It NEVER fails the job on "nothing to do": exit code is 0 for up-to-date,
// not-yet-eligible, and eligible-update alike. It exits non-zero only on a hard
// error (could not read the current version, could not reach the API without a
// mock). The workflow reads the outputs to decide what to do.
//
// Deterministic + offline-testable via env overrides:
//   CURRENT_VERSION   force the baseline (default: parse mise.toml)
//   RELEASE_JSON      a GitHub "releases/latest" JSON string (skip the API call)
//   RELEASE_JSON_FILE path to that JSON on disk (skip the API call)
//   NOW               ISO date used as "today" for the cooldown math (default: real now)
//   COOLDOWN_DAYS     cooldown window (default: 14)
//   GITHUB_TOKEN      optional; raises the API rate limit
import { readFileSync, existsSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..", ".."); // upstream-sweep -> testing -> pkg -> packages -> repo root
const COOLDOWN_DAYS = Number(process.env.COOLDOWN_DAYS || 14);

function fail(msg: string): never {
  console.error(`[check-version] ERROR: ${msg}`);
  process.exit(1);
}

// --- current (baked) version -----------------------------------------------
function currentVersion(): string {
  if (process.env.CURRENT_VERSION) return process.env.CURRENT_VERSION;
  const misePath = join(REPO_ROOT, "mise.toml");
  if (!existsSync(misePath)) fail(`mise.toml not found at ${misePath}`);
  const txt = readFileSync(misePath, "utf8");
  const m = txt.match(/^\s*EPUBCHECK_VERSION\s*=\s*"([^"]+)"/m);
  if (!m) fail("EPUBCHECK_VERSION not found in mise.toml [env]");
  return m[1];
}

// --- latest upstream release ------------------------------------------------
interface Release {
  tag_name: string;
  name?: string;
  published_at: string;
  draft?: boolean;
  prerelease?: boolean;
}
async function latestRelease(): Promise<Release> {
  if (process.env.RELEASE_JSON) return JSON.parse(process.env.RELEASE_JSON) as Release;
  if (process.env.RELEASE_JSON_FILE)
    return JSON.parse(readFileSync(process.env.RELEASE_JSON_FILE, "utf8")) as Release;
  const url = "https://api.github.com/repos/w3c/epubcheck/releases/latest";
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "epubcheck-standalone-auto-update",
  };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(url, { headers });
  if (!res.ok) fail(`GitHub API ${res.status} ${res.statusText}`);
  return (await res.json()) as Release;
}

// --- tiny semver compare (x.y.z) -------------------------------------------
function parseVer(v: string): number[] {
  const m = v.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) fail(`unparseable version: ${v}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}
function cmp(a: string, b: string): number {
  const pa = parseVer(a),
    pb = parseVer(b);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

// --- emit GitHub Actions outputs -------------------------------------------
function setOutput(k: string, v: string | number | boolean): void {
  const line = `${k}=${v}`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, line + "\n");
  console.log(`[output] ${line}`);
}

// --- decide -----------------------------------------------------------------
const current = currentVersion();
const rel = await latestRelease();
const latest = rel.tag_name.replace(/^v/, "");
const now = process.env.NOW ? new Date(process.env.NOW) : new Date();
const published = new Date(rel.published_at);
const ageDays = (now.getTime() - published.getTime()) / 86400000;

console.error(
  `[check-version] current=${current} latest=${latest} (tag ${rel.tag_name}, ` +
    `published ${rel.published_at}, age ${ageDays.toFixed(1)}d, cooldown ${COOLDOWN_DAYS}d)`,
);

let hasUpdate = false;
let eligible = false;
let reason: string;

if (rel.draft || rel.prerelease) {
  reason = `latest release is a ${rel.draft ? "draft" : "prerelease"}; ignoring`;
} else if (cmp(latest, current) <= 0) {
  reason =
    cmp(latest, current) === 0
      ? `already on the latest epubcheck (${current})`
      : `latest release (${latest}) is not newer than the baked version (${current})`;
} else {
  hasUpdate = true;
  if (ageDays >= COOLDOWN_DAYS) {
    eligible = true;
    reason = `new eligible epubcheck ${latest} (${ageDays.toFixed(1)}d old, past ${COOLDOWN_DAYS}d cooldown)`;
  } else {
    reason = `epubcheck ${latest} is new but only ${ageDays.toFixed(1)}d old; waiting for the ${COOLDOWN_DAYS}d cooldown`;
  }
}

console.error(`[check-version] decision: has_update=${hasUpdate} eligible=${eligible} -- ${reason}`);

setOutput("has_update", hasUpdate);
setOutput("eligible", eligible);
setOutput("current", current);
setOutput("latest", latest);
setOutput("latest_tag", rel.tag_name);
setOutput("published_at", rel.published_at);
setOutput("age_days", ageDays.toFixed(1));
setOutput("cooldown_days", COOLDOWN_DAYS);
setOutput("new_version_label", `${latest}-build1`);
setOutput("branch", `auto/epubcheck-${latest}`);
setOutput("reason", reason);

process.exit(0);
