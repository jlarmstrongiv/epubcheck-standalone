// epubcheck-standalone -- the async http bridge for URL inputs (internal).
//
// The engine downloads http(s) URL inputs through TeaVM native suspend/resume
// (see teavm/shims/src-teavm/ecshim/HostHttp.java): when the stock epubcheck
// code opens the URL mid-run, the Java green thread SUSPENDS, the host runs a
// plain async fetch on its own event loop, and the engine resumes when the
// completion callback fires. No worker threads, no SharedArrayBuffer, no
// synchronous XHR -- the host event loop stays free for the whole download, so
// an in-process HTTP server can answer its own validation, and the browser can
// validate URL inputs on its MAIN thread (no Worker requirement).
//
// The bridge feeds two globals for the run's duration (installed by the run
// driver, cleared in its finally):
//
//   __epubHttpGet(url, done)  start the GET; call done(response) EXACTLY ONCE,
//                             always from a later task/microtask (never
//                             re-entrantly), with the NUL-joined header string:
//                               "S" NUL status NUL handle NUL byteLength
//                               "E" NUL kind NUL message
//                                   kind: connect | unknownhost | io
//   __epubHttpRead(target, handle, offset, length) -> count | Promise<count>
//                             range fill of `target` (an Int8Array view over
//                             the requesting Java byte[]) with the body bytes
//                             [offset, offset + length); returns the count
//                             synchronously (the fast path) OR as a promise of
//                             it -- the engine SUSPENDS at HostHttp's @Async
//                             read seam until it settles, the same contract as
//                             the __ecRead/__ecDirRead feeds (at most one
//                             suspension per 8 MiB block).
//
// Where the body lives while the engine range-reads it:
//   - Node: SPOOLED TO DISK as it streams in (temp file, unlinked immediately
//     where the OS allows), served back with async positional FileHandle
//     reads (the engine suspends per 8 MiB block; nothing blocks the event
//     loop). Nothing ever holds the whole body in memory -- multi-GB URL
//     inputs validate at flat memory, same as the jar's download-then-validate
//     but without its RAM use.
//   - Browser: held as a browser-managed Blob (response.blob(), NOT a raw
//     in-RAM ArrayBuffer), range-read back with blob.slice().arrayBuffer() so
//     only the requested 8 MiB block is ever decoded. On Chromium a large Blob
//     spools to disk, so range reads stay flat-memory like the Node spool; on
//     Firefox/Safari the Blob may remain memory-resident (disk-spooling is not
//     spec-guaranteed) but it is off-heap, browser-managed, and dodges the
//     ~2 GiB contiguous main-thread ArrayBuffer ceiling. No Worker is spawned.
//
// Failure mapping (for jar-identical failure headlines, see HostHttp.java):
//   Node maps fetch failure causes -- ECONNREFUSED -> connect "Connection
//   refused" (the JDK's ConnectException wording), DNS failures -> unknownhost
//   with the hostname, everything else -> io with the underlying message.
//   Browsers deliberately do not disclose WHY a fetch failed (CORS, refused,
//   DNS...), so browser network failures map to the generic io kind -- the
//   jar-identical connect/unknownhost headlines are reproducible in Node only.
// Redirects: fetch follows them before reporting the final status, matching
// the jar's HttpURLConnection default for same-protocol redirects.

// NUL, the join character of the bridge's response header contract (NUL can
// occur in none of the joined tokens). Same transport as __epubArgs.
const NUL = String.fromCharCode(0);

/**
 * The async http bridge installed as __epubHttpGet/__epubHttpRead for a
 * URL-input run. Both platform factories below implement this one contract.
 */
export interface HttpBridge {
  /**
   * The __epubHttpGet contract: start the GET, then call `done` exactly once
   * with the NUL-joined response header string -- always from a later
   * task/microtask, never re-entrantly inside this call (the engine is
   * suspended at its @Async seam until `done` fires).
   */
  get(url: string, done: (response: string) => void): void;
  /**
   * The __epubHttpRead contract: fill `target` (the engine's Int8Array view
   * over the requesting Java byte[]) with exactly the body bytes
   * [offset, offset + length) of the fetched response `handle`; return the
   * count written -- synchronously (the fast path, e.g. an in-memory body) or
   * as a promise of it (the engine suspends at HostHttp's @Async read seam
   * until it settles; an async fill must write into `target` before
   * resolving -- the view stays valid across the suspension).
   */
  read(target: Int8Array, handle: number, offset: number, length: number): number | Promise<number>;
  /**
   * Release the fetched bodies (Node: close + delete the disk spools).
   * May be async; the run driver awaits it in its teardown.
   */
  close(): void | Promise<void>;
}

/** Map a fetch failure to the bridge's { errKind, message } pair (Node causes). */
function mapFetchError(url: string, err: unknown): { errKind: string; message: string } {
  interface CauseLike {
    code?: string;
    hostname?: string;
    message?: string;
    errors?: unknown[];
  }
  let cause = (err as { cause?: CauseLike }).cause;
  // Newer Node fetch surfaces multi-address connect failures as an
  // AggregateError cause; its first member carries the syscall code.
  if (cause && cause.code === undefined && Array.isArray(cause.errors) && cause.errors.length > 0) {
    const first = cause.errors[0];
    if (first && typeof first === 'object') cause = first as CauseLike;
  }
  const code = cause?.code;
  if (code === 'ECONNREFUSED') {
    // The JDK's ConnectException message for a refused TCP connection.
    return { errKind: 'connect', message: 'Connection refused' };
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    let host = cause?.hostname;
    if (!host) {
      try {
        host = new URL(url).hostname;
      } catch {
        host = url;
      }
    }
    return { errKind: 'unknownhost', message: host };
  }
  const message = cause?.message ?? (err instanceof Error ? err.message : String(err));
  return { errKind: 'io', message };
}

/**
 * Node bridge: async fetch streaming into a disk spool, async positional
 * FileHandle reads back out (the engine suspends at HostHttp's @Async read
 * seam per 8 MiB block -- nothing on this path blocks the event loop). The
 * factory is async because node:fs/os/path are imported lazily -- this module
 * stays importable (never touching node builtins) outside Node.
 */
export async function createHttpBridgeNode(): Promise<HttpBridge> {
  const fsp = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  /** One spooled response body, indexed by the handle returned through get(). */
  interface Spool {
    file: Awaited<ReturnType<typeof fsp.open>>;
    /** The on-disk path, or null once unlinked (POSIX immediate-unlink). */
    path: string | null;
    length: number;
  }
  const spools: Spool[] = [];
  let spoolSeq = 0;
  let closed = false;

  async function download(url: string): Promise<string> {
    let file: Spool['file'] | null = null;
    let path: string | null = null;
    try {
      const response = await fetch(url);
      path = join(tmpdir(), `epubcheck-http-${process.pid}-${spoolSeq++}.spool`);
      file = await fsp.open(path, 'w+');
      try {
        // POSIX: unlink now; the handle stays readable and the kernel reclaims
        // the bytes on close/exit, so even a SIGKILLed process leaks nothing.
        // Where this fails (Windows), keep the path for close() below.
        await fsp.unlink(path);
        path = null;
      } catch {
        // deferred cleanup keeps the path
      }
      let length = 0;
      if (response.body) {
        const chunks = response.body as unknown as AsyncIterable<Uint8Array>;
        for await (const chunk of chunks) {
          let done = 0;
          while (done < chunk.length) {
            const { bytesWritten } = await file.write(
              chunk,
              done,
              chunk.length - done,
              length + done,
            );
            done += bytesWritten;
          }
          length += chunk.length;
        }
      }
      if (closed) {
        // close() raced the download: release the spool, report a failure.
        // This spool is NEVER pushed to `spools`, so close()'s cleanup loop
        // will never revisit it -- any deferred-cleanup path retained here
        // (Windows, where the create-time unlink failed) must be deleted now,
        // AFTER the handle is closed, or it leaks one temp file per late run.
        // On POSIX `path` is already null (pre-unlinked), so this is a no-op.
        await file.close();
        if (path !== null) {
          try {
            await fsp.unlink(path);
          } catch (err) {
            // ENOENT = already gone (fine); anything else falls through to the
            // outer catch's best-effort cleanup (which re-attempts the unlink).
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
          }
        }
        return ['E', 'io', 'the http bridge was closed during the download'].join(NUL);
      }
      const handle = spools.push({ file, path, length }) - 1;
      return ['S', response.status, handle, length].join(NUL);
    } catch (err) {
      if (file !== null) {
        try {
          await file.close();
        } catch {
          // best-effort
        }
      }
      if (path !== null) {
        try {
          await fsp.unlink(path);
        } catch {
          // best-effort
        }
      }
      const { errKind, message } = mapFetchError(url, err);
      return ['E', errKind, message].join(NUL);
    }
  }

  return {
    get(url: string, done: (response: string) => void): void {
      // download() is an async function: done always fires from a later
      // microtask, never re-entrantly (the @Async contract in HostHttp.java).
      void download(url).then(done);
    },
    async read(
      target: Int8Array,
      handle: number,
      offset: number,
      length: number,
    ): Promise<number> {
      // Async positional reads off the spool FileHandle: the returned promise
      // makes the engine SUSPEND at HostHttp's @Async read seam (at most once
      // per 8 MiB block) and the event loop stays free while the disk serves
      // the range. The target view is filled BEFORE the promise resolves, and
      // the Java byte[] behind it does not move across the suspension (the
      // seam's documented guarantee), so writing into it here is safe.
      const spool = spools[handle];
      if (!spool) return 0;
      const out = new Uint8Array(target.buffer, target.byteOffset, length);
      let done = 0;
      while (done < length) {
        const { bytesRead } = await spool.file.read(out, done, length - done, offset + done);
        if (bytesRead <= 0) break;
        done += bytesRead;
      }
      return done;
    },
    async close(): Promise<void> {
      // Async teardown (run-core awaits it in its finally): close the spool
      // FileHandles and delete any spool file that could not be pre-unlinked.
      if (closed) return;
      closed = true;
      const releasing = spools.splice(0, spools.length);
      // Independent spools tear down concurrently (each is its own temp file +
      // FileHandle); WITHIN a spool close→unlink stays ordered (unlink only
      // after that spool's own close). Usually 0-1 spools, so this is minor.
      await Promise.all(
        releasing.map(async (spool) => {
          try {
            await spool.file.close();
          } catch {
            // best-effort: keep releasing the rest
          }
          if (spool.path !== null) {
            try {
              await fsp.unlink(spool.path);
            } catch {
              // best-effort
            }
          }
        }),
      );
    },
  };
}

/**
 * Browser (and any non-Node host) bridge: async fetch, holding the body as a
 * browser-managed Blob (response.blob()) and range-reading it back with
 * blob.slice().arrayBuffer() so only the requested block is ever decoded. Works
 * on the MAIN thread and in Workers alike -- the library spawns no threads and
 * needs no synchronous XHR. On Chromium a large Blob spools to disk, so multi-GB
 * URL inputs range-read at flat memory like the Node spool; on Firefox/Safari
 * the Blob may stay memory-resident (disk-spooling is not spec-guaranteed) but
 * it is off-heap and dodges the ~2 GiB contiguous main-thread ArrayBuffer cap.
 */
export function createHttpBridgeFetch(): HttpBridge {
  /** Fetched response bodies, by the handle returned through get(). */
  const bodies: Blob[] = [];

  async function download(url: string): Promise<string> {
    try {
      const response = await fetch(url);
      const blob = await response.blob();
      const handle = bodies.push(blob) - 1;
      return ['S', response.status, handle, blob.size].join(NUL);
    } catch (err) {
      // Browsers do not disclose WHY a fetch failed (CORS, refused, DNS...).
      const message =
        (err instanceof Error && err.message ? err.message : String(err)) +
        ' fetching ' +
        url +
        ' (connection failure, or the server does not allow cross-origin requests)';
      return ['E', 'io', message].join(NUL);
    }
  }

  return {
    get(url: string, done: (response: string) => void): void {
      // Async function: done always fires from a later microtask, never
      // re-entrantly (the @Async contract in HostHttp.java).
      void download(url).then(done);
    },
    async read(
      target: Int8Array,
      handle: number,
      offset: number,
      length: number,
    ): Promise<number> {
      // ASYNC range read off the Blob: blob.slice() carves the requested range
      // as a cheap lazy Blob (Chromium serves it straight from the on-disk
      // spool), and .arrayBuffer() decodes ONLY that range -- never the whole
      // body. The returned promise makes the engine SUSPEND at HostHttp's
      // @Async read seam (at most once per 8 MiB block) while the range is
      // fetched, keeping the event loop free. Per the HttpBridge.read contract
      // the fill is written into `target` BEFORE the promise resolves and the
      // Java byte[] behind the view does not move across the suspension (the
      // seam's guarantee), so writing into it here is safe -- exactly the
      // discipline the Node spool bridge follows.
      const blob = bodies[handle];
      if (!blob) return 0;
      const end = Math.min(offset + length, blob.size);
      const chunk = new Uint8Array(await blob.slice(offset, end).arrayBuffer());
      new Uint8Array(target.buffer, target.byteOffset, length).set(chunk);
      return chunk.length;
    },
    close(): void {
      // Synchronous ON PURPOSE: dropping the Blob references is pure-CPU work
      // with no async equivalent (nothing to await); the browser reclaims each
      // Blob's backing store -- an on-disk spool included -- once unreferenced.
      bodies.length = 0;
    },
  };
}
