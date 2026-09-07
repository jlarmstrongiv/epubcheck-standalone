#!/usr/bin/env node
// Node harness for parity testing: validate ONE .epub through the current
// in-process library (the `fs` range source + `validate`) and emit epubcheck's
// console output the way the native binary does, so testing/parity-run.ts can
// normalize and diff the two side by side. Exits with epubcheck's exit code.
//
// This replaces the retired range-read wrapper contract (__epubSize/__epubName/
// __epubRead + dist/epubcheck-io.js): the library now reads the source and runs
// the engine in-process, exposing the run's captured console text and exit code
// on the EpubCheckResult.
//
// Usage:  node run-epubcheck-opt.ts <path-to-epub>
import { resolve } from 'node:path';
import { validate } from '../dist/index.js';
import { fs } from '../dist/plugins.js';

const file = process.argv[2];
if (!file) {
  console.error('usage: node run-epubcheck-opt.ts <path-to-epub>');
  process.exit(64);
}

// `fs` reads the file range-by-range; `validate` runs the engine on this thread
// and disposes the source when the run ends.
const result = await validate(await fs(resolve(file)));

// Native epubcheck prints its messages to stderr, and parity-run.ts normalizes
// the harness's stderr. The library captures stdout and stderr separately, so
// funnel both to stderr here to guarantee every message line is seen regardless
// of which stream the engine used.
if (result.stdout) {
  process.stderr.write(result.stdout.endsWith('\n') ? result.stdout : result.stdout + '\n');
}
if (result.stderr) process.stderr.write(result.stderr);
process.exit(result.exitCode ?? 1);
