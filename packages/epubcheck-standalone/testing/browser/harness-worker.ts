// epubcheck-standalone -- dedicated-Worker harness for the browser streaming
// proof (driven by testing/browser/browser-check.ts).
//
// Everything meaningful happens in THIS worker: the library needs a dedicated
// Worker in the browser (FileReaderSync and OPFS sync access handles exist
// nowhere else), and the engine validates synchronously on the calling thread.
// Two routes, selected by the page via postMessage:
//
//   blob        fetch the book -> response.blob() (Chromium spools large blobs
//               to disk) -> the `blob` range source (FileReaderSync + slice)
//               -> validate. Proves the Blob/File streaming path.
//   opfsimport  fetch the book and STREAM it into OPFS through a sync access
//               handle (one network chunk in memory at a time), then validate
//               IN PLACE through the `opfs` range source. Proves the OPFS
//               streaming path.
//
// The library and engine are loaded from the harness server's /dist/ (the real
// built package). Imports are dynamic by URL so this file typechecks without a
// bundler; the harness server transpiles it to .js on request.

interface HarnessConfig {
  mode: 'blob' | 'opfsimport';
  bookUrl: string;
  name: string;
}

function post(kind: string, detail: Record<string, unknown> = {}): void {
  (self as unknown as { postMessage(v: unknown): void }).postMessage({ kind, ...detail });
}

self.onmessage = async (ev: MessageEvent<HarnessConfig>) => {
  const { mode, bookUrl, name } = ev.data;
  try {
    const origin = self.location.origin;
    const lib = await import(new URL('/dist/validate-browser.js', origin).href);
    // Source-plugin factories live on the /plugins entry only (single-export
    // map); validate/configureEngine stay on the main browser entry.
    const plugins = await import(new URL('/dist/plugins.js', origin).href);
    lib.configureEngine({ url: new URL('/dist/epubcheck-engine.js', origin).href });
    post('start', { mode, bookUrl, name });

    const t0 = performance.now();
    let source;
    if (mode === 'opfsimport') {
      const root = await navigator.storage.getDirectory();
      const fileHandle = await root.getFileHandle(name, { create: true });
      const handle = await fileHandle.createSyncAccessHandle();
      handle.truncate(0);
      const res = await fetch(bookUrl);
      if (!res.ok || !res.body) throw new Error(`fetch ${bookUrl}: HTTP ${res.status}`);
      const reader = res.body.getReader();
      let at = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        handle.write(value, { at });
        at += value.byteLength;
      }
      handle.flush();
      post('imported', { bytes: at, ms: Math.round(performance.now() - t0) });
      // Validate through the SAME sync access handle, in place.
      source = await plugins.opfs(handle);
    } else {
      const res = await fetch(bookUrl);
      if (!res.ok) throw new Error(`fetch ${bookUrl}: HTTP ${res.status}`);
      const bookBlob = await res.blob();
      post('fetched', { bytes: bookBlob.size, ms: Math.round(performance.now() - t0) });
      source = plugins.blob(bookBlob);
    }

    const t1 = performance.now();
    const result = await lib.validate(source, { name });
    post('done', {
      exit: result.exitCode,
      valid: result.valid,
      messages: result.messages.length,
      firstMessages: result.messages
        .slice(0, 5)
        .map((m: { severity: string; code: string }) => `${m.severity}(${m.code})`),
      validateMs: Math.round(performance.now() - t1),
      totalMs: Math.round(performance.now() - t0),
    });
  } catch (err) {
    post('error', { error: String((err as Error)?.stack ?? err) });
  }
};
