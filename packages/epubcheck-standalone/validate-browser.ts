// epubcheck-standalone -- browser public API.
//
// The SAME `validate(source, options)` as the Node entry; the package's exports
// browser condition resolves `epubcheck-standalone` here so browser code gets the
// browser engine driver (imports the engine asset as an es module and calls its
// createEngine() factory for a fresh scope per run -- no eval, no unsafe-eval)
// behind the identical API. Every source runs on the page's MAIN thread as well
// as in Workers: the file-backed plugins (blob, opfs, fileList, opfsDir) read
// asynchronously through slice().arrayBuffer() / getFile() and the engine
// suspends mid-run for each pull, memory() reads from RAM, and url() downloads
// over the async http bridge. The engine otherwise runs to completion on the
// calling thread, so a Worker keeps the page's main thread free during the
// CPU-bound stretches. Build a source with a plugin and call validate:
//
//   import { validate } from 'epubcheck-standalone';         // browser condition
//   import { blob } from 'epubcheck-standalone/plugins';
//   const result = await validate(blob(file));
//
// customMessages accepts a Blob/File here in addition to bytes/string (read with
// async Blob.arrayBuffer(), so it works on the main thread and in Workers alike).
// Use `configureEngine` if you host the engine asset somewhere the default
// `new URL('./epubcheck-engine.js', import.meta.url)` does not resolve.

import { runEngine, configureEngine } from './engine-browser.js';
import { validateWith } from './validate-core.js';
import type { ValidateOptions as CoreValidateOptions, ValidateSource } from './validate-core.js';
import type { EpubCheckResult } from './result-types.js';
import { EPUBCHECK_VERSION } from './version.js';

// The main entry owns `validate`, `configureEngine`, the run option/result
// types, and EPUBCHECK_VERSION. Source plugins and their contract types come
// only from `epubcheck-standalone/plugins`; parse functions from
// `epubcheck-standalone/parse`; formatters from
// `epubcheck-standalone/formatters`. One import path per symbol -- nothing is
// re-exported from here.
export type {
  Severity,
  MessageLocation,
  EpubCheckMessage,
  EpubCheckSummary,
  EpubCheckReports,
  EpubCheckResult,
} from './result-types.js';
export type { ValidateSource } from './validate-core.js';
export { configureEngine, EPUBCHECK_VERSION };

/** Browser validate options: customMessages may also be a Blob/File. */
export interface ValidateOptions extends Omit<CoreValidateOptions, 'customMessages'> {
  customMessages?: Uint8Array | string | Blob;
}

/**
 * Validate an EPUB from a source, in the current Worker, to completion. Same
 * contract as the Node `validate`; see the package README.
 */
export async function validate(
  source: ValidateSource,
  options: ValidateOptions = {},
): Promise<EpubCheckResult> {
  // A Blob/File override is read to bytes here with async Blob.arrayBuffer()
  // (main-thread-legal on every browser, and this function is already async),
  // then the shared validate handles the rest.
  const { customMessages, ...rest } = options;
  const core: CoreValidateOptions = { ...rest };
  if (customMessages !== undefined) {
    if (typeof Blob !== 'undefined' && customMessages instanceof Blob) {
      const bytes = new Uint8Array(await customMessages.arrayBuffer());
      core.customMessages = bytes;
      const blobName = (customMessages as File).name;
      if (typeof blobName === 'string' && blobName.length > 0 && options.customMessagesName === undefined) {
        core.customMessagesName = blobName;
      }
    } else {
      core.customMessages = customMessages as Uint8Array | string;
    }
  }
  return validateWith(runEngine, source, core);
}

export default { validate, configureEngine, EPUBCHECK_VERSION };
