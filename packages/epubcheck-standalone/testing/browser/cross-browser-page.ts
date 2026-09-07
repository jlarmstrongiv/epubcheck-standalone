// epubcheck-standalone -- CROSS-BROWSER engine proof, PAGE side.
//
// Loaded by cross-browser.html as a module script (the harness server transpiles
// it to .js on request) under the SAME strict CSP the main-thread proof uses --
// no 'unsafe-eval', no 'wasm-unsafe-eval'. It runs the SAME core assertions in
// Chrome, Firefox, and Safari so the footer's "verified in Chrome, Firefox, and
// Safari" is provable on the current engine (dist/epubcheck-engine.js):
//
//   (a) the engine loads as a plain ES module under the strict CSP and
//       instantiates with NO eval / CSP violation (proven by validate() returning
//       a real verdict AND zero securitypolicyviolation events),
//   (b) a known fixture validates to a stable verdict (exit/valid/messages/codes)
//       that the driver compares byte-for-byte across all three browsers -- the
//       "expected" is the shared cross-browser verdict, not a per-browser guess,
//   (c) no console / JS errors (window error + unhandledrejection are reported).
//
// It uses the documented single-export API: validate/configureEngine from
// validate-browser.js, source plugins from plugins.js. Everything runs on the
// page MAIN thread (no Worker), so the file-backed plugins take their async
// slice().arrayBuffer() path. Extra proofs that ride along, all universal:
//   1. blob(): known fixture -> verdict1, and onMessage fires LIVE mid-run.
//   2. blob() again: verdict2 must equal verdict1 (warm-scope reuse/discard).
//   3. fileList(): expanded tree as File[] validates via async reads (promises).
// OPFS main-thread writes are Chrome-only and intentionally NOT required here.

const params = new URLSearchParams(location.search);
const bookUrl = params.get('book') ?? '';
const name = params.get('name') ?? 'book.epub';
const expandedAvailable = params.get('expanded') === '1';

function log(line: string): void {
  void fetch('/log', { method: 'POST', body: line }).catch(() => {});
}

const DISPOSE: typeof Symbol.dispose =
  Symbol.dispose ?? (Symbol.for('Symbol.dispose') as typeof Symbol.dispose);

interface CspViolation {
  violatedDirective: string;
  blockedURI: string;
}

// A securitypolicyviolation anywhere fails the proof: it would mean the engine
// reached for eval / new Function and the browser blocked it.
let violations = 0;
self.addEventListener('securitypolicyviolation', (e: Event) => {
  const v = e as unknown as CspViolation;
  violations++;
  log(JSON.stringify({ kind: 'csp-violation', directive: v.violatedDirective, blocked: v.blockedURI }));
});

// Any uncaught error / rejection is a console error for assertion (c).
let pageErrors = 0;
self.addEventListener('error', (e: Event) => {
  pageErrors++;
  log(JSON.stringify({ kind: 'page-error', error: String((e as ErrorEvent).message ?? e) }));
});
self.addEventListener('unhandledrejection', (e: Event) => {
  pageErrors++;
  log(JSON.stringify({ kind: 'page-rejection', error: String((e as PromiseRejectionEvent).reason ?? e) }));
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
    codes: result.messages.map((m) => `${m.severity}(${m.code})`),
  };
}

(async () => {
  try {
    // Guard: a real page main thread (FileReaderSync exists only in Workers).
    const onMainThread = typeof FileReaderSync !== 'function';

    const origin = location.origin;
    // Single-export API: validate/configureEngine here, source plugins there.
    const lib = await import(new URL('/dist/validate-browser.js', origin).href);
    const plugins = await import(new URL('/dist/plugins.js', origin).href);
    lib.configureEngine({ url: new URL('/dist/epubcheck-engine.js', origin).href });
    log(JSON.stringify({ kind: 'engine-configured', version: lib.EPUBCHECK_VERSION ?? null, onMainThread }));

    const res = await fetch(bookUrl);
    if (!res.ok) throw new Error(`fetch ${bookUrl}: HTTP ${res.status}`);
    const bookBlob = await res.blob();
    log(JSON.stringify({ kind: 'fetched', bytes: bookBlob.size }));

    // --- Scenario 1: blob() + live onMessage --------------------------------
    let run1Settled = false;
    let run1MessagesSeen = 0;
    let run1SawLiveMessage = false;
    const t1 = performance.now();
    const run1Result = await lib.validate(plugins.blob(bookBlob), {
      name,
      onMessage: () => {
        run1MessagesSeen++;
        if (!run1Settled) run1SawLiveMessage = true;
      },
    });
    run1Settled = true;
    const run1 = verdictOf(run1Result);
    log(JSON.stringify({ kind: 'run1', verdict: run1, messagesSeen: run1MessagesSeen, sawLiveMessage: run1SawLiveMessage, ms: Math.round(performance.now() - t1) }));

    // --- Scenario 2: clean run again, must match run 1 ----------------------
    const t2 = performance.now();
    const run2Result = await lib.validate(plugins.blob(bookBlob), { name });
    const run2 = verdictOf(run2Result);
    const run2MatchesRun1 =
      run2.exit === run1.exit &&
      run2.valid === run1.valid &&
      run2.messages === run1.messages &&
      JSON.stringify(run2.codes) === JSON.stringify(run1.codes);
    log(JSON.stringify({ kind: 'run2', verdict: run2, matchesRun1: run2MatchesRun1, ms: Math.round(performance.now() - t2) }));

    // --- Scenario 3: fileList() on the main thread (universal async reads) ---
    let fileListRan = false;
    let fileListExit: number | null = null;
    let fileListReads = 0;
    let fileListReadsWerePromises = true;
    let fileListVerdict: Verdict | null = null;
    if (expandedAvailable) {
      const manifest = (await (await fetch('/expanded/manifest.json')).json()) as Array<{ path: string; size: number }>;
      const files: File[] = [];
      const paths = new Map<File, string>();
      for (const entry of manifest) {
        const bytes = await (await fetch(`/expanded/file/${encodeURIComponent(entry.path)}`)).blob();
        const f = new File([bytes], entry.path.split('/').pop() ?? entry.path);
        files.push(f);
        paths.set(f, entry.path);
      }
      const flSource = plugins.fileList(files, { paths });
      const wrapped = {
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
      const t3 = performance.now();
      const flResult = await lib.validate(wrapped, { name: 'minimal' });
      fileListExit = flResult.exitCode;
      fileListVerdict = verdictOf(flResult);
      fileListRan = true;
      log(JSON.stringify({ kind: 'fileList', verdict: fileListVerdict, reads: fileListReads, readsWerePromises: fileListReadsWerePromises, ms: Math.round(performance.now() - t3) }));
    }

    log(JSON.stringify({
      kind: 'summary',
      onMainThread,
      cspViolations: violations,
      pageErrors,
      run1,
      run1MessagesSeen,
      run1SawLiveMessage,
      run2,
      run2MatchesRun1,
      expandedRan: fileListRan,
      fileListExit,
      fileListReads,
      fileListReadsWerePromises,
      fileListVerdict,
    }));
  } catch (err) {
    log(JSON.stringify({ kind: 'error', error: String((err as Error)?.stack ?? err) }));
  } finally {
    log('=== DONE ===');
  }
})();
