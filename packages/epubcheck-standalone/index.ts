// epubcheck-standalone -- Node public API.
//
// This is the real epubcheck 5.3.0 (w3c/epubcheck, the Java validator) compiled
// to plain JavaScript with TeaVM (JS backend). Output is byte-for-byte identical
// to the native epubcheck (verified across the 446-book committed corpus with
// strict message + exit-code parity, and against 105 committed report files).
//
// ISOMORPHIC API. There is ONE entry point, `validate(source, options)`, and it
// is the SAME in Node and in the browser -- the package's `exports` conditions
// swap only the engine driver underneath. In Node, import from `epubcheck-standalone`;
// in a browser Worker, import from `epubcheck-standalone` too (the browser condition
// resolves to the browser build). The old named Node-only functions
// (validateFile / validateBuffer / validateDirectory / validateUrl) are gone:
// build a source with a plugin and pass it to `validate`.
//
// The source plugins live under `epubcheck-standalone/plugins` (one import path
// per symbol -- they are not re-exported from the bare package):
//
//   import { validate } from 'epubcheck-standalone';
//   import { fs } from 'epubcheck-standalone/plugins';
//   using source = await fs('book.epub');
//   const result = await validate(source);          // packaged .epub
//
//   import { validate } from 'epubcheck-standalone';
//   import { fsDir } from 'epubcheck-standalone/plugins';
//   const result = await validate(await fsDir('expanded-book')); // --mode exp
//
//   import { validate } from 'epubcheck-standalone';
//   import { url } from 'epubcheck-standalone/plugins';
//   const result = await validate(await url('https://example.com/book.epub'));
//
// Each validation runs the engine IN-PROCESS on the calling thread (it blocks
// that thread while it runs -- run it from your own worker_thread if you need it
// off the main thread; the library manages no threads of its own). The engine
// comes from the build-time engine factory (an exported createEngine() -- no
// eval, no new Function); the driver reuses one engine scope across
// validations (the engine resets its own per-run state on entry, and a scope
// is discarded after an engine error), so back-to-back calls skip the runtime
// rebuild. `validate` is freely reusable and concurrent calls on one thread
// serialize through an internal queue.

import { EPUBCHECK_VERSION } from './version.js';
import { runEngine } from './engine-node.js';
import { validateWith } from './validate-core.js';
import type { ValidateOptions, ValidateSource } from './validate-core.js';
import type { EpubCheckResult } from './result-types.js';

// The main entry owns `validate`, the run option/result types, and
// EPUBCHECK_VERSION. Source plugins (fs, fsDir, url, ...) and their contract
// types (RangeSource, DirectorySource, ...) come only from
// `epubcheck-standalone/plugins`; the parse functions from
// `epubcheck-standalone/parse`; the formatters from
// `epubcheck-standalone/formatters`. Each public symbol has exactly one import
// path, so nothing is re-exported from here.
export type {
  Severity,
  MessageLocation,
  EpubCheckMessage,
  EpubCheckSummary,
  EpubCheckReports,
  EpubCheckResult,
} from './result-types.js';
export type { ValidateOptions, ValidateSource } from './validate-core.js';
export { EPUBCHECK_VERSION };

/**
 * Validate an EPUB from a source, in the current thread, to completion.
 *
 * @param source   A range source (a packaged .epub: `fs` / `blob` / `opfs` /
 *                 `memory`), a URL input (`await url('https://...')` -- the
 *                 URL itself is epubcheck's input, exactly like the jar's
 *                 remote mode), a directory source (an expanded EPUB:
 *                 `fsDir` / `opfsDir` / `fileList` / `memoryDir` -- runs
 *                 `--mode exp` automatically), or raw bytes (`Uint8Array`). Your
 *                 own implementation of either source contract works too.
 *                 `validate` disposes the source when the run ends.
 * @param options  Optional `name`, `args`, `customMessages`, `reports`, `tz`,
 *                 `onMessage`.
 * @returns The structured `EpubCheckResult`.
 */
export function validate(
  source: ValidateSource,
  options: ValidateOptions = {},
): Promise<EpubCheckResult> {
  return validateWith(runEngine, source, options);
}

export default { validate, EPUBCHECK_VERSION };
