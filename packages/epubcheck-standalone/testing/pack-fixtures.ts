#!/usr/bin/env node
// Zip every EPUB OCF root (any directory containing a `mimetype` file) found
// under the epubcheck v5.3.0 test resources into a real .epub file:
//   - `mimetype` entry FIRST and STORED (uncompressed, -X0)
//   - everything else deflated
// Output .epub files land in test/corpus/epubcheck-expanded/ with a flattened,
// collision-safe name derived from the fixture's path.
//
// Usage: node pack-fixtures.ts
import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));
// Requires the epubcheck source tree (its src/test/resources). Fetch it from
// https://github.com/w3c/epubcheck/archive/refs/tags/v5.3.0.tar.gz into
// build/epubcheck-src/ to regenerate the fixtures corpus.
const RES = join(REPO, 'build/epubcheck-src/src/test/resources');
const OUT = join(REPO, 'test/corpus/epubcheck-expanded');

if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// Recursively find directories that directly contain a `mimetype` file.
const roots: string[] = [];
function walk(dir: string): void {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  const hasMime = entries.some((e) => e.isFile() && e.name === 'mimetype');
  if (hasMime) { roots.push(dir); return; } // OCF root: do not descend further
  for (const e of entries) if (e.isDirectory()) walk(join(dir, e.name));
}
walk(RES);
roots.sort();

const manifest = [];
let ok = 0, fail = 0;
for (const root of roots) {
  const rel = relative(RES, root);
  const name = rel.replace(/[\/\\]/g, '__').replace(/[^A-Za-z0-9_.-]/g, '_');
  const out = join(OUT, name + '.epub');
  try {
    if (existsSync(out)) rmSync(out);
    // mimetype first, stored
    execFileSync('/usr/bin/zip', ['-X', '-0', '-q', out, 'mimetype'], { cwd: root });
    // everything else, deflated; -r recurse, -X no extra attrs, -9 max
    execFileSync('/usr/bin/zip', ['-X', '-r', '-9', '-q', out, '.', '-x', 'mimetype'], { cwd: root });
    manifest.push({ name: name + '.epub', source: rel });
    ok++;
  } catch (e) {
    console.error('FAILED to pack', rel, e instanceof Error ? e.message : String(e));
    fail++;
  }
}
console.log(JSON.stringify({ totalRoots: roots.length, packed: ok, failed: fail }, null, 2));
console.log('manifest entries:', manifest.length);
// Write manifest
const { writeFileSync } = await import('node:fs');
writeFileSync(join(OUT, '_manifest.json'), JSON.stringify(manifest, null, 2));
