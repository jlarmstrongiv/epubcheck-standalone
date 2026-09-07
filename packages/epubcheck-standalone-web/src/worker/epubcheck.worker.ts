// Typed validation worker. Builds an interface object, `expose()`s it over
// comlink, and postMessages a READY signal so spawnWorker's handshake resolves.
// The engine underneath is the TeaVM JS-backend build of epubcheck.
//
// This is a thin consumer of the library's isomorphic validator. The worker's
// job is:
//   1. wrap the picked File in the library's `blob` range source (or an
//      expanded-EPUB folder's File[] in the `fileList` directory source),
//   2. run validate() ONCE in `reports` mode, with an onMessage tap: the JSON
//      report drives the results table (and its download button) and the XML/XMP
//      reports drive the other download buttons, so one call covers both. The
//      library runs the engine once per requested format (3 runs for our
//      json/xml/xmp set); asking for json avoids the internal extra json pass it
//      would otherwise add to rebuild messages (see run-core assembleResult).
//   3. assemble the UI-facing ValidationResult (see parse.ts).
//
// onMessage stays post-hoc (the library invokes it once per message after the
// run, before the promise resolves), so it still feeds the live table. In report
// mode the per-message console lines and the "Validating using EPUB version X"
// banner are replaced by the writers, so parse.ts reads the EPUB version from the
// JSON report instead of the console (see AssembleMeta.reports).
//
// useEpubcheck keeps ONE persistent worker across file and directory
// validations (spawned lazily on the first run, torn down on unmount), so the
// library's warm engine — its reused runtime scope lives in this worker's module
// state — makes repeat runs take the fast path. URL validation does NOT come
// here: the library's url() source suspends the engine mid-run for its async
// fetch, so it runs on the main thread instead (see validateUrlMainThread.ts).
// This worker handles only blob (File) and fileList (expanded-directory) sources.

import { expose } from "comlink";
import { READY_MESSAGE } from "./spawnWorker";
import {
  validate,
  configureEngine,
  blob,
  fileList,
  EPUBCHECK_ENGINE_URL,
} from "./vendor";
import type { ReportMessage } from "./vendor";
import { assembleValidationResult } from "./parse";
import type { ValidationResult } from "./types";

export type OnLiveMessage = (message: ReportMessage) => void;

// Point the browser build at the engine asset (Vite gives us its URL).
configureEngine({ url: EPUBCHECK_ENGINE_URL });

const REPORTS = ["json", "xml", "xmp"] as const;

async function validateFile(
  file: File,
  args: string[] = [],
  customMessages?: string,
  onLiveMessage?: OnLiveMessage,
): Promise<ValidationResult> {
  const name = file.name || "input.epub";
  const options = {
    name,
    ...(args.length > 0 ? { args } : {}),
    ...(customMessages ? { customMessages } : {}),
  };

  const start = performance.now();
  // Single report-mode run: onMessage feeds the live table, the reports feed the
  // download buttons, and parse.ts derives everything else from the result.
  const result = await validate(blob(file), {
    ...options,
    reports: [...REPORTS],
    onMessage: (message: ReportMessage) => {
      if (onLiveMessage) void onLiveMessage(message);
    },
  });
  const wallMs = performance.now() - start;

  return assembleValidationResult(result, {
    name,
    isDirectory: false,
    sizeBytes: file.size,
    wallMs,
    reports: result.reports ?? {},
  });
}

async function validateDirectory(
  files: File[],
  paths: string[],
  name: string,
  args: string[] = [],
  customMessages?: string,
  onLiveMessage?: OnLiveMessage,
): Promise<ValidationResult> {
  const reportedName = name || "book";
  const options = {
    name: reportedName,
    ...(args.length > 0 ? { args } : {}),
    ...(customMessages ? { customMessages } : {}),
  };
  const source = fileList(files, { paths: (_file, index) => paths[index]! });
  const sizeBytes = files.reduce((total, file) => total + file.size, 0);

  const start = performance.now();
  const result = await validate(source, {
    ...options,
    reports: [...REPORTS],
    onMessage: (message: ReportMessage) => {
      if (onLiveMessage) void onLiveMessage(message);
    },
  });
  const wallMs = performance.now() - start;

  return assembleValidationResult(result, {
    name: reportedName,
    isDirectory: true,
    sizeBytes,
    wallMs,
    reports: result.reports ?? {},
  });
}

// Pre-warm entry point. Runs the engine's main() ONCE to a clean completion
// purely to prime the library's reused runtime scope in this worker's module
// state; the structured result is discarded. It deliberately requests NO report
// files and passes no message tap: report mode runs main() once per requested
// format (3 passes for our json/xml/xmp set), so a warm-up that asked for
// reports would do three cold passes when exactly one is needed. Real
// validations (validateFile/validateDirectory) keep their report behavior.
async function warmup(file: File): Promise<void> {
  await validate(blob(file), { name: file.name || "input.epub" });
}

export const EpubcheckInterface = {
  validate: validateFile,
  validateDirectory,
  warmup,
};
export type EpubcheckInterface = typeof EpubcheckInterface;

expose(EpubcheckInterface);
postMessage(READY_MESSAGE);
