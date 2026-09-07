// epubcheck-standalone -- first-class range-source plugins ("bring your own fs").
//
// A RANGE SOURCE is the byte-source contract every epubcheck-standalone entry point
// consumes. It is deliberately tiny and STABLE PUBLIC API:
//
//   {
//     size: number,                                  // total bytes
//     read(offset, length) -> Uint8Array             // exactly that range, synchronously,
//                           | Promise<Uint8Array>,   //   or as a promise of it
//     [Symbol.dispose](): void,                      // release the handle (TC39 `using`)
//   }
//
// - `read` may fill synchronously OR return a promise. A synchronous fill is
//   the fast path (the engine consumes it inline); a promise makes the engine
//   SUSPEND mid-run at its TeaVM @Async seam until it resolves -- the same
//   pause mechanism URL downloads use -- which is what lets File/Blob sources
//   validate on the browser MAIN thread, where no synchronous file API
//   exists. The returned view is only guaranteed valid until the NEXT `read`
//   call (plugins may reuse an internal scratch buffer).
// - `read` is never asked for a range past EOF and never more than 8 MiB at
//   a time (the Java side's block size).
//
// Four plugins ship with the package -- import { blob, opfs, fs, memory }:
//
//   blob(fileOrBlob)          File/Blob: async slice().      (browser Workers AND the
//                             arrayBuffer() reads            main thread)
//   opfs(pathOrHandle)        OPFS file: async getFile() +   (browser Workers AND the
//                             slice() reads (sync only for   main thread; async factory)
//                             a passed-in sync handle)
//   fs(path, { fs })          disk / any fs-compatible       (Node by default; async factory)
//   memory(bytes)             a Uint8Array already in RAM    (small bundled files; sync)
//
// A DIRECTORY SOURCE is the sibling contract for EXPANDED (unzipped) EPUBs --
// epubcheck's --mode exp. Instead of one byte range it exposes a listing of
// relative file paths with sizes, plus a per-file range read:
//
//   {
//     list() -> [{ path, size }, ...],               // every file, relative '/' paths
//     read(path, offset, length) -> Uint8Array       // that file's range, synchronously,
//                                 | Promise<...>,    //   or as a promise of it
//     [Symbol.dispose](): void,                      // release the handles (TC39 `using`)
//   }
//
// Four directory plugins ship alongside -- import { fsDir, opfsDir, fileList,
// memoryDir }:
//
//   fsDir(path, { fs })       a directory on disk / any fs   (Node by default; async factory)
//   opfsDir(directoryHandle)  an OPFS directory, recursively (browser Workers AND the
//                             via async getFile() reads      main thread; async factory)
//   fileList(files)           File[] from a folder drop or   (browser Workers AND the
//                             <input webkitdirectory>: async main thread)
//                             slice() reads
//   memoryDir(map)            relative path -> Uint8Array    (small in-RAM trees; sync)
//
// The `fs` plugin takes an INJECTABLE fs implementation and PREFERS its
// promise-based FileHandle API (node:fs/promises shape -- also what an
// async-only ZenFS configuration or a cloud backend exposes). When a backend
// offers that async API the plugin's reads return promises, so the engine
// suspends per cache-miss block exactly as a File/Blob source does on the
// browser main thread -- even the default node:fs goes this way (it carries a
// `.promises` namespace). A backend that exposes ONLY the four fd-positional
// sync calls listed below still works: it falls back to synchronous reads (the
// compatibility floor for sync-only stores). See README ("Bring your own fs").
//
// This module is environment-neutral ESM: it touches no Node built-ins at load
// time (node:fs is imported lazily inside `fs()` only when no implementation
// is injected), so it can be imported in a browser Worker as-is.
//
// MEMORY MODEL (important): a RANGE source is STREAMED end to end. The engine
// pulls byte ranges from the source's `read` MID-RUN (sync or async, at most
// 8 MiB per pull, through a bounded 64 MiB block cache on the Java side), so
// the book is never materialized whole on either side of the boundary -- peak
// memory is independent of book size, which is what lets multi-GB ZIP64 books
// validate. Two practical consequences:
// - the source must stay open for the WHOLE run (validate() disposes it when
//   the run ends -- do not dispose it yourself mid-run);
// - a plugin that already holds everything in RAM (memory) costs its full
//   size by nature; the disk-backed plugins (fs, blob, opfs) only ever hold
//   the ranges currently being served. A `url` input streams through the
//   async http bridge (spooled to disk in Node), so it is not memory-bound
//   there either (browsers hold the download in memory for the run).
// DIRECTORY sources (expanded-directory mode) stream the same way: only the
// listing (paths + sizes) crosses up front, and each file's bytes are pulled
// on demand mid-run through the same bounded block cache. epubcheck's own
// expanded mode then zips the tree into a temp packaged copy inside the
// engine's in-memory filesystem before validating it (that is the jar's
// architecture too, on disk), so peak engine memory tracks the PACKAGED
// (compressed) book size, not the unpacked tree.

// Polyfill-safe well-known dispose key. Native engines (Node, Chrome, Firefox)
// expose Symbol.dispose; stock Safari does not, so fall back to the
// globally-registered Symbol.for('Symbol.dispose'). This is EXACTLY the key
// both esbuild's lowering (its `__knownSymbol("dispose")` helper) and the
// standard TypeScript-downlevel Symbol.dispose polyfill look up, so a `using`
// declaration in a transpiled consumer finds this method under the same key on
// every engine. On engines with native Symbol.dispose the two are identical.
const DISPOSE: typeof Symbol.dispose =
  Symbol.dispose ?? (Symbol.for('Symbol.dispose') as typeof Symbol.dispose);

// Type-only: the async http bridge contract the `url` input source's
// openBridge() returns (implemented by http-bridge.ts -- a disk-spool fetch
// bridge in Node, an in-memory fetch bridge everywhere else; imported lazily
// at run time).
import type { HttpBridge } from './http-bridge.js';
export type { HttpBridge } from './http-bridge.js';

/**
 * The byte-source contract every epubcheck-standalone entry point consumes.
 * Stable public API -- implement it yourself to plug in any storage.
 *
 * `read` fills synchronously (the fast path, consumed inline) or returns a
 * promise (the engine suspends mid-run until it resolves -- how File/Blob
 * sources validate on the browser main thread). It is never asked past EOF
 * and never asked for more than 8 MiB at once. The returned view is only
 * guaranteed valid until the next `read` call (plugins may reuse an internal
 * scratch buffer).
 */
export interface RangeSource {
  /** Total size in bytes. */
  size: number;
  /**
   * Optional display name the source carries with it (e.g. a picked File's
   * `name`). When present, the higher-level entry points that accept a source
   * -- `runEpubcheck({ source })` and `validate(source, ...)` -- use it as the
   * default reported name, so callers do not have to thread the name by hand.
   * An explicit `name` option always overrides it. Sources with no natural name
   * (memory, a bare Blob) omit it.
   */
  name?: string;
  /**
   * The REAL parent directory of this source on the host, when it has one (the
   * Node `fs` plugin sets it for an absolute path). The run driver forwards it
   * to the engine, which mounts the input and its working directory there
   * instead of an internal "/work", so epubcheck's no-container single-file
   * error text (FATAL PKG-008 "Unable to read file") prints the host path
   * exactly like the native jar. Sources with no host directory (a Blob, an
   * injected/browser fs, a relative path) omit it -- the engine then keeps its
   * internal-path behavior unchanged.
   */
  hostDir?: string;
  /**
   * The input is actually a DIRECTORY handed to the single-file path (the CLI's
   * `--mode xhtml <dir>` and friends). The engine mounts it as an empty
   * directory rather than reading `size`/`read`, so epubcheck reports the same
   * FATAL(PKG-008) with the trailing-slash directory location the jar prints.
   * Set together with `hostDir`; `size` is ignored and `read` is never called.
   */
  isDirectory?: boolean;
  /**
   * Return exactly the bytes [offset, offset + length) -- synchronously (the
   * fast path) or as a promise of them (the engine suspends until it
   * resolves).
   */
  read(offset: number, length: number): Uint8Array | Promise<Uint8Array>;
  /**
   * Release any underlying handle (fd, sync access handle). This is the TC39
   * explicit-resource-management hook, so a `using source = await fs(path)`
   * declaration disposes it automatically at scope exit -- the `fs`/`opfs`
   * plugins also self-dispose on GC as a belt-and-braces net, but disposal is
   * the contract, not the fallback. Plugins with nothing to release (blob,
   * memory) implement it as a no-op so `using` works uniformly.
   */
  [DISPOSE](): void;
}

/**
 * The synchronous fs surface -- four fd-positional calls. This is the
 * COMPATIBILITY FLOOR the `fs` plugin falls back to for a sync-only backend;
 * node:fs satisfies it, so does a sync-only ZenFS. When a backend also (or
 * only) offers the promise-based API below, the plugin prefers that one.
 */
export interface FsLike {
  openSync(path: string, flags: 'r'): number;
  fstatSync(fd: number): { size: number };
  readSync(
    fd: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): number;
  closeSync(fd: number): void;
}

/**
 * One open file handle in the promise-based fs API (node:fs/promises's
 * FileHandle shape; ZenFS mirrors it). `read` fills the given buffer at
 * [offset, offset + length) from `position` and resolves with how many bytes
 * landed; `stat` gives the total size; `close` releases the handle.
 */
export interface FileHandleLike {
  stat(): Promise<{ size: number }>;
  read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

/**
 * The promise-based fs surface the `fs` plugin PREFERS: a single async `open`
 * returning a {@link FileHandleLike}. `node:fs/promises` is exactly this shape,
 * and `node:fs` carries it under a `.promises` namespace (see {@link FsBackend}).
 * An async-only backend (a promises-only ZenFS, a cloud store) implements just
 * this -- its reads return promises and the engine suspends per cache-miss block.
 */
export interface FsPromisesLike {
  open(path: string, flags: 'r'): Promise<FileHandleLike>;
}

/**
 * What `fs(path, { fs })` accepts, typed honestly (no `any`): the preferred
 * promise-based API ({@link FsPromisesLike}) directly, a module that carries it
 * under `.promises` (this is `node:fs`), and/or the synchronous fallback
 * surface ({@link FsLike}). node:fs matches every arm; a promises-only backend
 * matches the first two; a sync-only backend matches the last.
 */
export type FsBackend =
  | FsPromisesLike
  | { promises: FsPromisesLike }
  | FsLike;

/** Does this backend expose the four synchronous fd calls? (fallback route) */
function hasSyncFsApi(impl: FsBackend): impl is FsLike {
  const o = impl as Partial<FsLike>;
  return (
    typeof o.openSync === 'function' &&
    typeof o.fstatSync === 'function' &&
    typeof o.readSync === 'function' &&
    typeof o.closeSync === 'function'
  );
}

/**
 * Resolve the PREFERRED promise-based API from a backend, or null if it has
 * none. A backend's own `.promises.open` (node:fs, ZenFS `fs`) wins first; a
 * backend that IS a promises namespace (`open` present, node:fs/promises) is
 * used directly, but only when it has no sync fd methods -- that guard dodges
 * node's callback-based `fs.open`, which is also a function yet returns no
 * promise (node:fs is always reached via its `.promises` namespace instead).
 */
function resolvePromisesApi(impl: FsBackend): FsPromisesLike | null {
  const ns = (impl as { promises?: { open?: unknown } }).promises;
  if (ns && typeof ns.open === 'function') return ns as FsPromisesLike;
  if (typeof (impl as { open?: unknown }).open === 'function' && !hasSyncFsApi(impl)) {
    return impl as FsPromisesLike;
  }
  return null;
}

interface CleanupGuard {
  disposed: boolean;
  release: () => void;
}

// Belt-and-braces cleanup: if a consumer forgets to dispose a source that owns
// a resource (the `fs` fd, the `opfs` sync access handle), release it when the
// source object is garbage-collected. Disposal remains the documented contract
// -- disposing unregisters the source, so the registry never runs for a
// correctly-disposed source and the resource is never released twice. The
// registry holds only a tiny guard ({ disposed, release }) carrying the
// low-level resource -- NEVER the source object -- so registering a source
// cannot keep it alive, which is exactly what lets GC-triggered cleanup happen
// at all.
const cleanupRegistry =
  typeof FinalizationRegistry === 'function'
    ? new FinalizationRegistry<CleanupGuard>((guard) => {
        if (guard.disposed) return;
        guard.disposed = true;
        guard.release();
      })
    : null;

// Attach the GC safety net above to `source`. `rawRelease` releases the
// underlying resource; the installed `[Symbol.dispose]()` runs it eagerly
// (once) and detaches the finalizer. Returns `source` for convenient
// `return withCleanup(...)`. Works for range and directory sources alike --
// anything carrying the dispose-key method.
function withCleanup<T extends { [DISPOSE](): void }>(source: T, rawRelease: () => void): T {
  const guard: CleanupGuard = { disposed: false, release: rawRelease };
  const token = {};
  source[DISPOSE] = (): void => {
    if (guard.disposed) return;
    guard.disposed = true;
    if (cleanupRegistry) cleanupRegistry.unregister(token);
    rawRelease();
  };
  if (cleanupRegistry) cleanupRegistry.register(source, guard, token);
  return source;
}

/**
 * Range source over a File or Blob. Reads are ASYNC on every thread: `read`
 * returns a promise from `blob.slice(offset, end).arrayBuffer()` and the engine
 * SUSPENDS mid-run until it resolves -- the same pause mechanism URL downloads
 * use. `Blob.slice().arrayBuffer()` is main-thread-legal in every browser, so
 * File/Blob validation works on the browser MAIN thread and in Workers alike
 * with no thread blocking (the library spawns no Worker either way).
 *
 * A user-picked File or a `fetch(...).then((r) => r.blob())` is disk-backed by
 * the browser, and `blob.slice()` reads lazily, so this plugin only ever pulls
 * the requested range from the Blob -- the engine streams those ranges mid-run
 * (see the module's MEMORY MODEL note), so multi-GB books validate from a Blob
 * without ever being loaded whole.
 *
 * The same holds for IndexedDB: IDB stores Blobs natively, and browsers back
 * large stored Blobs with disk files, so a Blob read back from IndexedDB keeps
 * the lazy `slice()` behavior. Store the book as a Blob in IDB and hand it
 * straight to this plugin -- no extra copy on the plugin side.
 */
export function blob(fileOrBlob: Blob): RangeSource {
  const source: RangeSource = {
    size: fileOrBlob.size,
    // Async everywhere: slice the requested range and await its bytes. The
    // engine suspends per cache-miss block while the promise settles.
    read: async (offset, length) =>
      new Uint8Array(await fileOrBlob.slice(offset, offset + length).arrayBuffer()),
    // Nothing to release (the Blob is browser-managed); dispose is a no-op so
    // `using source = blob(file)` works uniformly with the handle-owning plugins.
    [DISPOSE]() {},
  };
  // A File carries a name; a bare Blob does not. Surface it so the higher-level
  // entry points can default the reported name from the source.
  const maybeName = (fileOrBlob as File).name;
  if (typeof maybeName === 'string' && maybeName.length > 0) source.name = maybeName;
  return source;
}

/**
 * URL input source -- the jar-parity remote-input mode. `validate(await
 * url('https://host/book.epub'))` hands the URL to epubcheck as the ACTUAL
 * input path (exactly like `java -jar epubcheck.jar <url>`): the engine
 * performs the GET itself mid-run -- its Java green thread SUSPENDS at a
 * TeaVM @Async seam while the host runs a plain async fetch, then resumes
 * with the response -- so message locations reference the URL (matching what
 * the official jar prints) and HTTP/network failures surface with the jar's
 * exception headlines. No worker threads, no SharedArrayBuffer, no sync XHR:
 * the host event loop stays free during the download.
 *
 * Unlike every other source this is not a byte source the caller reads -- the
 * bytes never pass through library-user code. `openBridge` is internal: the
 * run driver calls it to install the platform bridge for the run's duration.
 */
export interface UrlSource {
  /** The http(s) URL epubcheck validates (the input path it sees and reports). */
  url: string;
  /**
   * Internal: create the platform async http bridge for one run (Node: fetch
   * streaming to a disk spool -- no threads, no size cap; everywhere else:
   * fetch with the body held in memory -- works on the browser MAIN thread
   * and in Workers alike).
   */
  openBridge(): Promise<HttpBridge>;
  /** Nothing to release before a run; the run driver closes the bridge itself. */
  [DISPOSE](): void;
}

/** Is this value a URL input source (as opposed to a range/directory source)? */
export function isUrlSource(value: unknown): value is UrlSource {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as UrlSource).url === 'string' &&
    typeof (value as UrlSource).openBridge === 'function' &&
    typeof (value as { read?: unknown }).read !== 'function'
  );
}

/**
 * Build the URL input source for an http(s) URL. See {@link UrlSource}: the
 * URL itself is the input epubcheck sees, so message locations carry the URL
 * (jar parity) and the body is downloaded mid-run over an async fetch while
 * the engine is suspended -- spooled to disk in Node (no whole-body-in-memory,
 * no size cap) and held in memory in browsers (subject to the target server's
 * CORS policy there). Redirects are followed before the final status is
 * reported, matching the jar's HttpURLConnection default.
 *
 * The event loop stays FREE while the engine downloads (the engine suspends;
 * the fetch is plain async), so a URL served by an in-process server
 * validates from the same thread, and browsers can validate URL inputs on
 * the MAIN thread -- no Worker required, and the library spawns none.
 */
export async function url(input: string): Promise<UrlSource> {
  if (typeof input !== 'string' || !/^https?:\/\//.test(input)) {
    throw new Error(`url: "${input}" is not an http(s) URL`);
  }
  return {
    url: input,
    async openBridge(): Promise<HttpBridge> {
      // Node gets the disk-spool bridge (flat memory for multi-GB downloads);
      // everywhere else the in-memory fetch bridge. Neither spawns a thread.
      const isNode =
        typeof process !== 'undefined' &&
        typeof process.versions?.node === 'string' &&
        typeof (globalThis as { importScripts?: unknown }).importScripts !== 'function';
      const bridge = await import('./http-bridge.js');
      return isNode ? bridge.createHttpBridgeNode() : bridge.createHttpBridgeFetch();
    },
    [DISPOSE]() {},
  };
}

/**
 * Range source over a Uint8Array already in memory. Only sensible for SMALL
 * bundled files (the whole book sits in RAM); prefer blob/opfs/fs otherwise.
 */
export function memory(bytes: Uint8Array): RangeSource {
  return {
    size: bytes.length,
    read: (offset, length) => bytes.subarray(offset, offset + length),
    // The bytes are already in RAM; nothing to release, so dispose is a no-op.
    [DISPOSE]() {},
  };
}

/** Does this value look like a FileSystemFileHandle (kind "file" + getFile)? */
function isFileSystemFileHandle(value: unknown): value is FileSystemFileHandle {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === 'file' &&
    typeof (value as { getFile?: unknown }).getFile === 'function'
  );
}

/**
 * Range source over a file in OPFS (origin private file system). Async-first,
 * so it works on the browser MAIN thread as well as in Workers: the file is
 * resolved to a `FileSystemFileHandle`, `getFile()` gives a `File` (a Blob
 * snapshot), and each read awaits `file.slice(offset, end).arrayBuffer()` --
 * byte-for-byte the same technique as `blob()`, so the engine suspends per
 * cache-miss block. `getFile()` is main-thread-legal in every browser that has
 * OPFS at all (Chrome/Edge 86+, Firefox 111+, Safari 15.2+); Safari's OPFS gap
 * is on WRITING, and this plugin only reads.
 *
 * Accepts:
 *   - an OPFS path string ("dir/book.epub", resolved from the OPFS root) --
 *     the primary, any-thread route;
 *   - a `FileSystemFileHandle` directly (the natural input for a main-thread
 *     caller who already holds one) -- also the async any-thread route;
 *   - an already-created `FileSystemSyncAccessHandle` -- the one SYNCHRONOUS
 *     carve-out: you cannot obtain a `File` from a sync access handle, so this
 *     input reads through the handle's synchronous `read` loop and is therefore
 *     dedicated-Worker-only (sync access handles exist nowhere else, by spec).
 *
 * The factory is async (resolving/opening the file awaits). Disposal closes the
 * sync access handle only when this plugin opened it; the async `File` route
 * has nothing to release (the File is browser-managed), so dispose is a no-op.
 */
export async function opfs(
  pathOrHandle: string | FileSystemFileHandle | FileSystemSyncAccessHandle,
): Promise<RangeSource> {
  // ASYNC PRIMARY PATH: a path string or a FileSystemFileHandle -> a File ->
  // slice().arrayBuffer() reads. Works on the main thread and in Workers.
  let fileHandle: FileSystemFileHandle | null = null;
  if (typeof pathOrHandle === 'string') {
    let dir = await navigator.storage.getDirectory();
    const parts = pathOrHandle.split('/').filter(Boolean);
    for (let i = 0; i < parts.length - 1; i++) {
      dir = await dir.getDirectoryHandle(parts[i]!, { create: false });
    }
    fileHandle = await dir.getFileHandle(parts[parts.length - 1]!, { create: false });
  } else if (isFileSystemFileHandle(pathOrHandle)) {
    fileHandle = pathOrHandle;
  }
  if (fileHandle) {
    const file = await fileHandle.getFile();
    const source: RangeSource = {
      size: file.size,
      read: async (offset, length) =>
        new Uint8Array(await file.slice(offset, offset + length).arrayBuffer()),
      // The File is browser-managed; nothing to release, so dispose is a no-op.
      [DISPOSE]() {},
    };
    // Default the reported name from the file (a string path resolves to a
    // handle named by its last segment; a passed FileSystemFileHandle carries
    // its own name). Matches blob()/fs()/opfsDir(); an explicit `name` wins.
    if (file.name.length > 0) source.name = file.name;
    return source;
  }

  // SYNC CARVE-OUT: a caller-supplied FileSystemSyncAccessHandle. No File can be
  // obtained from it, so it reads synchronously and stays Worker-only. (A string
  // and a FileSystemFileHandle both take the async path above, so anything left
  // here is a sync access handle.)
  const handle = pathOrHandle as FileSystemSyncAccessHandle;
  const source: RangeSource = {
    size: handle.getSize(),
    read: (offset, length) => {
      const buf = new Uint8Array(length);
      let done = 0;
      while (done < length) {
        const n = handle.read(buf.subarray(done), { at: offset + done });
        if (n <= 0) throw new Error(`short OPFS read at ${offset + done}`);
        done += n;
      }
      return buf;
    },
    // Replaced by withCleanup below with the disposal that unregisters the GC
    // net; this placeholder just satisfies the RangeSource contract.
    [DISPOSE]() {},
  };
  // A caller-supplied sync handle is the caller's to own; leave it open (this
  // plugin did not create it). The GC net and dispose therefore do nothing to
  // it, matching the pre-async behavior for a passed-in handle.
  return withCleanup(source, () => {});
}

/**
 * Range source over a file on a filesystem, using positional reads -- the file
 * stays on disk and the plugin only ever holds the requested range, which the
 * engine streams mid-run (see the MEMORY MODEL note at the top of this module)
 * -- multi-GB books validate at flat memory.
 *
 * By default the implementation is node:fs (imported lazily, so this module
 * stays importable in the browser). Pass `options.fs` to inject ANY
 * fs-compatible implementation instead -- the motivating case is ZenFS in the
 * browser (zip mounts, IndexedDB stores, cloud backends).
 *
 * The plugin PREFERS a promise-based FileHandle API and only falls back to the
 * synchronous one:
 *
 *   PREFERRED -- the node:fs/promises shape ({@link FsPromisesLike}), reached
 *   via the backend's `.promises` namespace (node:fs, ZenFS `fs`) or on the
 *   backend directly (node:fs/promises, a promises-only store):
 *     open(path, 'r') -> Promise<FileHandle>
 *     FileHandle.stat() -> Promise<{ size }>
 *     FileHandle.read(buffer, offset, length, position) -> Promise<{ bytesRead }>
 *     FileHandle.close() -> Promise<void>
 *   Reads return promises, so the engine suspends per cache-miss block -- which
 *   is what lets an ASYNC-ONLY backend back this plugin end to end (the factory
 *   is already awaited, so opening and stat-ing the size up front may await too).
 *
 *   FALLBACK -- the four synchronous, fd-positional calls of {@link FsLike}
 *   (openSync/fstatSync/readSync/closeSync), used when the backend exposes no
 *   promise-based `open`. Reads stay synchronous (the engine never suspends).
 *
 * An UNREADABLE file (open fails with EACCES/EPERM) is DEFERRED, not thrown:
 * this returns a source whose every read throws the Java-shaped
 * "<path> (Permission denied)" (or "(Operation not permitted)" for EPERM)
 * message, so EPUBCheck reports it as FATAL(PKG-008) itself -- byte-identical
 * to the jar (localization included), exactly as the native jar defers the
 * lazy open inside the checker. Any OTHER open failure still throws (fail
 * fast). The deferred source carries the same name and host directory a
 * readable one would, so the reported path matches too.
 *
 * Nothing else is touched. `read` loops on short reads; the returned view
 * reuses an internal scratch buffer (valid until the next `read`).
 */
export async function fs(
  path: string,
  options: { fs?: FsBackend } = {},
): Promise<RangeSource> {
  const impl: FsBackend = options.fs || ((await import('node:fs')) as unknown as FsBackend);

  let source: RangeSource;
  let release: () => void;

  const promises = resolvePromisesApi(impl);
  if (promises) {
    // PREFERRED PATH: promise-based FileHandle. Opening and stat-ing the size
    // happen up front (the factory is awaited by callers); each read resolves a
    // promise, so the engine suspends per cache-miss block.
    let handle: FileHandleLike;
    try {
      handle = await promises.open(path, 'r');
    } catch (e) {
      // Unreadable file (EACCES/EPERM): DEFER the error into the run like the
      // jar instead of throwing at open -- see deferUnreadable.
      return deferUnreadable(path, e, options);
    }
    const size = (await handle.stat()).size;
    let scratch = new Uint8Array(0);
    source = {
      size,
      read: async (offset, length) => {
        if (scratch.length < length) scratch = new Uint8Array(length);
        let done = 0;
        while (done < length) {
          const { bytesRead } = await handle.read(scratch, done, length - done, offset + done);
          if (bytesRead <= 0) throw new Error(`short read at ${offset + done} (wanted ${length})`);
          done += bytesRead;
        }
        return scratch.subarray(0, length);
      },
      // Replaced by withCleanup below; this placeholder satisfies the contract.
      [DISPOSE]() {},
    };
    // close() is async; disposal is synchronous, so fire it and swallow any
    // rejection (nothing awaits the fd close, and the run is already over).
    release = (): void => {
      const p = handle.close();
      if (p && typeof p.then === 'function') p.catch(() => {});
    };
  } else if (hasSyncFsApi(impl)) {
    // FALLBACK PATH: synchronous fd-positional reads -- byte-and-timing
    // identical to the original sync-only plugin.
    let fd: number;
    try {
      fd = impl.openSync(path, 'r');
    } catch (e) {
      // Unreadable file (EACCES/EPERM): DEFER the error into the run like the
      // jar instead of throwing at open -- see deferUnreadable.
      return deferUnreadable(path, e, options);
    }
    const size = impl.fstatSync(fd).size;
    let scratch = new Uint8Array(0);
    source = {
      size,
      read: (offset, length) => {
        if (scratch.length < length) scratch = new Uint8Array(length);
        let done = 0;
        while (done < length) {
          const n = impl.readSync(fd, scratch, done, length - done, offset + done);
          if (n <= 0) throw new Error(`short read at ${offset + done} (wanted ${length})`);
          done += n;
        }
        return scratch.subarray(0, length);
      },
      // Replaced by withCleanup below; this placeholder satisfies the contract.
      [DISPOSE]() {},
    };
    release = (): void => impl.closeSync(fd);
  } else {
    throw new Error(
      'fs: the injected fs exposes neither a promise-based open() (node:fs/promises ' +
        'shape) nor the synchronous fd API (openSync/fstatSync/readSync/closeSync) -- ' +
        'cannot back the fs() source',
    );
  }

  // Carry the file's basename as the reported name, so `validate(await fs(path))`
  // reports message locations under the file name (like the old validateFile),
  // plus the real host parent dir so the engine can print the host path in
  // no-container single-file errors.
  attachFsMeta(source, path, !!options.fs);
  return withCleanup(source, release);
}

/**
 * Attach the reported name (the path's last segment) and, when the path is a
 * real host path (default node:fs + POSIX-absolute; see {@link hostParentDir}),
 * the host parent directory. Shared by the readable and the deferred-unreadable
 * fs() sources so both report identical name/path metadata.
 */
function attachFsMeta(source: RangeSource, path: string, injected: boolean): void {
  const base = lastSegment(path);
  if (base.length > 0) source.name = base;
  const hostDir = hostParentDir(path, injected);
  if (hostDir !== undefined) source.hostDir = hostDir;
}

/**
 * Build the DEFERRED source for an unreadable file, matching the jar. Called
 * when fs()'s open() fails: if the failure is EACCES or EPERM ONLY, hand the
 * engine a source whose every read throws the Java-shaped message
 * `<path> (Permission denied)` (or `(Operation not permitted)` for EPERM), so
 * EPUBCheck surfaces it as FATAL(PKG-008) itself -- byte-identical to the jar's
 * lazy-open failure, localization included. Any OTHER open error is rethrown
 * (fail fast). The source carries the same name + hostDir a readable one would.
 */
async function deferUnreadable(
  path: string,
  err: unknown,
  options: { fs?: FsBackend },
): Promise<RangeSource> {
  const code = (err as { code?: string } | undefined)?.code;
  if (code !== 'EACCES' && code !== 'EPERM') throw err;
  const reason = code === 'EPERM' ? 'Operation not permitted' : 'Permission denied';
  const message = `${path} (${reason})`;
  // stat needs no read permission; floor the size at 1 so the engine attempts a
  // read (hitting the throw below) even on an empty unreadable file. Async per
  // the async law; when there is no host stat to consult (an injected/browser
  // backend, where EACCES/EPERM are not real host permission codes) the floor
  // stands on its own.
  let size = 1;
  try {
    const p = await import('node:fs/promises');
    size = Math.max((await p.stat(path)).size, 1);
  } catch {
    // No host stat available -> keep the floor of 1.
  }
  const source: RangeSource = {
    size,
    read: () => {
      throw new Error(message);
    },
    // Nothing was opened, so there is nothing to release.
    [DISPOSE]() {},
  };
  attachFsMeta(source, path, !!options.fs);
  return withCleanup(source, () => {});
}

// ============================================================================
// Directory sources -- expanded (unzipped) EPUBs, epubcheck's --mode exp.
// ============================================================================

/** One file in a directory source's listing. */
export interface DirectoryEntry {
  /** Relative '/'-separated path inside the directory (never absolute, no ".."). */
  path: string;
  /** That file's size in bytes. */
  size: number;
}

/**
 * The byte-source contract for EXPANDED (unzipped) EPUB directories --
 * epubcheck's `--mode exp`. Stable public API, the directory sibling of
 * `RangeSource`: implement it yourself to plug in any storage.
 *
 * `list()` returns every file as a relative '/'-separated path with its size
 * (directories are implied by the paths). `read` fills synchronously (the
 * fast path, consumed inline) or returns a promise (the engine suspends
 * mid-run until it resolves -- the same pause mechanism as an async
 * RangeSource read). It is only asked for listed paths, is never asked past
 * a file's listed size, and is never asked for more than 8 MiB at once. The
 * returned view is only guaranteed valid until the next `read` call.
 */
export interface DirectorySource {
  /**
   * Optional display name (the directory's own name, e.g. a dropped folder's).
   * Used exactly like a RangeSource's name: the higher-level entry points
   * default the reported name from it; an explicit `name` option wins.
   */
  name?: string;
  /**
   * The REAL parent directory of this directory on the host, when it has one
   * (the Node `fsDir` plugin sets it for an absolute path). Forwarded to the
   * engine exactly like {@link RangeSource.hostDir}, so any no-container path
   * epubcheck prints is the host path, not an internal one. Omitted for
   * browser/injected directory sources.
   */
  hostDir?: string;
  /** Every file in the directory, as { path, size } entries. */
  list(): DirectoryEntry[];
  /**
   * Return exactly the bytes [offset, offset + length) of one listed file --
   * synchronously (the fast path) or as a promise of them (the engine
   * suspends until it resolves).
   */
  read(path: string, offset: number, length: number): Uint8Array | Promise<Uint8Array>;
  /**
   * Release any underlying handles (fds, OPFS sync access handles) -- the same
   * TC39 explicit-resource-management contract as RangeSource, under the same
   * polyfill-safe key. Sources with nothing to release implement it as a no-op.
   */
  [DISPOSE](): void;
}

/** Is this value a directory source (as opposed to a range source or a Blob)? */
export function isDirectorySource(value: unknown): value is DirectorySource {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as DirectorySource).list === 'function' &&
    typeof (value as DirectorySource).read === 'function'
  );
}

/**
 * Reject anything that could escape the directory root when the engine mounts
 * the listing: absolute paths, backslashes, and empty/"."/".." segments. The
 * Java side enforces the same rules again (neither side trusts the other).
 */
/**
 * A bounded-concurrency limiter shared across a whole recursive directory walk.
 * Same idea as the lane pool in teavm/reports-teavm.ts, but a shared permit
 * budget (rather than a flat lane count) so recursion at any depth cannot fan
 * out past the cap and exhaust file descriptors. `run(fn)` waits for a permit,
 * runs `fn`, and releases the permit — no permit is ever held across a nested
 * `run`, so the recursive walks below cannot deadlock.
 */
function createConcurrencyLimiter(limit: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let permits = limit;
  const waiters: (() => void)[] = [];
  const acquire = (): Promise<void> => {
    if (permits > 0) {
      permits -= 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => waiters.push(resolve));
  };
  const release = (): void => {
    const next = waiters.shift();
    if (next) next(); // hand the permit straight to the next waiter
    else permits += 1;
  };
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    await acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  };
}

/**
 * Concurrency cap for directory-walk metadata gathering (stat / getFile). The
 * walk order is preserved deterministically regardless of this value (results
 * are reassembled by sorted index), so this only bounds in-flight IO.
 */
const DIR_WALK_CONCURRENCY = 16;

function assertSafeRelativePath(path: string, plugin: string): void {
  const bad = (): never => {
    throw new Error(
      `${plugin}: unsafe relative path "${path}" -- paths must be relative, ` +
        `'/'-separated, with no empty, ".", or ".." segments and no backslashes`,
    );
  };
  if (typeof path !== 'string' || path.length === 0) bad();
  if (path.startsWith('/') || path.includes('\\')) bad();
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') bad();
  }
}

/** Shared guard: a File/Blob is a single file, never a directory. */
function assertNotBlob(value: unknown, plugin: string, hint: string): void {
  if (typeof Blob !== 'undefined' && value instanceof Blob) {
    throw new Error(
      `${plugin}: got a single File/Blob where a DIRECTORY is required. ${hint}`,
    );
  }
}

/** The last path segment ('' when there is none), for defaulting names. */
function lastSegment(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
}

/**
 * The REAL host parent directory to attach to a Node fs source (see
 * RangeSource.hostDir / EngineRun.hostDir). Returns undefined -- so the engine
 * keeps its internal-path behavior (graceful degradation) -- when an fs backend
 * is INJECTED (its "paths" are not real host paths) or the path is not a POSIX
 * absolute path (a relative path has no host cwd to report; Windows drive paths
 * are left on the internal mount, preserving today's behavior there). For an
 * absolute path it is the parent directory, so that <hostDir>/<lastSegment> ===
 * the path the caller gave (which is what lets the engine reconstruct the exact
 * host path from the bare name).
 */
function hostParentDir(path: string, injected: boolean): string | undefined {
  if (injected || !path.startsWith('/')) return undefined;
  const cleaned = path.replace(/\/+$/, '');
  const idx = cleaned.lastIndexOf('/');
  return idx <= 0 ? '/' : cleaned.slice(0, idx);
}

/**
 * The synchronous fs surface the `fsDir` plugin FALLS BACK to for a sync-only
 * backend: the four fd-positional calls of {@link FsLike} plus a dirent walk
 * and a stat by path. node:fs satisfies it; so does a sync-only ZenFS. When a
 * backend also (or only) offers the promise-based API below, the plugin prefers
 * that one. This is the compatibility floor, exactly as {@link FsLike} is for
 * the `fs` range source.
 */
export interface FsDirLike extends FsLike {
  readdirSync(
    path: string,
    options: { withFileTypes: true },
  ): Array<{ name: string; isDirectory(): boolean }>;
  statSync(path: string): { size: number; isDirectory(): boolean };
}

/**
 * The promise-based fs surface the `fsDir` plugin PREFERS: the async `open` of
 * {@link FsPromisesLike} (returning a {@link FileHandleLike} for positional
 * reads) plus an async dirent walk and an async stat by path. `node:fs/promises`
 * is exactly this shape, and `node:fs` carries it under a `.promises` namespace
 * (see {@link FsDirBackend}). An async-only backend (a promises-only ZenFS, a
 * cloud store) implements just this -- its reads return promises and the engine
 * suspends per cache-miss block, exactly as the `fs` range source does.
 */
export interface FsDirPromisesLike extends FsPromisesLike {
  readdir(
    path: string,
    options: { withFileTypes: true },
  ): Promise<Array<{ name: string; isDirectory(): boolean }>>;
  stat(path: string): Promise<{ size: number; isDirectory(): boolean }>;
}

/**
 * What `fsDir(path, { fs })` accepts, typed honestly (no `any`) -- the directory
 * sibling of {@link FsBackend}: the preferred promise-based API
 * ({@link FsDirPromisesLike}) directly, a module that carries it under
 * `.promises` (this is `node:fs`), and/or the synchronous fallback surface
 * ({@link FsDirLike}). node:fs matches every arm; a promises-only backend
 * matches the first two; a sync-only backend matches the last.
 */
export type FsDirBackend =
  | FsDirPromisesLike
  | { promises: FsDirPromisesLike }
  | FsDirLike;

/** Does this backend expose the synchronous dir surface? (fallback route) */
function hasSyncFsDirApi(impl: FsDirBackend): impl is FsDirLike {
  const o = impl as Partial<FsDirLike>;
  return (
    hasSyncFsApi(o as FsBackend) &&
    typeof o.readdirSync === 'function' &&
    typeof o.statSync === 'function'
  );
}

/**
 * Resolve the PREFERRED promise-based dir API from a backend, or null if it has
 * none. Reuses {@link resolvePromisesApi} to find the promises namespace (the
 * backend's own `.promises`, or the backend itself when it IS a promises
 * namespace with no sync fd methods), then confirms that namespace also carries
 * the async `readdir`/`stat` the directory walk needs.
 */
function resolveDirPromisesApi(impl: FsDirBackend): FsDirPromisesLike | null {
  const base = resolvePromisesApi(impl as FsBackend) as Partial<FsDirPromisesLike> | null;
  if (base && typeof base.readdir === 'function' && typeof base.stat === 'function') {
    return base as FsDirPromisesLike;
  }
  return null;
}

/**
 * Directory source over an expanded EPUB directory on a filesystem (Node's
 * node:fs by default; inject any fs-compatible implementation via
 * `options.fs`). Async-first, mirroring the `fs` range source exactly: the
 * plugin PREFERS a promise-based FileHandle API and only falls back to the
 * synchronous one.
 *
 *   PREFERRED -- the node:fs/promises shape ({@link FsDirPromisesLike}), reached
 *   via the backend's `.promises` namespace (node:fs, ZenFS `fs`) or on the
 *   backend directly (node:fs/promises, a promises-only store): an async
 *   `readdir`/`stat` walk, then per-file positional reads through
 *   `open(path, 'r') -> FileHandle.read(...)`. Reads return promises, so the
 *   engine suspends per cache-miss block at the directory feed seam -- which is
 *   what lets an ASYNC-ONLY backend (a promises-only ZenFS, a cloud store) back
 *   this plugin end to end. Even the default node:fs takes this path (it carries
 *   a `.promises` namespace), so validating an expanded book keeps the Node
 *   event loop free instead of blocking on every 8 MiB block.
 *
 *   FALLBACK -- the synchronous {@link FsDirLike} surface
 *   (openSync/fstatSync/readSync/closeSync plus readdirSync/statSync), used only
 *   when the backend exposes no promise-based `open`. Reads stay synchronous
 *   (the engine never suspends). This is the compatibility floor for sync-only
 *   stores, the async-law-legitimate case: there is no async equivalent to fall
 *   through to when the backend offers none.
 *
 * Either way the factory walks the tree ONCE (sorted, deterministic listing);
 * reads are lazy positional reads on the one file currently being pulled, so at
 * most one fd/handle is open at a time and the plugin only ever holds the
 * requested range, which the engine pulls on demand mid-run (see the MEMORY
 * MODEL note). Disposal releases that fd/handle.
 */
export async function fsDir(
  path: string,
  options: { fs?: FsDirBackend } = {},
): Promise<DirectorySource> {
  assertNotBlob(path, 'fsDir', 'Pass a directory PATH; for a single .epub file use the fs() range source.');
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error('fsDir: path must be a non-empty directory path string');
  }
  const impl: FsDirBackend = options.fs || ((await import('node:fs')) as unknown as FsDirBackend);
  const root = path.replace(/[\\/]+$/, '') || path;
  const entries: DirectoryEntry[] = [];

  let source: DirectorySource;
  let release: () => void;

  const promises = resolveDirPromisesApi(impl);
  if (promises) {
    // PREFERRED PATH: promise-based readdir/stat walk + FileHandle reads. The
    // factory is awaited by callers, so the walk and the size stats await up
    // front; each read resolves a promise, so the engine suspends per block.
    if (!(await promises.stat(path)).isDirectory()) {
      throw new Error(
        `fsDir: "${path}" is not a directory -- for a single .epub file use the fs() range source`,
      );
    }
    // Gather per-entry stats (and independent sibling subtrees) concurrently,
    // bounded by a shared permit budget, then REASSEMBLE strictly by the
    // sorted-dirent index. The returned array is a pre-order DFS in the exact
    // same order the old sequential walk produced, so the `entries` handed to
    // the engine (paths + sizes) stay byte-identical -- load-bearing for
    // exp-mode zip byte-identity and directory validation. The sort, DFS shape,
    // and safe-path guard are unchanged; only the stat IO is parallelized.
    const limit = createConcurrencyLimiter(DIR_WALK_CONCURRENCY);
    const walk = async (relPrefix: string): Promise<DirectoryEntry[]> => {
      const dirPath = relPrefix ? `${root}/${relPrefix}` : root;
      const dirents = await limit(() => promises.readdir(dirPath, { withFileTypes: true }));
      dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      const perDirent = await Promise.all(
        dirents.map(async (dirent): Promise<DirectoryEntry[]> => {
          const rel = relPrefix ? `${relPrefix}/${dirent.name}` : dirent.name;
          // stat (not the dirent) so symlinks resolve to what they point at.
          const stat = await limit(() => promises.stat(`${root}/${rel}`));
          if (dirent.isDirectory() || stat.isDirectory()) {
            return walk(rel);
          }
          assertSafeRelativePath(rel, 'fsDir');
          return [{ path: rel, size: stat.size }];
        }),
      );
      return perDirent.flat();
    };
    entries.push(...(await walk('')));
    const sizes = new Map(entries.map((e) => [e.path, e.size]));
    // Lazy single-handle reads: the engine pulls files one at a time, so keeping
    // only the most recently read file open bounds the plugin to one handle.
    let openPath: string | null = null;
    let openHandle: FileHandleLike | null = null;
    const closeCurrent = (): Promise<void> | void => {
      if (openHandle !== null) {
        const h = openHandle;
        openPath = null;
        openHandle = null;
        return h.close();
      }
    };
    let scratch = new Uint8Array(0);
    source = {
      list: () => entries.map((e) => ({ ...e })),
      read: async (rel, offset, length) => {
        if (!sizes.has(rel)) {
          throw new Error(`fsDir: "${rel}" is not in this directory's listing`);
        }
        if (openPath !== rel) {
          await closeCurrent();
          openHandle = await promises.open(`${root}/${rel}`, 'r');
          openPath = rel;
        }
        if (scratch.length < length) scratch = new Uint8Array(length);
        let done = 0;
        while (done < length) {
          const { bytesRead } = await openHandle!.read(scratch, done, length - done, offset + done);
          if (bytesRead <= 0) throw new Error(`fsDir: short read of "${rel}" at ${offset + done} (wanted ${length})`);
          done += bytesRead;
        }
        return scratch.subarray(0, length);
      },
      // Replaced by withCleanup below; this placeholder satisfies the contract.
      [DISPOSE]() {},
    };
    // close() is async; disposal is synchronous, so fire it and swallow any
    // rejection (nothing awaits the handle close, and the run is already over).
    release = (): void => {
      const p = closeCurrent();
      if (p && typeof p.then === 'function') p.catch(() => {});
    };
  } else if (hasSyncFsDirApi(impl)) {
    // FALLBACK PATH: synchronous readdir/stat walk + fd-positional reads --
    // byte-and-timing identical to the original sync-only plugin.
    if (!impl.statSync(path).isDirectory()) {
      throw new Error(
        `fsDir: "${path}" is not a directory -- for a single .epub file use the fs() range source`,
      );
    }
    const walk = (relPrefix: string): void => {
      const dirPath = relPrefix ? `${root}/${relPrefix}` : root;
      const dirents = impl.readdirSync(dirPath, { withFileTypes: true });
      dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const dirent of dirents) {
        const rel = relPrefix ? `${relPrefix}/${dirent.name}` : dirent.name;
        // statSync (not the dirent) so symlinks resolve to what they point at.
        const stat = impl.statSync(`${root}/${rel}`);
        if (dirent.isDirectory() || stat.isDirectory()) {
          walk(rel);
        } else {
          assertSafeRelativePath(rel, 'fsDir');
          entries.push({ path: rel, size: stat.size });
        }
      }
    };
    walk('');
    const sizes = new Map(entries.map((e) => [e.path, e.size]));
    // Lazy single-fd reads: the engine pulls files one at a time, so keeping only
    // the most recently read file open bounds the plugin to one fd total.
    let openPath: string | null = null;
    let openFd = -1;
    const closeCurrent = (): void => {
      if (openPath !== null) {
        const fd = openFd;
        openPath = null;
        openFd = -1;
        impl.closeSync(fd);
      }
    };
    let scratch = new Uint8Array(0);
    source = {
      list: () => entries.map((e) => ({ ...e })),
      read: (rel, offset, length) => {
        if (!sizes.has(rel)) {
          throw new Error(`fsDir: "${rel}" is not in this directory's listing`);
        }
        if (openPath !== rel) {
          closeCurrent();
          openFd = impl.openSync(`${root}/${rel}`, 'r');
          openPath = rel;
        }
        if (scratch.length < length) scratch = new Uint8Array(length);
        let done = 0;
        while (done < length) {
          const n = impl.readSync(openFd, scratch, done, length - done, offset + done);
          if (n <= 0) throw new Error(`fsDir: short read of "${rel}" at ${offset + done} (wanted ${length})`);
          done += n;
        }
        return scratch.subarray(0, length);
      },
      // Replaced by withCleanup below; this placeholder satisfies the contract.
      [DISPOSE]() {},
    };
    release = closeCurrent;
  } else {
    throw new Error(
      'fsDir: the injected fs exposes neither a promise-based open()/readdir()/stat() ' +
        '(node:fs/promises shape) nor the synchronous dir API (openSync/fstatSync/' +
        'readSync/closeSync/readdirSync/statSync) -- cannot back the fsDir() source',
    );
  }

  const dirName = lastSegment(root);
  if (dirName.length > 0) source.name = dirName;
  // Real host parent dir (default node:fs + absolute path only): keeps any
  // no-container path epubcheck prints in host terms.
  const hostDir = hostParentDir(root, !!options.fs);
  if (hostDir !== undefined) source.hostDir = hostDir;
  return withCleanup(source, release);
}

/**
 * Directory source over an OPFS directory (a FileSystemDirectoryHandle),
 * walked recursively. Async-first, so it works on the browser MAIN thread as
 * well as in Workers: the tree is walked with the standard async directory
 * iterator, each file child's `File` is grabbed up front with `getFile()` (a
 * cheap lazy handle to bytes), and each read awaits
 * `file.slice(offset, end).arrayBuffer()` -- the same technique as the `opfs`
 * range source, so the engine suspends per cache-miss block at the directory
 * feed seam. Async directory iteration and `getFile()` are main-thread-legal
 * in every browser that has OPFS at all; Safari reads fine (its OPFS gap is on
 * writing). Nothing is opened through a sync access handle, so there are no
 * per-file handles to budget and disposal is a no-op.
 */
export async function opfsDir(
  directoryHandle: FileSystemDirectoryHandle,
): Promise<DirectorySource> {
  assertNotBlob(directoryHandle, 'opfsDir', 'Pass a FileSystemDirectoryHandle; for a single file use blob() or opfs().');
  if (
    !directoryHandle ||
    (directoryHandle as FileSystemDirectoryHandle).kind !== 'directory'
  ) {
    throw new Error(
      'opfsDir: expected a FileSystemDirectoryHandle (kind "directory") -- ' +
        'for a single OPFS file use the opfs() range source',
    );
  }
  const files = new Map<string, File>();
  // Grab each child's File (and independent sibling subtrees) concurrently,
  // bounded by a shared permit budget, then REASSEMBLE strictly by the
  // sorted-child index so the Map's insertion order is byte-identical to the
  // old sequential DFS collect. Only the getFile() snapshots are parallelized;
  // the sort, DFS shape, and safe-path guard are unchanged.
  const limit = createConcurrencyLimiter(DIR_WALK_CONCURRENCY);
  const collect = async (
    dir: FileSystemDirectoryHandle,
    prefix: string,
  ): Promise<Array<[string, File]>> => {
    // values() is the standard async-iterable directory listing; typed via a
    // narrow cast because the bundled TS worker lib does not declare it yet.
    const iter = (dir as unknown as { values(): AsyncIterable<FileSystemHandle> }).values();
    const children: FileSystemHandle[] = [];
    for await (const child of iter) children.push(child);
    children.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const perChild = await Promise.all(
      children.map(async (child): Promise<Array<[string, File]>> => {
        const rel = prefix + child.name;
        if (child.kind === 'directory') {
          return collect(child as FileSystemDirectoryHandle, rel + '/');
        }
        assertSafeRelativePath(rel, 'opfsDir');
        // A File is a cheap lazy snapshot of the bytes; grabbing them all up
        // front mirrors the old up-front open but costs no OS handle.
        const file = await limit(() => (child as FileSystemFileHandle).getFile());
        return [[rel, file]];
      }),
    );
    return perChild.flat();
  };
  for (const [rel, file] of await collect(directoryHandle, '')) files.set(rel, file);
  const source: DirectorySource = {
    list: () => Array.from(files, ([rel, file]) => ({ path: rel, size: file.size })),
    read: async (rel, offset, length) => {
      const file = files.get(rel);
      if (!file) {
        throw new Error(`opfsDir: "${rel}" is not in this directory's listing`);
      }
      return new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
    },
    // The Files are browser-managed; nothing to release, so dispose is a no-op.
    [DISPOSE]() {},
  };
  if (directoryHandle.name.length > 0) source.name = directoryHandle.name;
  return source;
}

/**
 * Directory source over an array of File objects -- the shape a folder
 * drag-and-drop or an `<input webkitdirectory>` picker produces. Relative
 * paths come from each File's `webkitRelativePath` by default; when every path
 * shares the picker's top-level folder segment, that segment is stripped (the
 * EPUB root is where mimetype/META-INF live) and becomes the source's `name`.
 * Files gathered another way (e.g. a hand-rolled DataTransferItem walk, where
 * `webkitRelativePath` is empty) supply their paths via `options.paths` -- a
 * Map from File to relative path, or a `(file, index) => path` function --
 * used exactly as given, no stripping.
 *
 * Reads are ASYNC on every thread, exactly like the `blob` range source:
 * `read` awaits `file.slice(offset, end).arrayBuffer()` and the engine suspends
 * per cache-miss block, so this runs on the browser MAIN thread as well as in
 * Workers (the library spawns none either way). The plugin only ever pulls the
 * requested range, which the engine pulls on demand mid-run (see the MEMORY
 * MODEL note). Nothing to release: disposal is a no-op.
 */
export function fileList(
  files: readonly File[],
  options: {
    paths?: ReadonlyMap<File, string> | ((file: File, index: number) => string);
  } = {},
): DirectorySource {
  assertNotBlob(files, 'fileList', 'Pass the ARRAY of files from the folder drop or <input webkitdirectory>; to validate one .epub file use blob().');
  if (!Array.isArray(files)) {
    throw new Error('fileList: expected an array of File objects');
  }
  const mapped = files.map((file: File, index: number) => {
    if (typeof Blob === 'undefined' || !(file instanceof Blob)) {
      throw new Error(`fileList: files[${index}] is not a File`);
    }
    let rel: string | undefined;
    if (typeof options.paths === 'function') rel = options.paths(file, index);
    else if (options.paths) rel = options.paths.get(file);
    if (rel === undefined) {
      const wrp = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
      if (typeof wrp === 'string' && wrp.length > 0) rel = wrp;
    }
    if (rel === undefined) {
      throw new Error(
        `fileList: files[${index}] ("${(file as File).name}") has no ` +
          'webkitRelativePath -- when the files were gathered by hand, supply ' +
          'their relative paths via options.paths',
      );
    }
    return { rel, file };
  });
  // Default the source name from a shared top-level folder segment when every
  // path has one (the dropped/gathered folder is the EPUB root). Strip that
  // segment ONLY in the webkitRelativePath case (no explicit mapping); explicit
  // paths are used exactly as given, so there we derive the name without
  // altering the paths. The name is cosmetic (reported message locations) and
  // an explicit `name` option always overrides it.
  let name: string | undefined;
  if (mapped.length > 0) {
    const first = mapped[0]!.rel.split('/')[0]!;
    if (
      first.length > 0 &&
      mapped.every((m) => m.rel.startsWith(first + '/'))
    ) {
      name = first;
      if (!options.paths) {
        for (const m of mapped) m.rel = m.rel.slice(first.length + 1);
      }
    }
  }
  const byPath = new Map<string, File>();
  for (const { rel, file } of mapped) {
    assertSafeRelativePath(rel, 'fileList');
    if (byPath.has(rel)) throw new Error(`fileList: duplicate relative path "${rel}"`);
    byPath.set(rel, file);
  }
  const entries = Array.from(byPath, ([rel, file]) => ({ path: rel, size: file.size }));
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const source: DirectorySource = {
    list: () => entries.map((e) => ({ ...e })),
    read: async (rel, offset, length) => {
      const file = byPath.get(rel);
      if (!file) throw new Error(`fileList: "${rel}" is not in this listing`);
      return new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
    },
    // The Files are browser-managed; nothing to release.
    [DISPOSE]() {},
  };
  if (name !== undefined) source.name = name;
  return source;
}

/**
 * Directory source over an in-memory tree: a Map (or plain object) from
 * relative '/'-separated path to Uint8Array. Only sensible for SMALL trees
 * (everything sits in RAM); prefer fsDir/opfsDir/fileList otherwise. Nothing
 * to release: disposal is a no-op.
 */
export function memoryDir(
  map: ReadonlyMap<string, Uint8Array> | Record<string, Uint8Array>,
): DirectorySource {
  assertNotBlob(map, 'memoryDir', 'Pass a Map (or object) of relative path -> Uint8Array; to validate one .epub file use memory().');
  const pairs: Array<[string, Uint8Array]> =
    map instanceof Map ? Array.from(map) : Object.entries(map);
  const byPath = new Map<string, Uint8Array>();
  for (const [rel, bytes] of pairs) {
    assertSafeRelativePath(rel, 'memoryDir');
    if (!(bytes instanceof Uint8Array)) {
      throw new Error(
        `memoryDir: value for "${rel}" is not a Uint8Array -- Blobs and other ` +
          'shapes are not accepted (decode to bytes first, or use fileList/blob)',
      );
    }
    if (byPath.has(rel)) throw new Error(`memoryDir: duplicate relative path "${rel}"`);
    byPath.set(rel, bytes);
  }
  const entries = Array.from(byPath, ([rel, bytes]) => ({ path: rel, size: bytes.length }));
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    list: () => entries.map((e) => ({ ...e })),
    read: (rel, offset, length) => {
      const bytes = byPath.get(rel);
      if (!bytes) throw new Error(`memoryDir: "${rel}" is not in this listing`);
      return bytes.subarray(offset, offset + length);
    },
    // The bytes are already in RAM; nothing to release.
    [DISPOSE]() {},
  };
}

// ============================================================================
// S3 sources -- validate a book that lives in S3-compatible object storage,
// WITHOUT downloading it whole. Dependency-free by design: the plugins consume
// a tiny STRUCTURAL backend the caller implements over their own S3 client
// (the same injected-backend philosophy as `fs(path, { fs })`). The library
// adds ZERO runtime dependencies -- it never imports an S3 SDK. A ~10-line
// adapter over @aws-sdk/client-s3 (or any client) is all the caller writes; a
// ready-made one ships as `s3ClientBackend` below (behind a DYNAMIC import, so
// aws-sdk stays an OPTIONAL peer dependency, never pulled into this graph).
// ============================================================================

/**
 * The minimal S3 read surface the `s3` range source needs: the object's total
 * size (one HeadObject) and ranged reads (ranged GetObject). Implement it over
 * any S3 client -- bring your own credentials, region, and endpoint.
 *
 * `read(key, offset, length)` MUST return exactly the bytes
 * `[offset, offset + length)` of the object. Over the S3 REST API that is a
 * `GetObject` with `Range: bytes=<offset>-<offset + length - 1>` -- note the
 * end is INCLUSIVE, so the last byte index is `offset + length - 1`, not
 * `offset + length`. The engine never asks past EOF and never for more than
 * 8 MiB at once, so a well-formed range always comes back whole.
 */
export interface S3RangeBackend {
  /** The object's total size in bytes (one HeadObject). */
  size(key: string): Promise<number>;
  /**
   * Exactly the bytes [offset, offset + length) of the object, via a ranged
   * GetObject (`Range: bytes=offset-(offset+length-1)`, end INCLUSIVE).
   */
  read(key: string, offset: number, length: number): Promise<Uint8Array>;
}

/** One object returned by an {@link S3DirBackend}'s `list`. */
export interface S3ObjectEntry {
  /** The object's FULL key (including the prefix). */
  key: string;
  /** The object's size in bytes. */
  size: number;
}

/**
 * The S3 surface the `s3Dir` directory source needs: the ranged reads of
 * {@link S3RangeBackend} plus a prefix listing. `list(prefix)` MUST return
 * EVERY object under the prefix -- paginate through `ListObjectsV2`'s
 * `ContinuationToken` yourself and concatenate the pages -- each as its FULL
 * key and size. `s3Dir` strips the prefix to derive the relative paths and
 * maps each back to its full key for reads.
 */
export interface S3DirBackend extends S3RangeBackend {
  /** Every object under `prefix`, as { key, size } (all pages concatenated). */
  list(prefix: string): Promise<S3ObjectEntry[]>;
}

/**
 * Range source over a single packaged `.epub` object in S3-compatible storage.
 * Reads are ASYNC (each is a ranged GetObject the engine suspends on), so the
 * object is NEVER downloaded whole: `HeadObject` gives the size up front and
 * the engine pulls only the [offset, length) ranges it needs mid-run (8 MiB
 * max per pull, through its own block cache) -- so a multi-GB book validates at
 * flat memory straight out of S3.
 *
 * The backend is INJECTED (you bring your own S3 client; see
 * {@link S3RangeBackend} and {@link s3ClientBackend}). Like every injected /
 * browser source this carries NO `hostDir` (the "path" is not a real host
 * path), so epubcheck keeps its internal-path behavior. The reported `name`
 * defaults to the key's last segment (`books/a/x.epub` -> `x.epub`), exactly as
 * the `fs` source defaults it from the file basename; an explicit `name` option
 * to `validate`/`runEpubcheck` still overrides it.
 */
export async function s3(
  key: string,
  options: { backend: S3RangeBackend },
): Promise<RangeSource> {
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error('s3: key must be a non-empty object key string');
  }
  const backend = options?.backend;
  if (!backend || typeof backend.size !== 'function' || typeof backend.read !== 'function') {
    throw new Error('s3: options.backend must implement { size(key), read(key, offset, length) }');
  }
  const size = await backend.size(key);
  if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) {
    throw new Error(`s3: backend.size("${key}") returned an invalid size: ${String(size)}`);
  }
  const source: RangeSource = {
    size,
    read: async (offset, length) => {
      const bytes = await backend.read(key, offset, length);
      // Ranged GetObject returns exactly the requested window; guard against a
      // short read (bad range, truncated object) the same way the fs source does.
      if (bytes.length < length) {
        throw new Error(`s3: short read of "${key}" at ${offset} (wanted ${length}, got ${bytes.length})`);
      }
      return bytes.length === length ? bytes : bytes.subarray(0, length);
    },
    // The S3 client is caller-owned; nothing to release, so dispose is a no-op
    // (uniform with blob/memory so `using source = await s3(...)` works too).
    [DISPOSE]() {},
  };
  const base = lastSegment(key);
  if (base.length > 0) source.name = base;
  return source;
}

/**
 * Directory source over an EXPANDED (unzipped) book stored as many objects
 * under a key PREFIX in S3-compatible storage -- epubcheck's `--mode exp`.
 * `list()` enumerates the prefix via the backend's `ListObjectsV2` walk (which
 * paginates through `ContinuationToken`), strips the prefix to relative
 * '/'-separated paths, and returns them sorted with their sizes; `read` does a
 * ranged GetObject on the object's full key, so nothing is downloaded whole and
 * only one file's requested range is ever in flight.
 *
 * The backend is INJECTED (see {@link S3DirBackend} / {@link s3ClientBackend}),
 * so like every injected/browser directory source this carries NO `hostDir`.
 * The reported `name` defaults to the prefix's last segment
 * (`books/mybook/` -> `mybook`), exactly as `fsDir` defaults it from the
 * directory name; an explicit `name` option still overrides it.
 *
 * Prefix handling: keys are matched against `prefix` and the prefix (plus any
 * leading `/`) is stripped to form the relative path. An object whose key IS
 * the prefix, or that reduces to an empty path (a "directory marker"), is
 * skipped. Each relative path is validated against the same safe-path rules as
 * the other directory sources; the full key is remembered for reads, so the
 * exact stored key is used regardless of how the prefix was written.
 */
export async function s3Dir(
  prefix: string,
  options: { backend: S3DirBackend },
): Promise<DirectorySource> {
  if (typeof prefix !== 'string') {
    throw new Error('s3Dir: prefix must be a string');
  }
  const backend = options?.backend;
  if (
    !backend ||
    typeof backend.size !== 'function' ||
    typeof backend.read !== 'function' ||
    typeof backend.list !== 'function'
  ) {
    throw new Error(
      's3Dir: options.backend must implement { size(key), read(key, offset, length), list(prefix) }',
    );
  }
  const objects = await backend.list(prefix);
  // rel -> full key. Strip the prefix (and any leading '/') to get the relative
  // path; skip the prefix marker itself and anything that reduces to empty.
  const byPath = new Map<string, { key: string; size: number }>();
  for (const obj of objects) {
    const key = obj.key;
    let rel = key.startsWith(prefix) ? key.slice(prefix.length) : key;
    rel = rel.replace(/^\/+/, '');
    if (rel.length === 0) continue; // the prefix marker / a "directory" object
    assertSafeRelativePath(rel, 's3Dir');
    if (byPath.has(rel)) throw new Error(`s3Dir: duplicate relative path "${rel}"`);
    byPath.set(rel, { key, size: obj.size });
  }
  const entries = Array.from(byPath, ([rel, v]) => ({ path: rel, size: v.size }));
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const source: DirectorySource = {
    list: () => entries.map((e) => ({ ...e })),
    read: async (rel, offset, length) => {
      const target = byPath.get(rel);
      if (!target) throw new Error(`s3Dir: "${rel}" is not in this listing`);
      const bytes = await backend.read(target.key, offset, length);
      if (bytes.length < length) {
        throw new Error(`s3Dir: short read of "${rel}" at ${offset} (wanted ${length}, got ${bytes.length})`);
      }
      return bytes.length === length ? bytes : bytes.subarray(0, length);
    },
    // The S3 client is caller-owned; nothing to release, so dispose is a no-op.
    [DISPOSE]() {},
  };
  const name = lastSegment(prefix);
  if (name.length > 0) source.name = name;
  return source;
}

/**
 * The minimal shape of an `@aws-sdk/client-s3` `S3Client` this module drives:
 * one `send(command)` method. Typed structurally so the library never has to
 * import the SDK's types -- the caller passes their configured client (endpoint,
 * region, credentials, forcePathStyle for MinIO/localstack, ...) unchanged.
 */
export interface S3ClientLike {
  send(command: unknown): Promise<unknown>;
}

/**
 * OPTIONAL convenience: build an {@link S3DirBackend} (which is also an
 * {@link S3RangeBackend}) from an `@aws-sdk/client-s3` `S3Client` and a bucket.
 * The aws-sdk is loaded through a DYNAMIC `import('@aws-sdk/client-s3')` ONLY
 * when you call this, so it stays an OPTIONAL peer dependency and never enters
 * the library's static import graph -- `s3`/`s3Dir` themselves need nothing but
 * the structural backend above. Bring your own client if you prefer (or use a
 * non-aws S3 client): implement {@link S3DirBackend} directly, it is ~10 lines.
 *
 * The returned backend maps the structural surface onto the S3 REST verbs:
 *   size(key)                -> HeadObject                 (ContentLength)
 *   read(key, offset, length)-> GetObject Range: bytes=offset-(offset+length-1)
 *                               (end INCLUSIVE), Body.transformToByteArray()
 *   list(prefix)             -> ListObjectsV2, paginated through
 *                               ContinuationToken, all pages concatenated.
 */
export async function s3ClientBackend(
  client: S3ClientLike,
  bucket: string,
): Promise<S3DirBackend> {
  if (!client || typeof client.send !== 'function') {
    throw new Error('s3ClientBackend: expected an @aws-sdk/client-s3 S3Client (with send())');
  }
  if (typeof bucket !== 'string' || bucket.length === 0) {
    throw new Error('s3ClientBackend: bucket must be a non-empty string');
  }
  // Dynamic import: aws-sdk is an OPTIONAL peer dep, resolved only here.
  const aws = (await import('@aws-sdk/client-s3')) as unknown as {
    HeadObjectCommand: new (input: { Bucket: string; Key: string }) => unknown;
    GetObjectCommand: new (input: { Bucket: string; Key: string; Range: string }) => unknown;
    ListObjectsV2Command: new (input: {
      Bucket: string;
      Prefix: string;
      ContinuationToken?: string;
    }) => unknown;
  };
  return {
    async size(key: string): Promise<number> {
      const r = (await client.send(new aws.HeadObjectCommand({ Bucket: bucket, Key: key }))) as {
        ContentLength?: number;
      };
      return Number(r.ContentLength);
    },
    async read(key: string, offset: number, length: number): Promise<Uint8Array> {
      // end INCLUSIVE: last byte index is offset + length - 1.
      const range = `bytes=${offset}-${offset + length - 1}`;
      const r = (await client.send(
        new aws.GetObjectCommand({ Bucket: bucket, Key: key, Range: range }),
      )) as { Body?: { transformToByteArray(): Promise<Uint8Array> } };
      if (!r.Body || typeof r.Body.transformToByteArray !== 'function') {
        throw new Error(`s3ClientBackend: GetObject("${key}") returned no readable Body`);
      }
      return r.Body.transformToByteArray();
    },
    async list(prefix: string): Promise<S3ObjectEntry[]> {
      const out: S3ObjectEntry[] = [];
      let token: string | undefined;
      do {
        const input: { Bucket: string; Prefix: string; ContinuationToken?: string } = {
          Bucket: bucket,
          Prefix: prefix,
        };
        if (token !== undefined) input.ContinuationToken = token;
        const r = (await client.send(new aws.ListObjectsV2Command(input))) as {
          Contents?: Array<{ Key?: string; Size?: number }>;
          IsTruncated?: boolean;
          NextContinuationToken?: string;
        };
        for (const o of r.Contents ?? []) {
          if (typeof o.Key === 'string') out.push({ key: o.Key, size: Number(o.Size ?? 0) });
        }
        token = r.IsTruncated ? r.NextContinuationToken : undefined;
      } while (token);
      return out;
    },
  };
}

/**
 * Encode a Uint8Array as base64 -- used by the run driver for the SMALL
 * side-channel feeds that are still string transported (the custom-messages
 * override file). Neither the packaged book nor expanded-directory file
 * contents are base64 transported: both stream through their range-read
 * feeds.
 *
 * Uses the native Uint8Array.prototype.toBase64 when available.
 */
export function toBase64(bytes: Uint8Array): string {
  const maybe = bytes as Uint8Array & { toBase64?: () => string };
  if (typeof maybe.toBase64 === 'function') return maybe.toBase64();
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk) as unknown as number[]);
  }
  return btoa(bin);
}

export default { blob, opfs, fs, memory, url, s3, s3Dir, s3ClientBackend, fsDir, opfsDir, fileList, memoryDir, isDirectorySource, isUrlSource, toBase64 };
