// epubcheck-standalone -- CSP proof, PAGE side (main thread + worker).
//
// Loaded by csp.html as a module script under a CSP with NO 'unsafe-eval'. It
// proves TWO things the eval-free engine factory unlocks:
//   1. MAIN-THREAD memory() validation works in the page context itself (the old
//      limitation needed a dedicated Worker AND unsafe-eval; the factory kills
//      both halves for an in-memory source).
//   2. the WORKER route still works, also with no unsafe-eval.
// Both routes validate the SAME bytes, so their verdicts must agree. A
// securitypolicyviolation anywhere (page or worker) fails the proof: it would
// mean the library reached for eval / new Function and Chrome blocked it.

const params = new URLSearchParams(location.search);
const bookUrl = params.get('book') ?? '';
const name = params.get('name') ?? 'book.epub';

function log(line: string): void {
  void fetch('/log', { method: 'POST', body: line }).catch(() => {});
}

interface CspViolation {
  violatedDirective: string;
  blockedURI: string;
}

// securitypolicyviolation is dispatched on the document and bubbles to the global
// (window) scope; a global listener catches it. If a violation instead blocks the
// engine's dynamic import(), that import rejects and the route's try/catch below
// fails the proof too -- double coverage.
let violations = 0;
self.addEventListener('securitypolicyviolation', (e: Event) => {
  const v = e as unknown as CspViolation;
  violations++;
  log(JSON.stringify({ kind: 'csp-violation', where: 'page', directive: v.violatedDirective, blocked: v.blockedURI }));
});

interface RouteResult {
  route: string;
  exit: number | null;
  valid: boolean;
  messages: number;
  codes: string[];
}

async function mainThreadMemoryRoute(): Promise<RouteResult> {
  const lib = await import(new URL('/dist/validate-browser.js', location.origin).href);
  const plugins = await import(new URL('/dist/plugins.js', location.origin).href);
  lib.configureEngine({ url: new URL('/dist/epubcheck-engine.js', location.origin).href });
  const res = await fetch(bookUrl);
  if (!res.ok) throw new Error(`fetch ${bookUrl}: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const result = await lib.validate(plugins.memory(bytes), { name });
  return {
    route: 'main-thread-memory',
    exit: result.exitCode,
    valid: result.valid,
    messages: result.messages.length,
    codes: result.messages.slice(0, 6).map((m: { severity: string; code: string }) => `${m.severity}(${m.code})`),
  };
}

function workerRoute(): Promise<RouteResult> {
  return new Promise((resolve, reject) => {
    const w = new Worker('/testing/browser/csp-worker.js', { type: 'module' });
    w.onerror = (e: ErrorEvent) => reject(new Error(e.message || 'worker error'));
    w.onmessage = (ev: MessageEvent<{ kind: string; error?: string } & RouteResult>) => {
      const d = ev.data;
      log(JSON.stringify(d));
      if (d.kind === 'csp-violation') {
        violations++;
        return;
      }
      if (d.kind === 'done') resolve(d);
      else if (d.kind === 'error') reject(new Error(d.error));
    };
    w.postMessage({ bookUrl, name });
  });
}

(async () => {
  try {
    const main = await mainThreadMemoryRoute();
    log(JSON.stringify({ kind: 'done', ...main }));
    const worker = await workerRoute();
    const routesAgree = main.exit === worker.exit && main.messages === worker.messages;
    log(
      JSON.stringify({
        kind: 'summary',
        cspViolations: violations,
        routesAgree,
        main,
        worker,
      }),
    );
  } catch (err) {
    log(JSON.stringify({ kind: 'error', error: String((err as Error)?.stack ?? err) }));
  } finally {
    log('=== DONE ===');
  }
})();
