// epubcheck-standalone -- CSP proof, WORKER route.
//
// Validates a small book through memory() inside a dedicated module Worker, under
// a page/worker CSP that has NO 'unsafe-eval'. The engine factory is obtained
// with a dynamic import() (a real ES-module load, governed by script-src, not
// unsafe-eval); if anything in the shipped library reached for eval / new
// Function, Chrome would raise a securitypolicyviolation and the run would fail.
// Any violation seen here is forwarded to the page so the proof fails loudly.

interface Cfg {
  bookUrl: string;
  name: string;
}

interface CspViolation {
  violatedDirective: string;
  blockedURI: string;
}

function post(kind: string, detail: Record<string, unknown> = {}): void {
  (self as unknown as { postMessage(v: unknown): void }).postMessage({ kind, ...detail });
}

self.addEventListener('securitypolicyviolation', (e: Event) => {
  const v = e as unknown as CspViolation;
  post('csp-violation', { where: 'worker', directive: v.violatedDirective, blocked: v.blockedURI });
});

self.onmessage = async (ev: MessageEvent<Cfg>) => {
  const { bookUrl, name } = ev.data;
  try {
    const origin = self.location.origin;
    const lib = await import(new URL('/dist/validate-browser.js', origin).href);
    const plugins = await import(new URL('/dist/plugins.js', origin).href);
    lib.configureEngine({ url: new URL('/dist/epubcheck-engine.js', origin).href });
    const res = await fetch(bookUrl);
    if (!res.ok) throw new Error(`fetch ${bookUrl}: HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const result = await lib.validate(plugins.memory(bytes), { name });
    post('done', {
      route: 'worker-memory',
      exit: result.exitCode,
      valid: result.valid,
      messages: result.messages.length,
      codes: result.messages
        .slice(0, 6)
        .map((m: { severity: string; code: string }) => `${m.severity}(${m.code})`),
    });
  } catch (err) {
    post('error', { route: 'worker-memory', error: String((err as Error)?.stack ?? err) });
  }
};
