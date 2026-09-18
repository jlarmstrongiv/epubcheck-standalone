#!/usr/bin/env node
// Clean and rebuild the generated TypeScript half of dist/ while preserving the
// separately-built TeaVM engine asset.

import { existsSync, readdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, 'dist');

if (existsSync(dist)) {
  for (const name of readdirSync(dist)) {
    if (name === 'epubcheck-engine.js') continue;
    rmSync(join(dist, name), { recursive: true, force: true });
  }
}

const result = spawnSync('rolldown', ['-c', 'rolldown.config.ts'], {
  cwd: root,
  stdio: 'inherit',
});
if (result.status !== 0) process.exit(result.status || 1);
