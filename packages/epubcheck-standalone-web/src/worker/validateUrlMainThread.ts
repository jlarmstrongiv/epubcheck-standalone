// Main-thread URL validation. The library's `url()` source drives the engine
// with an async fetch bridge: the engine pauses mid-run while the download
// happens and resumes when it settles, so a URL check needs no Worker — it runs
// fine on the browser main thread. File/Blob and expanded-directory checks still
// go through epubcheck.worker.ts; only URL validation lives here.
//
// This mirrors the worker's former validateUrl exactly (same options, same
// single report-mode run, same assembleValidationResult shape) so the UI sees an
// identical result. The one difference is plumbing: onLiveMessage is a direct
// callback here (no comlink proxy across a thread boundary).
//
// The engine underneath is the TeaVM JS-backend build of epubcheck (plain
// JavaScript). configureEngine points the browser build at the engine asset,
// exactly as the worker does at its own module load.

import {
  validate,
  configureEngine,
  url as urlSource,
  EPUBCHECK_ENGINE_URL,
} from "./vendor";
import type { ReportMessage } from "./vendor";
import { assembleValidationResult } from "./parse";
import type { ValidationResult } from "./types";

export type OnLiveMessage = (message: ReportMessage) => void;

// Point the browser build at the engine asset (Vite gives us its URL).
configureEngine({ url: EPUBCHECK_ENGINE_URL });

const REPORTS = ["json", "xml", "xmp"] as const;

export async function validateUrl(
  url: string,
  args: string[] = [],
  customMessages?: string,
  onLiveMessage?: OnLiveMessage,
  signal?: AbortSignal,
): Promise<ValidationResult> {
  let name = url;
  try {
    const path = new URL(url).pathname;
    const base = path.slice(path.lastIndexOf("/") + 1);
    if (base) name = decodeURIComponent(base);
  } catch {
    /* not a parseable URL: fall back to the raw string, url() will reject it */
  }
  const options = {
    ...(args.length > 0 ? { args } : {}),
    ...(customMessages ? { customMessages } : {}),
  };

  const start = performance.now();
  // Jar-parity URL mode: the URL itself is epubcheck's input (message
  // locations carry it) and the engine suspends mid-run while the library's
  // async fetch bridge downloads it, so the byte size is not known up front --
  // report 0 and let the UI treat it as unknown. `name` (the URL's basename)
  // stays a display label only.
  const source = await urlSource(url);
  const sizeBytes = 0;
  const result = await validate(source, {
    ...options,
    reports: [...REPORTS],
    // Cooperative cancel: the engine suspends on the main thread for the async
    // download, so an abort during that window stops the run (validate rejects
    // with the signal's reason). This is a genuine AbortSignal, unlike the
    // worker path whose hard stop is worker termination.
    ...(signal ? { signal } : {}),
    onMessage: (message: ReportMessage) => {
      if (onLiveMessage) onLiveMessage(message);
    },
  });
  const wallMs = performance.now() - start;

  return assembleValidationResult(result, {
    name,
    isDirectory: false,
    sizeBytes,
    wallMs,
    reports: result.reports ?? {},
  });
}
