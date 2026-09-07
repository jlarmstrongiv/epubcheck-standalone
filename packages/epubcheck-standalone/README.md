# epubcheck-standalone

[![npm version](https://img.shields.io/npm/v/epubcheck-standalone)](https://www.npmjs.com/package/epubcheck-standalone) [![npm downloads](https://img.shields.io/npm/dm/epubcheck-standalone)](https://www.npmjs.com/package/epubcheck-standalone)

EPUBCheck, the official [W3C EPUB validator](https://github.com/w3c/epubcheck), compiled to plain JavaScript with TeaVM. One `validate` call runs the same way in Node.js and the browser and gives byte-for-byte the same output as EPUBCheck.

- EPUBCheck on the web
- Supports large files (16 GB verified)
- Identical output to the Java version
- Your ebook never leaves your device
- Node.js and browser support
- Full API parity
- JavaScript compiled by TeaVM
- Automatically up-to-date
- Permissive BSD-3-Clause license

## Install

```sh
npm install epubcheck-standalone
```

Needs Node.js LTS or newer.

## Validate a book in Node.js

```ts
import { validate } from "epubcheck-standalone";
import { fs } from "epubcheck-standalone/plugins";

const result = await validate(await fs("./book.epub"));

console.log(result.valid);      // true when there are no errors or fatals
console.log(result.exitCode);   // 0 = clean, 1 = errors
console.log(result.summary);    // { fatals, errors, warnings, infos }
for (const m of result.messages) {
  // { id, severity, message, suggestion, path, line, column, context, sequence }
  console.log(`${m.severity}(${m.id}) ${m.message}`);
}
```

`validate` imports from the bare package. Every read plugin imports from `epubcheck-standalone/plugins`. TypeScript types ship with the package.

You pick a read plugin for wherever your bytes live (`fs`, `blob`, `opfs`, `memory`, `url`, or the directory plugins), hand it to `validate`, and it reads and disposes the source for you. A raw `Uint8Array` works as a source too. The engine runs in-process on the calling thread. Run `validate` from your own `worker_threads` worker if you want it off the main thread.

## Validate a book in the browser

Import `epubcheck-standalone` inside a Web Worker and point it at the engine asset with `configureEngine`.

```ts
// worker.ts, spawned with { type: "module" }
import { validate, configureEngine } from "epubcheck-standalone";
import { blob } from "epubcheck-standalone/plugins";
import engineUrl from "epubcheck-standalone/epubcheck-engine.js?url"; // Vite: the engine asset URL

configureEngine({ url: engineUrl });

onmessage = async (e) => {
  const result = await validate(blob(e.data.file));
  postMessage(result);
};
```

`configureEngine({ url })` points the build at the engine asset. Get the URL however your bundler prefers, such as Vite's `?url` above. Skip `configureEngine` and the build loads the engine from `new URL("./epubcheck-engine.js", import.meta.url)`. The compressed engine download is about 3 MB.

A Worker is not required. Every plugin runs on the page's main thread as well. The example uses a Worker because validation is CPU bound, so a Worker keeps the page responsive during a run. The one main-thread exception is `opfs` given a `FileSystemSyncAccessHandle` you created yourself, since those handles exist only in dedicated Workers by spec.

The engine loads as a separate ES module, so nothing is evaluated from a string and your content security policy needs no `unsafe-eval`. It only has to allow the engine URL under `script-src`, which same-origin `'self'` already covers.

The [web app](https://github.com/jlarmstrongiv/epubcheck-standalone/tree/main/packages/epubcheck-standalone-web) is a complete working example.

## Read plugins

Pick the plugin for wherever your bytes live. All import from `epubcheck-standalone/plugins`.

| Plugin | Environment | What it reads |
| --- | --- | --- |
| `blob(fileOrBlob)` | Browser, any thread | A `File` or `Blob`: picked files, `fetch().blob()`, Blobs from IndexedDB. Read lazily through `slice().arrayBuffer()`. |
| `opfs(pathOrHandle)` | Browser, any thread | A file in OPFS, by path or `FileSystemFileHandle`. A `FileSystemSyncAccessHandle` is Worker-only. Async factory. |
| `fs(path, { fs? })` | Node, or an injected fs | A file through positional reads. Async factory. |
| `memory(bytes)` | Anywhere | A `Uint8Array` already in RAM. |
| `url(href)` | Node, browser any thread | An http(s) EPUB in jar-parity remote mode (see below). Async factory. |
| `s3(key, { backend })` | Anywhere, injected client | A packaged `.epub` object in S3-compatible storage, by key. Ranged reads, never downloaded whole (see below). Async factory. |

```ts
import { validate } from "epubcheck-standalone";
import { blob, opfs } from "epubcheck-standalone/plugins";

const a = await validate(blob(file));
const b = await validate(await opfs("books/book.epub"));
```

## Options

```ts
await validate(source, {
  name: "book.epub",
  args: ["--profile", "edupub"],
  reports: ["json"],
});
```

- `name`: the reported file name, used in message locations and report file names. Defaults to the source's own name. A `url` source ignores it, since the URL is the reported input.
- `args`: extra EPUBCheck CLI arguments, placed before the input path like the stock CLI, such as `["--locale", "fr"]` or `["--mode", "xhtml", "-v", "3.0"]`.
- `customMessages`: message overrides (see below).
- `customMessagesName`: the file name the overrides are reported under. Defaults to `messages.txt`.
- `reports`: report formats to produce, any of `"json"`, `"xml"`, `"xmp"` (see below).
- `dirMode`: how a directory source is validated, `"direct"` (the default) or `"exp"` (see expanded directories below).
- `tz`: IANA time zone id for report timestamps. Defaults to the host zone.
- `onMessage`: a callback that fires once per message, live during the run, in the order EPUBCheck emits them. Each argument is the same `ReportMessage` object that lands in `result.messages`.
- `onFeature`: the symmetric callback for feature/info events, fired live once per feature in emission order with the same `ReportFeature` object that lands in `result.features`. It is what lets a live consumer place feature-derived chrome (such as the "Validating using EPUB version X rules." line) in real emission order.
- `signal`: an `AbortSignal` that cancels the run (see below).
- `timeoutMs`: a time limit in milliseconds, sugar for `signal: AbortSignal.timeout(timeoutMs)` (see below).

## The result

`validate` returns a `Promise<EpubCheckResult>`. The result carries `valid`, `exitCode`, `summary`, raw `stdout` and `stderr`, `reports` when you request any, and the complete report data of the run directly:

- `messages`: a `ReportMessage[]`, the complete checker-message list in emission order. Each message is `{ id, severity, message, suggestion, path, line, column, context, sequence }` (`id` is the EPUBCheck code such as `"RSC-005"`; `path`/`line`/`column` are flat, with `line`/`column` of `-1` when the message is not tied to a position).
- `features`: a `ReportFeature[]`, every feature/info event of the run in emission order (publication and item metadata, sizes, checksums, fonts, references, tool info). Each feature is `{ resource, feature, value, sequence }`.

`sequence` is a 0-based, monotonically increasing global emission index shared across both lists: it counts up by one for every message and every feature in the true order EPUBCheck produced them, so the two lists can be interleaved back into one emission-ordered stream (this is how the console renderer places the "Validating using EPUB version X rules." line among the messages). It survives a JSON save and rehydrate.

Because the result carries `messages` and `features` directly, it *is* a `ReportData` (`{ messages, features }`): hand it straight to any formatter from `epubcheck-standalone/formatters`, or `JSON.stringify` `{ messages, features }`, persist it, and `JSON.parse` it back later to re-render any report losslessly.

```ts
import { validate } from "epubcheck-standalone";
import { fs } from "epubcheck-standalone/plugins";
import { formatConsoleReport, formatJsonReport } from "epubcheck-standalone/formatters";

const result = await validate(await fs("./book.epub"));

// the result is a ReportData, so it goes straight to a formatter
const consoleText = formatConsoleReport(result, { filename: "book.epub" });
const json = formatJsonReport(result, { filename: "book.epub" });

// or round-trip through JSON and re-render later, losslessly
const saved = JSON.stringify({ messages: result.messages, features: result.features });
const reloaded = JSON.parse(saved);
const sameConsole = formatConsoleReport(reloaded, { filename: "book.epub" });
```

`epubcheck-standalone/formatters` exports `formatJsonReport`, `formatXmlReport`, and `formatXmpReport` (each byte-identical to EPUBCheck's own `--json`/`--out`/`--xmp` writers) plus `formatConsoleReport`, which reproduces EPUBCheck's human-readable console output in true emission order. `formatJsonReport`/`formatXmlReport`/`formatXmpReport` take `(reportData: ReportData, options: FormatterOptions)`; `formatConsoleReport` takes `(reportData: ReportData, options: ConsoleFormatterOptions)`. All require `options.filename`, the reported EPUB name.

## Expanded EPUB directories

A book that lives as an unzipped folder is a directory source. Hand one to `validate` and it validates the folder in place by default, matching the jar handed a directory path with no `--mode`. Four directory plugins mirror the read plugins.

| Plugin | Environment | What it reads |
| --- | --- | --- |
| `fileList(files, { paths? })` | Browser, any thread | `File` objects from a folder drop or `<input webkitdirectory>`. Paths come from `webkitRelativePath` or from `paths`. |
| `opfsDir(directoryHandle)` | Browser, any thread | An OPFS directory, walked recursively. Async factory. |
| `fsDir(path, { fs? })` | Node, or an injected fs | A directory on a filesystem, walked once at creation. Async factory. |
| `memoryDir(map)` | Anywhere | A `Map` or object from relative path to `Uint8Array`. |
| `s3Dir(prefix, { backend })` | Anywhere, injected client | An expanded book stored as objects under a key prefix in S3-compatible storage (see below). Async factory. |

Output matches what the official tool prints for a directory path with no `--mode` on the same folder: message locations carry the directory name itself, exactly like the jar's auto-detected expanded book.

Set `dirMode: "exp"` to package the folder into a synthetic `<folder-name>.epub` container first instead, matching the jar's explicit `--mode exp`: message locations then appear under that container name. The two differ only in how EPUBCheck labels and traverses the input.

Under the default a folder not named `*.epub` errors `Mode required for non-epub files. Default version is 3.0.` and exits `1`, exactly like the jar given a bare directory path. To validate such a folder, name it `*.epub` or pass `dirMode: "exp"`.

## Custom message overrides

`customMessages` is EPUBCheck's `-c`/`--customMessages` flag: the overrides file as bytes (`Uint8Array`) or text (`string`), or a `Blob`/`File` in the browser. Use it to promote messages suppressed by default (the accessibility checks), demote or suppress messages, or reword them.

The file is tab-separated lines of:

- message ID
- severity: `FATAL`, `ERROR`, `WARNING`, `INFO`, `USAGE`, or `SUPPRESSED`
- optional replacement message text (keeps the original `%1$s`-style parameters)
- optional replacement suggestion text

```ts
import { validate } from "epubcheck-standalone";
import { fs } from "epubcheck-standalone/plugins";

const overrides = "ACC-001\tERROR\n";
const result = await validate(await fs("./book.epub"), {
  customMessages: overrides,
  customMessagesName: "overrides.txt",
});
```

Output is byte for byte what the Java tool prints for the same overrides, down to the `CHK-001` through `CHK-007` errors for a malformed file.

## Report files (JSON, XML, XMP)

Pass `reports` to also produce EPUBCheck's own report output, byte-identical to the stock CLI's `--json`, `--out`, and `--xmp` writers. The result gains a `reports` field with the formats you asked for.

```ts
import { validate } from "epubcheck-standalone";
import { fs } from "epubcheck-standalone/plugins";
import { writeFile } from "node:fs/promises";

const result = await validate(await fs("./book.epub"), { reports: ["json", "xml", "xmp"] });
if (result.reports?.json) await writeFile("book.epub.json", result.reports.json);
if (result.reports?.xml) await writeFile("book.epub.xml", result.reports.xml);
if (result.reports?.xmp) await writeFile("book.epub.xmp", result.reports.xmp);
```

One validation runs the engine once and produces any or all of the formats: they are rendered host-side from that single run's live report-event stream by the `epubcheck-standalone/formatters` writers, byte-identical to the stock CLI, with no per-format re-validation. `result.messages` and `result.features` are populated on every run whether or not you request `reports`, so you can also skip the `reports` option and render the same documents later from the result (or from a saved `{ messages, features }`) with `formatJsonReport`/`formatXmlReport`/`formatXmpReport`/`formatConsoleReport`.

## Remote URLs

`url(href)` runs EPUBCheck's own remote-input mode, exactly like `java -jar epubcheck.jar https://example.com/book.epub`. The URL itself is the input the engine sees, so message locations reference the URL (byte for byte what the jar prints) and download failures keep the jar's exception headlines (404 gives `FileNotFoundException`, refused gives `ConnectException`).

```ts
import { validate } from "epubcheck-standalone";
import { url } from "epubcheck-standalone/plugins";

const result = await validate(await url("https://example.com/book.epub"));
```

The engine performs the download mid-run over a plain async `fetch`, so your event loop stays free the whole time. In Node the body streams to a temp file and is range-read back, so remote size is not capped. In the browser the response is held as a `Blob` and range-read block by block, not buffered whole in RAM: on Chromium the Blob spools to disk so remote size is uncapped, and on Firefox and Safari it stays off the main thread's contiguous allocation, well past the old in-memory limit. The target server must allow cross-origin requests. Redirects are followed before the final status is reported, matching the jar.

To validate remote bytes under a plain file name instead, fetch them yourself and pass the bytes or a `Blob`.

## Validate a book in S3

Validate an EPUB in S3-compatible storage without downloading it whole. `s3(key, { backend })` reads a packaged `.epub` object; `s3Dir(prefix, { backend })` reads an expanded book stored as objects under a key prefix. Both take ranged reads, so a multi-GB book validates at flat memory straight out of the bucket.

You bring a pre-configured aws-sdk `S3Client`. The library never sees your credentials and never bundles aws-sdk: `@aws-sdk/client-s3` is an optional peer dependency, dynamic-imported only when you call `s3ClientBackend`.

```ts
import { S3Client } from "@aws-sdk/client-s3";
import { validate } from "epubcheck-standalone";
import { s3, s3ClientBackend } from "epubcheck-standalone/plugins";

const client = new S3Client({ region: "us-east-1" });
const backend = await s3ClientBackend(client, "my-bucket");

const result = await validate(await s3("books/book.epub", { backend }));
```

Private buckets work, since your own client signs the requests. Hand the same `backend` to `s3Dir(prefix, { backend })` to validate an expanded book under a key prefix.

The backend is a small `{ size, read, list }` interface, so a non-aws S3 client such as R2 or MinIO, or a presigned-`fetch` backend, plugs in with no dependency at all.

Never embed raw secret keys in a browser. Sign requests with presigned URLs or temporary STS credentials there.

## Cancel a run

Pass `signal` or `timeoutMs` to stop a run you no longer want.

```ts
import { validate } from "epubcheck-standalone";
import { fs } from "epubcheck-standalone/plugins";

const controller = new AbortController();
cancelButton.onclick = () => controller.abort();

try {
  const result = await validate(await fs("./book.epub"), { signal: controller.signal });
} catch (err) {
  if (err instanceof DOMException && err.name === "AbortError") {
    // the run was cancelled
  }
}
```

- On abort the promise rejects with the signal's reason, an `AbortError` `DOMException` unless you passed your own. On timeout it rejects with a `TimeoutError`. Pass both and whichever fires first wins.
- Cancellation is cooperative. The engine notices the signal only when it comes back to your code for bytes: a book range read, a directory read, or a URL download. An abort lands quickly early in a run and may not land during a long stretch of pure computation. A run that reads synchronously start to finish, like an `fs` source in Node, can finish before the signal is checked.
- After a cancelled run the library discards its warm engine, so the next `validate` starts fresh and a cancelled run never leaks into the next one.

For a hard stop that always works, including a run stuck in pure computation, run `validate` in a worker you own and terminate it. The library never creates workers, so that worker is yours to kill.

```ts
const worker = new Worker(new URL("./epub-worker.js", import.meta.url), { type: "module" });
const timer = setTimeout(() => worker.terminate(), 120_000); // kills CPU and memory instantly
worker.onmessage = (e) => { clearTimeout(timer); /* result */ };
```

The same pattern works in Node with `worker_threads` and `worker.terminate()`.

## Running many validations

`validate` is safe to call as often as you like. The engine runs one validation at a time on each thread.

- The first call on a thread builds the engine, which takes a few seconds. Every later call reuses that warm engine, so a small book validates in tens of milliseconds.
- Concurrent calls on one thread queue and take turns rather than clashing. A run that fails, throws, or is cancelled drops the warm engine, so the next call rebuilds it.
- To validate several books at once, give each its own worker: a Web Worker in the browser, a `worker_threads` worker in Node. Each worker holds its own engine, so budget one engine's worth of memory per worker.

## Memory and file size

Range sources stream. The engine pulls byte ranges from the source on demand mid-run, so a `fs`, `blob`, `opfs`, or `url` source is never held whole in memory and peak memory is independent of book size. This is what lets multi-GB books validate (16 GB verified).

`memory` and `memoryDir` hold everything in RAM by nature, so use them only for small bundled inputs and prefer the streaming plugins otherwise.

For an expanded directory, EPUBCheck zips the tree into a temporary packaged copy before validating it, so peak engine memory tracks the packaged (compressed) book size, not the unpacked tree.

## Bring your own filesystem

`fs(path, { fs })` and `fsDir(path, { fs })` accept any fs-compatible backend. The motivating case is [ZenFS](https://github.com/zen-fs/core) in the browser (zip mounts, IndexedDB stores, cloud backends).

```ts
import { fs as zenfs } from "@zenfs/core";
import { validate } from "epubcheck-standalone";
import { fs } from "epubcheck-standalone/plugins";

const result = await validate(await fs("/mnt/cloud/book.epub", { fs: zenfs }), {
  name: "book.epub",
});
```

The plugins prefer a promise-based file API and fall back to a synchronous one, so both async and sync backends work. A promises-only backend (an async ZenFS configuration, a cloud store) backs the plugin end to end and keeps the event loop free.

The preferred API is the `node:fs/promises` shape. The default `node:fs` carries it under `.promises`, so `fs()` uses it automatically:

```ts
interface FsPromisesLike {
  open(path: string, flags: "r"): Promise<FileHandleLike>;
}
interface FileHandleLike {
  stat(): Promise<{ size: number }>;
  read(buffer: Uint8Array, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}
```

The fallback is four synchronous calls, used when the backend has no promise-based `open`:

```ts
interface FsLike {
  openSync(path: string, flags: "r"): number;
  fstatSync(fd: number): { size: number };
  readSync(fd: number, buffer: Uint8Array, offset: number, length: number, position: number): number;
  closeSync(fd: number): void;
}
```

Omit `{ fs }` and the plugins lazily import `node:fs`, so `plugins.js` imports cleanly in the browser.

When a file cannot be opened because the process lacks permission, `fs()` does not throw at you. It hands back a source whose reads carry the permission error into the run, so EPUBCheck reports it as a `FATAL(PKG-008)` itself, with the same message and exit code as the jar. Any other open failure throws right away. `fsDir` follows the same rule.

## Write your own source

When no plugin fits, implement the source contract yourself. A range source is one packaged book:

```ts
interface RangeSource {
  size: number;                        // total bytes
  read(offset: number, length: number):
    Uint8Array | Promise<Uint8Array>;  // exactly that range, sync or async
  [Symbol.dispose](): void;            // release the handle
}
```

`read` may return the bytes synchronously (the fast path) or return a promise, in which case the engine suspends mid-run until it resolves and your event loop stays free while the range is fetched. It is never asked past EOF and never asked for more than 8 MiB at once. A directory source is the sibling contract for expanded books: `list()` returning `{ path, size }[]`, `read(path, offset, length)`, and `[Symbol.dispose]()`.

`validate` disposes the source for you. If you hold a source yourself, dispose it with `using` or by calling `source[Symbol.dispose]()`. Stock Safari does not yet parse `using`; if you ship untranspiled code to Safari, call `source[Symbol.dispose ?? Symbol.for("Symbol.dispose")]()`, which finds the method on every engine.

## How it compares

- Official EPUBCheck (Java): the same engine, but it needs a Java install and some technical skill. This package is that engine as plain JavaScript, run with only Node.js or a browser.
- `@likecoin/epubcheck-ts`: a TypeScript port that self-reports 97 percent verdict agreement and 88 percent message agreement with EPUBCheck, and states it is not for formal certification. This package runs the official EPUBCheck code, so output is byte identical.
- `@korzun/epubcheck-ts`: a hand-written beta that covers a curated subset of the checks.
- The ports download less. This package downloads about 3 MB of compressed engine, and in return gives you every check EPUBCheck runs, byte for byte.

## Browser support

The engine instantiates and validates in stock, flagless Chrome, Firefox, and Safari, with no `unsafe-eval`. A headless-Chrome proof serves a page under a content security policy with no `unsafe-eval` and validates a book both in a dedicated Worker and on the main thread through `memory()`, with zero policy violations.

The full committed corpus of 446 books runs on Chrome and Node. Firefox and Safari have small-book smoke coverage: a clean book and a bad book reporting RSC-005 and RSC-007 byte-identical to the native binary.

## Versioning

The version is the upstream EPUBCheck release baked into the module, then a build number for this packaging of it. The build number bumps when the same EPUBCheck is repackaged (a new toolchain, a packaging fix) and resets for each new EPUBCheck. A scheduled workflow watches upstream EPUBCheck and opens a pull request that bumps the pinned version, rebuilds the module, and publishes the next build.

## Build and license

The engine is built from source with TeaVM, and this repo contains everything needed to reproduce it: `mise install`, `npm run build:deps`, then `npm run build` in this package. The `dist/` directory is a build artifact, not committed to git, but packed into the published npm tarball.

BSD-3-Clause, matching EPUBCheck. Bundled third-party components are listed in `THIRD-PARTY-NOTICES.txt`.
