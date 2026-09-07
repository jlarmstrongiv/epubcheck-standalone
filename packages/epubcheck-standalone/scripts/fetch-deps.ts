#!/usr/bin/env node
// Fetch the build INPUTS into ./build (gitignored). The TOOLCHAIN (Node, the
// Temurin JDK, Gradle) is provisioned by `mise install`, not here -- see
// mise.toml and agent-docs/BUILDING.md.
//
//   node scripts/fetch-deps.ts       (or: npm run build:deps)
//
// Fetches, for the versions pinned in mise.toml ([env]):
//   - epubcheck release (epubcheck.jar + lib/*)  -> build/epubcheck-<ver>/
//   - JZlib jar                                   -> build/jzlib-<ver>.jar
// and applies the Jing ServiceLoader patch to the downloaded jing jar.

import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import type { SpawnSyncOptions } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const env = (k: string, d: string): string => process.env[k] || d;

// EPUBCHECK_VERSION is the build-input version pin. It is supplied by mise
// (mise.toml [env]); there is deliberately NO hardcoded fallback, so running
// this script outside the provisioned toolchain fails loudly instead of
// silently fetching some default epubcheck release.
const EPUBCHECK_VERSION = process.env.EPUBCHECK_VERSION;
if (!EPUBCHECK_VERSION) {
  console.error(
    'EPUBCHECK_VERSION is not set. Run this via mise so the pinned build-input\n' +
      'version is in the environment, e.g. `mise run build:deps` or\n' +
      '`mise exec -- npm run build:deps`.',
  );
  process.exit(1);
}
const JZLIB_VERSION = env('JZLIB_VERSION', '1.1.3');
const JZLIB_SHA256 = '89b1360f407381bf61fde411019d8cbd009ebb10cff715f3669017a031027560';

const build = join(root, 'build');
mkdirSync(build, { recursive: true });

function sh(cmd: string, args: string[], opts: SpawnSyncOptions = {}): void {
  console.log(`$ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.status !== 0) throw new Error(`${cmd} exited ${r.status}`);
}

async function download(url: string, dest: string): Promise<void> {
  if (existsSync(dest)) { console.log(`= cached ${dest}`); return; }
  console.log(`down ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  if (!res.body) throw new Error(`GET ${url} -> empty response body`);
  mkdirSync(dirname(dest), { recursive: true });
  // fetch's res.body is typed as the DOM ReadableStream (the WebWorker lib is in
  // scope for this config), which is structurally distinct from the node
  // stream/web ReadableStream that Readable.fromWeb expects. They are the same
  // object at runtime; bridge the type gap with a single cast.
  await pipeline(
    Readable.fromWeb(res.body as unknown as Parameters<typeof Readable.fromWeb>[0]),
    createWriteStream(dest),
  );
}

async function sha256(file: string): Promise<string> {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

// --- 1. epubcheck release ----------------------------------------------------
async function fetchEpubcheck() {
  const dir = join(build, `epubcheck-${EPUBCHECK_VERSION}`);
  if (existsSync(join(dir, 'epubcheck.jar'))) { console.log('= epubcheck present'); return; }
  const zip = join(build, `epubcheck-${EPUBCHECK_VERSION}.zip`);
  await download(
    `https://github.com/w3c/epubcheck/releases/download/v${EPUBCHECK_VERSION}/epubcheck-${EPUBCHECK_VERSION}.zip`,
    zip,
  );
  // Extracts to build/epubcheck-<ver>/.
  sh('unzip', ['-q', '-o', zip, '-d', build]);
  console.log(`ok epubcheck ${EPUBCHECK_VERSION}`);
}

// --- 1b. epubcheck SOURCES jar -----------------------------------------------
// The release zip ships only compiled jars, not source. The drift guard
// (scripts/check-shadow-drift.ts, run by build.ts) needs the PRISTINE upstream
// DefaultReportImpl.java to compare our shadow against, so fetch the matching
// sources jar from Maven Central (the canonical, version-pinned artifact).
async function fetchEpubcheckSources() {
  const jar = join(build, `epubcheck-${EPUBCHECK_VERSION}-sources.jar`);
  await download(
    `https://repo1.maven.org/maven2/org/w3c/epubcheck/${EPUBCHECK_VERSION}/epubcheck-${EPUBCHECK_VERSION}-sources.jar`,
    jar,
  );
  console.log(`ok epubcheck ${EPUBCHECK_VERSION} sources`);
}

// --- 2. JZlib ----------------------------------------------------------------
async function fetchJzlib() {
  const jar = join(build, `jzlib-${JZLIB_VERSION}.jar`);
  await download(
    `https://repo1.maven.org/maven2/com/jcraft/jzlib/${JZLIB_VERSION}/jzlib-${JZLIB_VERSION}.jar`,
    jar,
  );
  const got = await sha256(jar);
  if (JZLIB_VERSION === '1.1.3' && got !== JZLIB_SHA256) {
    throw new Error(`JZlib checksum mismatch: got ${got}`);
  }
  console.log(`ok jzlib ${JZLIB_VERSION} (sha256 ok)`);
}

// --- 3. Apply the Jing ServiceLoader patch -----------------------------------
function patchJing() {
  const jar = join(build, `epubcheck-${EPUBCHECK_VERSION}`, 'lib', 'jing-20181222.jar');
  if (!existsSync(jar)) throw new Error(`jing jar not found at ${jar} (fetch epubcheck first)`);
  const rel = 'META-INF/services/com.thaiopensource.validate.SchemaReaderFactory';
  // `zip` updates the entry in place; run from the patches dir so the archived
  // path is exactly META-INF/services/... (idempotent -- re-running is safe).
  sh('zip', [jar, rel], { cwd: join(build, 'patches', 'jing') });
  console.log('ok patched jing ServiceLoader file');
}

// These three artifact downloads are independent -- each fetches a different
// upstream artifact to a distinct path (the epubcheck release zip, the sources
// jar, the jzlib jar) with no data dependency between them -- so overlap them.
// A fixed fan-out of exactly three, so a plain Promise.all is correct (no
// concurrency cap needed). If any rejects, Promise.all rejects and the error
// propagates just as the sequential awaits did.
await Promise.all([fetchEpubcheck(), fetchEpubcheckSources(), fetchJzlib()]);
// patchJing() must run AFTER fetchEpubcheck() -- it patches the jing jar that
// fetchEpubcheck() extracted from the release zip -- so it stays after the
// Promise.all resolves.
patchJing();

console.log('\nDone. Build inputs in ./build. Tools come from `mise install`.');
console.log('Next: npm run build');
