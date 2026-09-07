// epubcheck-standalone -- Node engine loader (internal).
//
// Obtains the engine factory (`createEngine`) from the built engine MODULE and
// binds the isomorphic driver (engine-run.ts) with Node's one-macrotask yield
// (`setImmediate` -- the yield the wasm-vips reuse pattern proved for V8; a
// promisified setTimeout(0) is NOT equivalent in Node). The engine is a SEPARATE
// ~21 MB ES module (teavm/fix-generated.ts emits it wrapping the TeaVM UMD body
// in `export function createEngine()`); it is loaded ONCE with a dynamic
// `import()` -- a real module load, no eval / new Function anywhere -- and each
// run CALLS createEngine() for a fresh runtime. Everything else about a run is
// platform-neutral and lives in engine-run.ts / run-core.ts.

import { access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setImmediate as yieldImmediate } from 'node:timers/promises';
import { driveEngine } from './engine-run.js';
import type { EngineRun, EngineResult, EngineFactory } from './engine-run.js';

// dist/engine-node.js sits next to the shipped engine; the dev fallback points
// at the gradle build output (build/ is gitignored, so a published package must
// ship dist/epubcheck-engine.js, but a source checkout can run the suites off the
// freshly generated engine without a copy step).
const here = dirname(fileURLToPath(import.meta.url));
const ENGINE_CANDIDATES = [
  join(here, 'epubcheck-engine.js'),
  join(here, '..', 'teavm', 'build', 'generated', 'teavm', 'js', 'epubcheck.js'),
];

// The imported factory is cached: importing the ~21 MB module is the expensive
// part, so we do it once; CALLING createEngine() rebuilds the runtime per run.
let factoryPromise: Promise<EngineFactory> | null = null;

async function importFactory(): Promise<EngineFactory> {
  for (const candidate of ENGINE_CANDIDATES) {
    // Async presence probe (fs.promises.access) -- no synchronous fs on the
    // engine-load path; a missing/unreadable candidate is skipped like the old
    // existsSync check did (access rejects -> continue to the next candidate).
    try {
      await access(candidate);
    } catch {
      continue;
    }
    // A real ES-module load (the engine file is `export function createEngine()`),
    // resolved by absolute file URL so it works regardless of the caller's cwd.
    const mod = (await import(pathToFileURL(candidate).href)) as {
      createEngine?: EngineFactory;
    };
    if (typeof mod.createEngine !== 'function') {
      throw new Error(
        `epubcheck-standalone: ${candidate} does not export createEngine(); the ` +
          'engine build is stale or corrupt. Run `npm run build` to regenerate it.',
      );
    }
    return mod.createEngine;
  }
  throw new Error(
    'epubcheck-standalone: the compiled engine module is missing (looked for ' +
      ENGINE_CANDIDATES.join(' and ') +
      '). dist/epubcheck-engine.js is a build artifact and is not committed. Run ' +
      '`npm run build` in packages/epubcheck-standalone, or restore dist/, then retry.',
  );
}

function getFactory(): Promise<EngineFactory> {
  if (factoryPromise === null) factoryPromise = importFactory();
  return factoryPromise;
}

function yieldMacrotask(): Promise<void> {
  return yieldImmediate(undefined) as unknown as Promise<void>;
}

/** Drive one validation run through the Node-loaded engine. */
export function runEngine(run: EngineRun): Promise<EngineResult> {
  return driveEngine(run, getFactory, yieldMacrotask);
}
