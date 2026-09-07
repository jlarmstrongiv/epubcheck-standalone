// epubcheck-standalone -- MAIN-THREAD integration proof, PAGE side.
//
// Loaded by main-thread.html as a module script (the harness server transpiles
// it to .js on request) under the SAME strict CSP the csp proof uses -- no
// 'unsafe-eval'. Everything here happens ON THE PAGE'S MAIN THREAD: no Worker is
// ever created, so this exercises the newest features exactly where they only
// take their interesting path -- the browser main thread, where blob() reads
// asynchronously and the engine SUSPENDS mid-run per cache-miss block.
//
// Scenarios, in order, in ONE page (so scope reuse/discard is exercised):
//   1. blob(): validate a small book supplied as a Blob. Assert the run
//      completes with a verdict AND that onMessage fired LIVE (a message arrived
//      before the validate() promise settled -- the tap streams mid-run).
//   2. abort mid-flight: a Blob-backed range source whose reads go through the
//      main-thread async path (blob.slice().arrayBuffer()) with a small delay;
//      the signal aborts WHILE a read is in flight. Assert the run rejects with
//      the AbortError reason and that the engine had reached a read (so the
//      abort landed mid-run, not before start).
//   3. clean run again: validate the SAME book once more via blob(). Assert the
//      verdict matches scenario 1 exactly -- the aborted scope was discarded and
//      the next run is healthy (warm-scope reuse/discard correctness).
//   4. fileList() on the main thread: build File[] from the fetched expanded
//      tree, validate, and assert every read returned a promise (async path).
//   5. opfs()/opfsDir() on the main thread: write the book + tree into OPFS,
//      then read them back through the async getFile() paths; opfs() single
//      matches scenario 1, opfsDir() matches scenario 4.
//   6. Blob customMessages: a Blob override is read with async Blob.arrayBuffer()
//      and its suppression applies (it would have thrown under FileReaderSync).
// Scenarios 4 and 5 run only when the driver reports the expanded tree ready.

const params = new URLSearchParams(location.search);
const bookUrl = params.get('book') ?? '';
const name = params.get('name') ?? 'book.epub';
const expandedAvailable = params.get('expanded') === '1';

function log(line: string): void {
  void fetch('/log', { method: 'POST', body: line }).catch(() => {});
}

// Polyfill-safe well-known dispose key -- the same key the library's plugins
// register under, so a hand-rolled range source disposes uniformly.
const DISPOSE: typeof Symbol.dispose =
  Symbol.dispose ?? (Symbol.for('Symbol.dispose') as typeof Symbol.dispose);

interface CspViolation {
  violatedDirective: string;
  blockedURI: string;
}

// A securitypolicyviolation anywhere on the page fails the proof: it would mean
// the library reached for eval / new Function and Chrome blocked it.
let violations = 0;
self.addEventListener('securitypolicyviolation', (e: Event) => {
  const v = e as unknown as CspViolation;
  violations++;
  log(JSON.stringify({ kind: 'csp-violation', where: 'page', directive: v.violatedDirective, blocked: v.blockedURI }));
});

interface Verdict {
  exit: number | null;
  valid: boolean;
  messages: number;
  codes: string[];
}

function verdictOf(result: {
  exitCode: number | null;
  valid: boolean;
  messages: Array<{ severity: string; code: string }>;
}): Verdict {
  return {
    exit: result.exitCode,
    valid: result.valid,
    messages: result.messages.length,
    codes: result.messages.slice(0, 6).map((m) => `${m.severity}(${m.code})`),
  };
}

function isAbortError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: string }).name === 'AbortError';
}

(async () => {
  try {
    // Guard: this MUST be a real main thread. FileReaderSync exists only in
    // dedicated Workers; if it is present here, blob() would take the fast
    // SYNCHRONOUS path and the async-suspend path under test would not run.
    if (typeof FileReaderSync === 'function') {
      throw new Error('main-thread proof ran where FileReaderSync exists -- not a main thread');
    }

    const origin = location.origin;
    // Single-export API: validate/configureEngine from validate-browser.js,
    // source plugins from plugins.js.
    const lib = await import(new URL('/dist/validate-browser.js', origin).href);
    const plugins = await import(new URL('/dist/plugins.js', origin).href);
    lib.configureEngine({ url: new URL('/dist/epubcheck-engine.js', origin).href });

    const res = await fetch(bookUrl);
    if (!res.ok) throw new Error(`fetch ${bookUrl}: HTTP ${res.status}`);
    const bookBlob = await res.blob();
    log(JSON.stringify({ kind: 'fetched', bytes: bookBlob.size }));

    // --- Scenario 1: blob() + live onMessage ---------------------------------
    let run1Settled = false;
    let run1MessagesSeen = 0;
    let run1SawLiveMessage = false;
    const t1 = performance.now();
    const run1Result = await lib.validate(plugins.blob(bookBlob), {
      name,
      onMessage: () => {
        run1MessagesSeen++;
        // Fired synchronously mid-run: if the promise has not settled yet, this
        // is a genuinely LIVE stream, not a post-run replay.
        if (!run1Settled) run1SawLiveMessage = true;
      },
    });
    run1Settled = true;
    const run1 = verdictOf(run1Result);
    log(
      JSON.stringify({
        kind: 'run1',
        verdict: run1,
        messagesSeen: run1MessagesSeen,
        sawLiveMessage: run1SawLiveMessage,
        ms: Math.round(performance.now() - t1),
      }),
    );

    // --- Scenario 2: abort mid-flight ----------------------------------------
    // The source reads the REAL book bytes through the exact main-thread async
    // path blob() uses (blob.slice().arrayBuffer()), but each read is delayed so
    // the run SUSPENDS on it; the signal aborts during that in-flight read. The
    // driver's resume-boundary re-check observes the abort and unwinds the
    // engine, so the promise rejects with the signal's reason.
    const controller = new AbortController();
    let abortReads = 0;
    const abortSource = {
      size: bookBlob.size,
      name,
      read: (offset: number, length: number): Promise<Uint8Array> => {
        abortReads++;
        return new Promise<Uint8Array>((resolve, reject) => {
          setTimeout(() => {
            // Abort while this read is pending, then settle it -- the resume
            // boundary samples the signal and throws the abort into the engine.
            controller.abort();
            bookBlob
              .slice(offset, offset + length)
              .arrayBuffer()
              .then((ab) => resolve(new Uint8Array(ab)), reject);
          }, 15);
        });
      },
      [DISPOSE](): void {},
    };
    let abortRejected = false;
    let abortName = '';
    const t2 = performance.now();
    try {
      await lib.validate(abortSource, { name, signal: controller.signal });
    } catch (err) {
      abortRejected = isAbortError(err);
      abortName = (err as { name?: string })?.name ?? String(err);
    }
    log(
      JSON.stringify({
        kind: 'abort',
        rejected: abortRejected,
        errorName: abortName,
        reads: abortReads,
        ms: Math.round(performance.now() - t2),
      }),
    );

    // --- Scenario 3: clean run again in the same page ------------------------
    const t3 = performance.now();
    const run3Result = await lib.validate(plugins.blob(bookBlob), { name });
    const run3 = verdictOf(run3Result);
    const run3MatchesRun1 =
      run3.exit === run1.exit &&
      run3.valid === run1.valid &&
      run3.messages === run1.messages &&
      JSON.stringify(run3.codes) === JSON.stringify(run1.codes);
    log(JSON.stringify({ kind: 'run3', verdict: run3, matchesRun1: run3MatchesRun1, ms: Math.round(performance.now() - t3) }));

    // --- Scenarios 4 + 5: fileList() and OPFS on the MAIN thread -------------
    // These exercise the plugins that were Worker-only before the async-first
    // sweep. Everything here is on the page main thread (FileReaderSync absent,
    // guarded above), so fileList() reads through slice().arrayBuffer() and
    // opfs()/opfsDir() read through getFile()+slice().arrayBuffer().
    let expandedRan = false;
    let fileListExit: number | null = null;
    let fileListReads = 0;
    let fileListReadsWerePromises = true;
    let fileListVerdict = '';
    let opfsRan = false;
    let opfsSingleMatchesRun1 = false;
    let opfsDirExit: number | null = null;
    let opfsDirMatchesFileList = false;

    if (expandedAvailable) {
      // Build File[] for the expanded tree from the driver's manifest.
      const manifest = (await (await fetch('/expanded/manifest.json')).json()) as Array<{
        path: string;
        size: number;
      }>;
      const files: File[] = [];
      const paths = new Map<File, string>();
      for (const entry of manifest) {
        const blobBytes = await (await fetch(`/expanded/file/${encodeURIComponent(entry.path)}`)).blob();
        const f = new File([blobBytes], entry.path.split('/').pop() ?? entry.path);
        files.push(f);
        paths.set(f, entry.path);
      }

      // Scenario 4: fileList() on the main thread. Wrap the source's read to
      // count calls AND assert each returns a promise (the async path).
      const flSource = plugins.fileList(files, { paths });
      const wrappedFileList = {
        name: flSource.name,
        list: () => flSource.list(),
        read: (rel: string, offset: number, length: number): Promise<Uint8Array> => {
          fileListReads++;
          const r = flSource.read(rel, offset, length);
          if (typeof (r as { then?: unknown })?.then !== 'function') fileListReadsWerePromises = false;
          return r as Promise<Uint8Array>;
        },
        [DISPOSE](): void {
          flSource[DISPOSE]();
        },
      };
      const t4 = performance.now();
      const flResult = await lib.validate(wrappedFileList, { name: 'minimal' });
      fileListExit = flResult.exitCode;
      fileListVerdict = JSON.stringify(verdictOf(flResult));
      expandedRan = true;
      log(
        JSON.stringify({
          kind: 'fileList',
          verdict: verdictOf(flResult),
          reads: fileListReads,
          readsWerePromises: fileListReadsWerePromises,
          ms: Math.round(performance.now() - t4),
        }),
      );

      // Scenario 5: OPFS on the main thread. Write the book + the expanded tree
      // into OPFS (createWritable is main-thread-legal in Chrome), then read
      // them back through opfs()/opfsDir()'s async getFile() paths.
      try {
        const root = await navigator.storage.getDirectory();
        const writeInto = async (
          dir: FileSystemDirectoryHandle,
          rel: string,
          bytes: BlobPart,
        ): Promise<void> => {
          const parts = rel.split('/');
          let d = dir;
          for (let i = 0; i < parts.length - 1; i++) {
            d = await d.getDirectoryHandle(parts[i]!, { create: true });
          }
          const fh = await d.getFileHandle(parts[parts.length - 1]!, { create: true });
          const w = await (fh as unknown as { createWritable(): Promise<{ write(d: BlobPart): Promise<void>; close(): Promise<void> }> }).createWritable();
          await w.write(bytes);
          await w.close();
        };

        // opfs() single file: same book as scenario 1.
        await writeInto(root, 'main-thread-book.epub', bookBlob);
        const opfsResult = await lib.validate(await plugins.opfs('main-thread-book.epub'), { name });
        const opfsV = verdictOf(opfsResult);
        opfsSingleMatchesRun1 =
          opfsV.exit === run1.exit &&
          opfsV.valid === run1.valid &&
          opfsV.messages === run1.messages &&
          JSON.stringify(opfsV.codes) === JSON.stringify(run1.codes);

        // opfsDir(): write the expanded tree, then read it back.
        const treeDir = await root.getDirectoryHandle('exp-tree', { create: true });
        for (const entry of manifest) {
          const bytes = await (await fetch(`/expanded/file/${encodeURIComponent(entry.path)}`)).blob();
          await writeInto(treeDir, entry.path, bytes);
        }
        const opfsDirResult = await lib.validate(await plugins.opfsDir(treeDir), { name: 'minimal' });
        opfsDirExit = opfsDirResult.exitCode;
        opfsDirMatchesFileList = JSON.stringify(verdictOf(opfsDirResult)) === fileListVerdict;
        opfsRan = true;
        log(
          JSON.stringify({
            kind: 'opfs',
            single: opfsV,
            opfsSingleMatchesRun1,
            opfsDir: verdictOf(opfsDirResult),
            opfsDirMatchesFileList,
          }),
        );
      } catch (err) {
        log(JSON.stringify({ kind: 'opfs-error', error: String((err as Error)?.stack ?? err) }));
      }
    }

    // --- Scenario 6: Blob customMessages on the MAIN thread ------------------
    // Before the sweep, validate-browser.ts read a Blob customMessages with
    // FileReaderSync, which is undefined on the main thread -> it THREW even
    // though the book source validated fine here. The fix reads it with async
    // Blob.arrayBuffer(). Prove it: suppress the book's RSC-005 via a Blob
    // override and assert the run succeeds AND the override applied (RSC-005
    // gone from the codes it otherwise reports).
    let customMsgRan = false;
    let customMsgThrew = false;
    let customMsgApplied = false;
    try {
      const override = new Blob(['RSC-005\tSUPPRESSED\n']);
      const cmResult = await lib.validate(plugins.blob(bookBlob), { name, customMessages: override });
      const codes = cmResult.messages.map((m: { severity: string; code: string }) => m.code);
      customMsgRan = true;
      customMsgApplied = run1.codes.some((c) => c.includes('RSC-005')) && !codes.includes('RSC-005');
      log(JSON.stringify({ kind: 'customMessages', ran: true, codes, applied: customMsgApplied }));
    } catch (err) {
      customMsgThrew = true;
      log(JSON.stringify({ kind: 'customMessages-error', error: String((err as Error)?.stack ?? err) }));
    }

    log(
      JSON.stringify({
        kind: 'summary',
        cspViolations: violations,
        run1,
        run1MessagesSeen,
        run1SawLiveMessage,
        abortRejected,
        abortReads,
        abortName,
        run3,
        run3MatchesRun1,
        expandedRan,
        fileListExit,
        fileListReads,
        fileListReadsWerePromises,
        opfsRan,
        opfsSingleMatchesRun1,
        opfsDirExit,
        opfsDirMatchesFileList,
        customMsgRan,
        customMsgThrew,
        customMsgApplied,
      }),
    );
  } catch (err) {
    log(JSON.stringify({ kind: 'error', error: String((err as Error)?.stack ?? err) }));
  } finally {
    log('=== DONE ===');
  }
})();
