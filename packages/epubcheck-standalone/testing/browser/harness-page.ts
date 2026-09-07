// epubcheck-standalone -- page side of the browser streaming harness.
// Loaded by harness.html as a module script (the harness server transpiles it
// to .js on request). Forwards progress to the harness server's /log endpoint
// and appends the "=== DONE ===" marker browser-check.ts waits for.
//
// Modes blob/opfsimport spawn the dedicated module Worker (harness-worker.ts)
// and everything meaningful happens there. Mode mainblob validates ON THIS
// PAGE'S MAIN THREAD -- no Worker anywhere -- through the async blob() read
// path (the engine suspends per cache-miss block on blob.slice().arrayBuffer()),
// proving File/Blob validation needs no Worker.

const params = new URLSearchParams(location.search);

function log(line: string): void {
  void fetch('/log', { method: 'POST', body: line }).catch(() => {});
}

const modeParam = params.get('mode');
const mode =
  modeParam === 'opfsimport' || modeParam === 'mainblob' ? modeParam : 'blob';
const bookUrl = params.get('book') ?? '';
const name = params.get('name') ?? 'book.epub';

if (mode === 'mainblob') {
  // MAIN-THREAD route: everything happens right here on the page.
  void (async () => {
    try {
      if (typeof FileReaderSync === 'function') {
        throw new Error('mainblob harness ran where FileReaderSync exists -- not a main thread');
      }
      const origin = location.origin;
      const lib = await import(new URL('/dist/validate-browser.js', origin).href);
      const plugins = await import(new URL('/dist/plugins.js', origin).href);
      lib.configureEngine({ url: new URL('/dist/epubcheck-engine.js', origin).href });
      log(JSON.stringify({ kind: 'start', mode, bookUrl, name }));

      const t0 = performance.now();
      const res = await fetch(bookUrl);
      if (!res.ok) throw new Error(`fetch ${bookUrl}: HTTP ${res.status}`);
      const bookBlob = await res.blob();
      log(JSON.stringify({ kind: 'fetched', bytes: bookBlob.size, ms: Math.round(performance.now() - t0) }));

      const t1 = performance.now();
      const result = await lib.validate(plugins.blob(bookBlob), { name });
      log(
        JSON.stringify({
          kind: 'done',
          exit: result.exitCode,
          valid: result.valid,
          messages: result.messages.length,
          firstMessages: result.messages
            .slice(0, 5)
            .map((m: { severity: string; code: string }) => `${m.severity}(${m.code})`),
          validateMs: Math.round(performance.now() - t1),
          totalMs: Math.round(performance.now() - t0),
        }),
      );
    } catch (err) {
      log(JSON.stringify({ kind: 'error', error: String((err as Error)?.stack ?? err) }));
    }
    log('=== DONE ===');
  })();
} else {
  const worker = new Worker('/testing/browser/harness-worker.js', { type: 'module' });

  worker.onerror = (e: ErrorEvent) => {
    log('ERROR worker: ' + (e.message || 'unknown worker error'));
    log('=== DONE ===');
  };

  worker.onmessage = (ev: MessageEvent<{ kind: string }>) => {
    log(JSON.stringify(ev.data));
    if (ev.data.kind === 'done' || ev.data.kind === 'error') {
      log('=== DONE ===');
    }
  };

  worker.postMessage({ mode, bookUrl, name });
}
