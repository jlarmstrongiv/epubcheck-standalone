#!/usr/bin/env node
// epubcheck-standalone -- headless-Chrome CSP proof.
//
//   node testing/browser/csp-check.ts [path-to-epub] [--headed]
//
// Proves the eval-free engine factory: a page served under a Content-Security-
// Policy with NO 'unsafe-eval' validates a small book through the public API on
// BOTH the WORKER route and the MAIN-THREAD memory() route. Before the factory
// the engine was evaluated with `new Function`, so browsers needed a dedicated
// Worker AND 'unsafe-eval'; the factory removes the eval, and this proof serves
// a strict CSP header and fails if Chrome reports any securitypolicyviolation.
//
// It is the CSP sibling of browser-check.ts (the streaming harness): same
// package-root static server + transpile-on-request + version.js self-reference
// rewrite, plus a strict CSP header on every response and a two-route proof page.
//
// Exit 0 only if: both routes completed, they agree, and there were zero CSP
// violations.

import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';

const packageRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));

const args = process.argv.slice(2);
const headed = args.includes('--headed');
// Default to a tiny committed corpus book; any small .epub works (the proof is
// about the CSP, not the verdict).
const defaultBook = join(
  packageRoot,
  'test',
  'corpus',
  'epubcheck-expanded',
  'epub2__files__epub__opf-legacy-oebps12-mediatype-css-warning.epub',
);
const epubPath = args.find((a) => !a.startsWith('--')) ?? defaultBook;
if (!existsSync(epubPath)) {
  console.error(`epub not found: ${epubPath}`);
  process.exit(64);
}
const bookAbs = resolve(epubPath);
const bookName = basename(bookAbs);

const CHROME = process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!existsSync(CHROME)) {
  console.error(`Chrome not found at ${CHROME} (set CHROME_BIN)`);
  process.exit(69);
}

// Strict CSP: allow same-origin scripts/workers/connections, but NO 'unsafe-eval'
// (and no 'wasm-unsafe-eval'). If the library reached for eval / new Function
// Chrome would block it and fire securitypolicyviolation, failing the proof.
const CSP =
  "default-src 'self'; script-src 'self'; worker-src 'self'; connect-src 'self'; " +
  "img-src 'self' data:; style-src 'self' 'unsafe-inline'; base-uri 'none'; object-src 'none'";

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.ts': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.epub': 'application/epub+zip',
};

const logLines: string[] = [];
function log(line: string): void {
  logLines.push(line);
  console.log(`[csp] ${line}`);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  // Every response carries the strict CSP header (pages, module scripts, and the
  // worker script alike, so the worker runs under the same no-unsafe-eval policy).
  const baseHeaders = (extra: Record<string, string>): Record<string, string> => ({
    'content-security-policy': CSP,
    ...extra,
  });

  if (req.method === 'POST' && url.pathname === '/log') {
    let body = '';
    req.on('data', (c: Buffer) => {
      body += c.toString('utf8');
    });
    req.on('end', () => {
      log(body);
      res.writeHead(204, baseHeaders({})).end();
    });
    return;
  }
  const target =
    url.pathname === `/book/${encodeURIComponent(bookName)}` || url.pathname === `/book/${bookName}`
      ? bookAbs
      : join(packageRoot, normalize(url.pathname).replace(/^([/\\])+/, ''));
  if (!target.startsWith(packageRoot) && target !== bookAbs) {
    res.writeHead(403, baseHeaders({})).end();
    return;
  }
  // Transpile-on-request for the .ts harness files (page + worker).
  if (target.endsWith('.js') && !existsSync(target) && existsSync(target.replace(/\.js$/, '.ts'))) {
    const source = readFileSync(target.replace(/\.js$/, '.ts'), 'utf8');
    // TypeScript 7 removed the classic `ts.transpileModule` helper (its default
    // entry now exposes only the version). These harness files just need types
    // stripped to serve TS as JS to the browser, so use Node's built-in
    // type-stripper (mode 'transform' also lowers enums/namespaces).
    const out = stripTypeScriptTypes(source, { mode: 'transform' });
    res.writeHead(200, baseHeaders({ 'content-type': MIME['.js'] as string })).end(out);
    return;
  }
  if (!existsSync(target) || !statSync(target).isFile()) {
    res.writeHead(404, baseHeaders({})).end();
    return;
  }
  // version.js imports its package.json through the package self-reference, which
  // browsers do not resolve; rewrite it to the served /package.json.
  if (target === join(packageRoot, 'dist', 'version.js')) {
    const rewritten = readFileSync(target, 'utf8').replace(
      "'epubcheck-standalone/package.json'",
      "'/package.json'",
    );
    res.writeHead(200, baseHeaders({ 'content-type': MIME['.js'] as string })).end(rewritten);
    return;
  }
  const size = statSync(target).size;
  res.writeHead(
    200,
    baseHeaders({
      'content-type': MIME[extname(target)] ?? 'application/octet-stream',
      'content-length': String(size),
    }),
  );
  createReadStream(target).pipe(res);
});

await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const port = (server.address() as { port: number }).port;

const pageUrl =
  `http://127.0.0.1:${port}/testing/browser/csp.html` +
  `?book=${encodeURIComponent(`/book/${bookName}`)}&name=${encodeURIComponent(bookName)}`;

const profile = mkdtempSync(join(tmpdir(), 'epubcheck-csp-chrome-'));
const chromeArgs = [
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-background-networking',
  '--disable-sync',
  '--disable-component-update',
];
if (!headed) chromeArgs.push('--headless=new');
chromeArgs.push(pageUrl);

console.log(`[csp] serving ${packageRoot} on :${port} with CSP: ${CSP}`);
console.log(`[csp] book: ${bookAbs} (${statSync(bookAbs).size} bytes)`);
console.log(`[csp] chrome: ${CHROME} ${headed ? '(headed)' : '(--headless=new)'}`);

const chrome = spawn(CHROME, chromeArgs, { stdio: 'ignore' });

const maxMs = 300_000;
const t0 = Date.now();
const finished = await new Promise<boolean>((resolveDone) => {
  const poll = setInterval(() => {
    if (logLines.includes('=== DONE ===')) {
      clearInterval(poll);
      resolveDone(true);
    } else if (Date.now() - t0 > maxMs) {
      clearInterval(poll);
      resolveDone(false);
    }
  }, 300);
  chrome.on('exit', () => {
    if (!logLines.includes('=== DONE ===')) {
      clearInterval(poll);
      resolveDone(false);
    }
  });
});

await new Promise((r) => setTimeout(r, 500));

const summaryLine = logLines.find((l) => l.includes('"kind":"summary"'));
const violationLines = logLines.filter((l) => l.includes('"kind":"csp-violation"'));
let ok = false;
let summary: { cspViolations?: number; routesAgree?: boolean; main?: unknown; worker?: unknown } | null = null;
if (summaryLine) {
  try {
    summary = JSON.parse(summaryLine);
  } catch {
    summary = null;
  }
}

console.log('\n[csp] ---------------------------------------------');
if (summary) {
  ok = finished && summary.cspViolations === 0 && summary.routesAgree === true && violationLines.length === 0;
  console.log(`[csp] cspViolations=${summary.cspViolations} routesAgree=${summary.routesAgree}`);
  console.log(`[csp] main   = ${JSON.stringify(summary.main)}`);
  console.log(`[csp] worker = ${JSON.stringify(summary.worker)}`);
} else {
  console.log('[csp] no summary produced -- proof did not complete');
}
if (violationLines.length > 0) {
  console.log(`[csp] CSP VIOLATIONS (${violationLines.length}):`);
  for (const v of violationLines) console.log(`[csp]   ${v}`);
}
console.log(`[csp] VERDICT: ${ok ? 'PASS -- validated under CSP with no unsafe-eval, both routes' : 'FAIL'}`);

chrome.kill();
await new Promise<void>((resolveExit) => {
  if (chrome.exitCode !== null) {
    resolveExit();
    return;
  }
  chrome.on('exit', () => resolveExit());
  setTimeout(resolveExit, 10_000);
});
server.close();
try {
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
} catch {
  console.log(`[csp] note: temp profile left behind at ${profile}`);
}
process.exit(ok ? 0 : 1);
