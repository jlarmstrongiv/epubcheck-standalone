// ============================================================================
// PACKAGE SEAM — the demo consumes the epubcheck-standalone workspace package.
// ============================================================================
//
// In the monorepo this demo depends on the sibling workspace package
// "epubcheck-standalone" (packages/epubcheck-standalone), linked into node_modules by npm
// workspaces. The engine is now the TeaVM JS-backend build (plain JavaScript, no
// wasm), and the library owns driving it. The worker needs, all through this one
// seam:
//
//   - validate()          -> "epubcheck-standalone"            the isomorphic runner
//                            (browser export condition -> the browser build)
//   - configureEngine()   -> "epubcheck-standalone"            point it at the engine JS
//   - blob/fileList/url   -> "epubcheck-standalone/plugins"    the sources it builds
//   - parseEpubVersion    -> "epubcheck-standalone/parse"      the "Validating using
//                                                        EPUB version X" reader
//   - the engine JS URL   -> "epubcheck-standalone/epubcheck-engine.js" (its ?url)
//
// The engine JS is imported with Vite's `?url` suffix so Vite copies it into the
// build output (and serves it in dev) and hands back the correct hashed/absolute
// URL — including under the GitHub Pages base path. The worker passes it to
// configureEngine() so the browser build fetches it from there.

export { validate, configureEngine } from "epubcheck-standalone";
export type { EpubCheckResult } from "epubcheck-standalone";
// The result's complete message shape now lives on /formatters (ReportMessage:
// id/severity/message/suggestion/path/line/column/context). ReportFeature is the
// feature/info stream the console renderer aggregates; formatConsoleReport renders
// the human-readable CLI report on demand for the console/CLI download (the engine
// only pre-produces the json/xml/xmp report documents, so the console text is
// formatted here from the result's own { messages, features }).
export type { ReportMessage, ReportFeature } from "epubcheck-standalone/formatters";
export { formatConsoleReport } from "epubcheck-standalone/formatters";
export type { ConsoleFormatterOptions } from "epubcheck-standalone/formatters";
export type { RangeSource, DirectorySource } from "epubcheck-standalone/plugins";
export { blob, fileList, url } from "epubcheck-standalone/plugins";
export { parseEpubVersion } from "epubcheck-standalone/parse";

import engineUrl from "epubcheck-standalone/epubcheck-engine.js?url";

export const EPUBCHECK_ENGINE_URL = engineUrl;
