// epubcheck-standalone -- browser engine loader (internal).
//
// Obtains the engine factory (`createEngine`) and binds the isomorphic driver
// (engine-run.ts) with the browser's one-macrotask yield (a promisified
// setTimeout(0)). The engine is a ~21 MB SEPARATE ES module asset; it is loaded
// ONCE with a dynamic `import()` and cached, then CALLED per run for a fresh
// scope (see engine-run.ts).
//
// Where the engine factory comes from, in order of preference:
//   1. a factory handed in via `configureEngine({ createEngine })` (a consumer
//      that imports the engine module itself),
//   2. a URL set via `configureEngine({ url })`, dynamically imported,
//   3. `new URL('./epubcheck-engine.js', import.meta.url)` -- the bundler pattern
//      Vite/webpack recognize to emit the asset and give its URL -- dynamically
//      imported.
// A dynamic `import()` is a real ES-module load: NO eval, NO new Function, NO
// string-to-code. The page's CSP therefore needs only to allow the engine URL
// under script-src (same-origin 'self' is enough); it does NOT need 'unsafe-eval'.

import { driveEngine } from './engine-run.js';
import type { EngineRun, EngineResult, EngineFactory } from './engine-run.js';

// The engine module's export shape: a single `createEngine()` factory.
interface EngineModuleNamespace {
  createEngine: EngineFactory;
}

let cachedFactory: EngineFactory | null = null;
let configuredFactory: EngineFactory | null = null;
let configuredUrl: string | null = null;

/**
 * Point the browser build at the engine asset. Call once, before the first
 * `validate`, with EITHER a pre-imported factory (`createEngine`, e.g. from
 * `import { createEngine } from 'epubcheck-standalone/epubcheck-engine.js'`) or
 * the URL to dynamically import it from (`url`). Optional: by default the engine
 * is imported from `new URL('./epubcheck-engine.js', import.meta.url)`.
 */
export function configureEngine(options: { createEngine?: EngineFactory; url?: string }): void {
  if (options.createEngine !== undefined) configuredFactory = options.createEngine;
  if (options.url !== undefined) configuredUrl = options.url;
  cachedFactory = null;
}

async function getFactory(): Promise<EngineFactory> {
  if (cachedFactory !== null) return cachedFactory;
  if (configuredFactory !== null) {
    cachedFactory = configuredFactory;
    return cachedFactory;
  }
  const url = configuredUrl ?? new URL('./epubcheck-engine.js', import.meta.url).href;
  // A real module load. The specifier is resolved at runtime, so it is marked
  // vite-ignore for consumers that bundle with Vite (webpack/Rollup treat a
  // fully dynamic specifier as external the same way).
  const mod = (await import(/* @vite-ignore */ url)) as EngineModuleNamespace;
  if (typeof mod.createEngine !== 'function') {
    throw new Error(
      `epubcheck-standalone: the engine module at ${url} does not export ` +
        'createEngine(); check the URL points at the built dist/epubcheck-engine.js.',
    );
  }
  cachedFactory = mod.createEngine;
  return cachedFactory;
}

function yieldMacrotask(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/** Drive one validation run through the browser-loaded engine. */
export function runEngine(run: EngineRun): Promise<EngineResult> {
  return driveEngine(run, getFactory, yieldMacrotask);
}
