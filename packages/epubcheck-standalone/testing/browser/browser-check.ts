#!/usr/bin/env node
// epubcheck-standalone -- headless-Chrome driver for the browser streaming
// proof (the TeaVM-era successor of the retired wasm-era headless-check).
//
//   node testing/browser/browser-check.ts <path-to-epub> [options]
//
// Options:
//   --mode blob|opfsimport|mainblob
//                            range-source route (default blob):
//                              blob        fetch -> Blob -> blob() source, in
//                                          a dedicated Worker (FileReaderSync)
//                              opfsimport  fetch -> stream into OPFS sync
//                                          handle -> opfs() source, in place,
//                                          in a dedicated Worker
//                              mainblob    fetch -> Blob -> blob() source ON
//                                          THE PAGE'S MAIN THREAD (no Worker
//                                          at all): the async-read path, where
//                                          the engine suspends per block on
//                                          blob.slice().arrayBuffer()
//   --max-ms N               give up after N ms (default 3,600,000)
//   --headed                 run a visible Chrome instead of --headless=new
//
// What it does:
//   1. serves the PACKAGE ROOT over http (so /dist/validate-browser.js,
//      /dist/epubcheck-engine.js, the harness files, and the book are all
//      same-origin; .ts harness files are transpiled to .js on request; the
//      book is streamed with fs.createReadStream -- a 16 GB file never enters
//      server memory);
//   2. launches a FRESH-TEMP-PROFILE Chrome (bone stock, no --js-flags) at
//      /testing/browser/harness.html with the run's parameters;
//   3. collects the worker's progress messages via POST /log, samples every
//      renderer process's RSS once a second (ps), and waits for the
//      "=== DONE ===" marker;
//   4. prints the run's result + peak renderer RSS and exits 0 only if the
//      validation completed (whatever its exit code -- the assertion is about
//      the STREAMING PATH; callers check the printed exit themselves).

import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';

const packageRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));

const args = process.argv.slice(2);
const epubPath = args.find((a) => !a.startsWith('--'));
if (!epubPath || !existsSync(epubPath)) {
  console.error('usage: node testing/browser/browser-check.ts <path-to-epub> [--mode blob|opfsimport|mainblob] [--max-ms N] [--headed]');
  process.exit(64);
}
const modeArg = args.includes('--mode') ? args[args.indexOf('--mode') + 1] : 'blob';
const mode = modeArg === 'opfsimport' || modeArg === 'mainblob' ? modeArg : 'blob';
const maxMs = args.includes('--max-ms') ? Number(args[args.indexOf('--max-ms') + 1]) : 3_600_000;
const headed = args.includes('--headed');

const bookAbs = resolve(epubPath);
const bookName = basename(bookAbs);

const CHROME = process.env.CHROME_BIN
  ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!existsSync(CHROME)) {
  console.error(`Chrome not found at ${CHROME} (set CHROME_BIN)`);
  process.exit(69);
}

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
  console.log(`[harness] ${line}`);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (req.method === 'POST' && url.pathname === '/log') {
    let body = '';
    req.on('data', (c: Buffer) => { body += c.toString('utf8'); });
    req.on('end', () => {
      log(body);
      res.writeHead(204).end();
    });
    return;
  }
  // The book is served under a fixed alias so it can live anywhere on disk.
  const target = url.pathname === `/book/${encodeURIComponent(bookName)}` || url.pathname === `/book/${bookName}`
    ? bookAbs
    : join(packageRoot, normalize(url.pathname).replace(/^([/\\])+/, ''));
  if (!target.startsWith(packageRoot) && target !== bookAbs) {
    res.writeHead(403).end();
    return;
  }
  // Transpile-on-request: a .js request whose file does not exist but whose
  // .ts sibling does gets the transpiled TypeScript (harness files only).
  if (target.endsWith('.js') && !existsSync(target) && existsSync(target.replace(/\.js$/, '.ts'))) {
    const source = readFileSync(target.replace(/\.js$/, '.ts'), 'utf8');
    // TypeScript 7 removed the classic `ts.transpileModule` helper (its default
    // entry now exposes only the version). These harness files just need types
    // stripped to serve TS as JS to the browser, so use Node's built-in
    // type-stripper (mode 'transform' also lowers enums/namespaces).
    const out = stripTypeScriptTypes(source, { mode: 'transform' });
    res.writeHead(200, { 'content-type': MIME['.js'] as string }).end(out);
    return;
  }
  if (!existsSync(target) || !statSync(target).isFile()) {
    res.writeHead(404).end();
    return;
  }
  // The library's version module imports its package.json through the package
  // SELF-REFERENCE (a bare specifier bundlers and Node resolve, browsers do
  // not -- and import maps do not reach module workers). Serve dist/version.js
  // with that one specifier rewritten to the served /package.json.
  if (target === join(packageRoot, 'dist', 'version.js')) {
    const rewritten = readFileSync(target, 'utf8')
      .replace("'epubcheck-standalone/package.json'", "'/package.json'");
    res.writeHead(200, { 'content-type': MIME['.js'] as string }).end(rewritten);
    return;
  }
  const size = statSync(target).size;
  res.writeHead(200, {
    'content-type': MIME[extname(target)] ?? 'application/octet-stream',
    'content-length': String(size),
  });
  createReadStream(target).pipe(res);
});

await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const port = (server.address() as { port: number }).port;

const pageUrl = `http://127.0.0.1:${port}/testing/browser/harness.html`
  + `?mode=${mode}&book=${encodeURIComponent(`/book/${bookName}`)}&name=${encodeURIComponent(bookName)}`;

const profile = mkdtempSync(join(tmpdir(), 'epubcheck-harness-chrome-'));
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

console.log(`[harness] serving ${packageRoot} on :${port}`);
console.log(`[harness] book: ${bookAbs} (${(statSync(bookAbs).size / 1e9).toFixed(3)} GB), mode: ${mode}`);
console.log(`[harness] chrome: ${CHROME} ${headed ? '(headed)' : '(--headless=new)'}`);

const chrome = spawn(CHROME, chromeArgs, { stdio: 'ignore' });

// Sample every renderer's RSS once a second via ps; track the peak.
let peakRendererRssKb = 0;
function sampleRss(): void {
  execFile('ps', ['-axo', 'pid=,ppid=,rss=,command='], (err, stdout) => {
    if (err) return;
    for (const line of stdout.split('\n')) {
      if (!line.includes('--type=renderer')) continue;
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s/);
      if (!m) continue;
      if (Number(m[2]) === chrome.pid) {
        peakRendererRssKb = Math.max(peakRendererRssKb, Number(m[3]));
      }
    }
  });
}

const t0 = Date.now();
const rssTimer = setInterval(sampleRss, 1000);

const finished = await new Promise<boolean>((resolveDone) => {
  const poll = setInterval(() => {
    if (logLines.includes('=== DONE ===')) {
      clearInterval(poll);
      resolveDone(true);
    } else if (Date.now() - t0 > maxMs) {
      clearInterval(poll);
      resolveDone(false);
    }
  }, 500);
  chrome.on('exit', () => {
    // Chrome dying before DONE is a failure; the poll notices via timeout,
    // so shorten it here.
    if (!logLines.includes('=== DONE ===')) {
      clearInterval(poll);
      resolveDone(false);
    }
  });
});

clearInterval(rssTimer);
sampleRss();
await new Promise((r) => setTimeout(r, 1200));

// Print the verdict BEFORE cleanup, so a cleanup hiccup can never eat it.
const wallMs = Date.now() - t0;
const doneLine = logLines.find((l) => l.includes('"kind":"done"'));
console.log('\n[harness] ---------------------------------------------');
console.log(`[harness] finished=${finished} wall=${(wallMs / 1000).toFixed(1)}s peakRendererRSS=${(peakRendererRssKb / 1024).toFixed(0)} MiB`);
if (doneLine) console.log(`[harness] result: ${doneLine}`);

chrome.kill();
// Wait for Chrome to actually exit before deleting its profile (it keeps
// writing during shutdown; deleting under it races into ENOTEMPTY).
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
  console.log(`[harness] note: temp profile left behind at ${profile}`);
}
process.exit(finished && doneLine ? 0 : 1);
