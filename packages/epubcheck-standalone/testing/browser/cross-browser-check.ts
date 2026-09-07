#!/usr/bin/env node
// epubcheck-standalone -- CROSS-BROWSER engine proof driver (Chrome + Firefox + Safari).
//
//   node testing/browser/cross-browser-check.ts [path-to-epub] \
//        [--only=chrome,firefox,safari] [--headed]
//
// The footer claims the JavaScript build is "verified in Chrome, Firefox, and
// Safari". Only Chrome had been re-proven since the TeaVM migration. This driver
// proves all three on the SAME current engine (dist/epubcheck-engine.js): it
// serves the same package root under the SAME strict CSP the main-thread proof
// uses (no 'unsafe-eval'), transpiles the .ts page on request, and drives
// cross-browser-page.ts in each browser in turn. Per browser it asserts:
//   (a) the engine loads as a plain ES module under strict CSP with zero CSP
//       violations and instantiates (validate() returns a real verdict),
//   (b) the known fixture's verdict (exit/valid/messages/codes) matches the
//       shared reference verdict byte-for-byte across all three browsers,
//   (c) no console / JS errors, onMessage streamed live, a warm rerun matched,
//       and fileList()'s reads were async promises.
// Chrome runs via its headless binary (like main-thread-check.ts); Firefox via
// its headless binary; Safari via safaridriver's W3C WebDriver endpoint (a real
// Safari automation window -- Safari has no headless mode). Exit 0 only if every
// requested browser passed its gate and all verdicts agreed.

import { createServer, type Server } from 'node:http';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, extname, join, normalize, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const packageRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));

const args = process.argv.slice(2);
const headed = args.includes('--headed');
const onlyArg = args.find((a) => a.startsWith('--only='));
const requested = onlyArg
  ? onlyArg.slice('--only='.length).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  : ['chrome', 'firefox', 'safari'];

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

// Expanded tree for the fileList() scenario: unzip a minimal corpus book.
const minimalBook = join(packageRoot, 'test', 'corpus', 'epubcheck-prezipped', 'epub3_00-minimal_files_minimal.epub');
let expandedRoot: string | null = null;
let expandedManifest: Array<{ path: string; size: number }> = [];
let expandedTmp: string | null = null;
if (existsSync(minimalBook) && spawnSync('unzip', ['-v'], { encoding: 'utf8' }).status === 0) {
  expandedTmp = mkdtempSync(join(tmpdir(), 'epubcheck-xbrowser-exp-'));
  const dir = join(expandedTmp, 'minimal');
  mkdirSync(dir);
  spawnSync('unzip', ['-q', minimalBook, '-d', dir], { encoding: 'utf8' });
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const abs = join(d, entry.name);
      if (entry.isDirectory()) walk(abs);
      else expandedManifest.push({ path: relative(dir, abs).split(/[\\/]/).join('/'), size: statSync(abs).size });
    }
  };
  walk(dir);
  expandedManifest.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  expandedRoot = dir;
}

// The SAME strict CSP as csp-check.ts / main-thread-check.ts: no 'unsafe-eval'.
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

// Per-browser log buffer. `current` is swapped before each browser run.
let current: string[] = [];
function log(line: string): void {
  current.push(line);
}

const server: Server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
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
  if (url.pathname === '/expanded/manifest.json') {
    const body = JSON.stringify(expandedManifest);
    res.writeHead(200, baseHeaders({ 'content-type': MIME['.json'] as string, 'content-length': String(Buffer.byteLength(body)) })).end(body);
    return;
  }
  if (url.pathname.startsWith('/expanded/file/') && expandedRoot) {
    const rel = decodeURIComponent(url.pathname.slice('/expanded/file/'.length));
    const abs = join(expandedRoot, normalize(rel).replace(/^([/\\])+/, ''));
    if (!abs.startsWith(expandedRoot) || !existsSync(abs) || !statSync(abs).isFile()) {
      res.writeHead(404, baseHeaders({})).end();
      return;
    }
    res.writeHead(200, baseHeaders({ 'content-type': 'application/octet-stream', 'content-length': String(statSync(abs).size) }));
    createReadStream(abs).pipe(res);
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
  // Transpile-on-request for the .ts harness page.
  if (target.endsWith('.js') && !existsSync(target) && existsSync(target.replace(/\.js$/, '.ts'))) {
    const source = readFileSync(target.replace(/\.js$/, '.ts'), 'utf8');
    const out = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    res.writeHead(200, baseHeaders({ 'content-type': MIME['.js'] as string })).end(out);
    return;
  }
  if (!existsSync(target) || !statSync(target).isFile()) {
    res.writeHead(404, baseHeaders({})).end();
    return;
  }
  // version.js self-reference rewrite (browsers do not resolve package self-refs).
  if (target === join(packageRoot, 'dist', 'version.js')) {
    const rewritten = readFileSync(target, 'utf8').replace("'epubcheck-standalone/package.json'", "'/package.json'");
    res.writeHead(200, baseHeaders({ 'content-type': MIME['.js'] as string })).end(rewritten);
    return;
  }
  res.writeHead(200, baseHeaders({ 'content-type': MIME[extname(target)] ?? 'application/octet-stream', 'content-length': String(statSync(target).size) }));
  createReadStream(target).pipe(res);
});

await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const port = (server.address() as { port: number }).port;

const pageUrl =
  `http://127.0.0.1:${port}/testing/browser/cross-browser.html` +
  `?book=${encodeURIComponent(`/book/${bookName}`)}&name=${encodeURIComponent(bookName)}` +
  (expandedRoot ? `&expanded=1` : '');

console.log(`[main] serving ${packageRoot} on :${port}`);
console.log(`[main] CSP: ${CSP}`);
console.log(`[main] book: ${bookAbs} (${statSync(bookAbs).size} bytes)`);
console.log(`[main] expanded tree: ${expandedRoot ? `${expandedManifest.length} files` : 'unavailable (fileList scenario skipped)'}`);
console.log(`[main] browsers: ${requested.join(', ')}`);

interface Verdict {
  exit: number | null;
  valid: boolean;
  messages: number;
  codes: string[];
}
interface Summary {
  onMainThread?: boolean;
  cspViolations?: number;
  pageErrors?: number;
  run1?: Verdict;
  run1MessagesSeen?: number;
  run1SawLiveMessage?: boolean;
  run2?: Verdict;
  run2MatchesRun1?: boolean;
  expandedRan?: boolean;
  fileListExit?: number | null;
  fileListReads?: number;
  fileListReadsWerePromises?: boolean;
  fileListVerdict?: Verdict | null;
}

function waitForDone(lines: string[], maxMs: number): Promise<boolean> {
  const t0 = Date.now();
  return new Promise((resolveDone) => {
    const poll = setInterval(() => {
      if (lines.includes('=== DONE ===')) {
        clearInterval(poll);
        resolveDone(true);
      } else if (Date.now() - t0 > maxMs) {
        clearInterval(poll);
        resolveDone(false);
      }
    }, 300);
  });
}

async function tcpReady(host: string, p: number, maxMs: number): Promise<boolean> {
  const net = await import('node:net');
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const ok = await new Promise<boolean>((r) => {
      const s = net.connect(p, host, () => {
        s.end();
        r(true);
      });
      s.on('error', () => r(false));
      setTimeout(() => {
        s.destroy();
        r(false);
      }, 500);
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

interface RunResult {
  finished: boolean;
  summary: Summary | null;
  cspLines: string[];
  errorLines: string[];
  tool: string;
}

async function runChromeOrFirefox(kind: 'chrome' | 'firefox'): Promise<RunResult> {
  current = [];
  const isChrome = kind === 'chrome';
  const bin = isChrome
    ? process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : process.env.FIREFOX_BIN ?? '/Applications/Firefox.app/Contents/MacOS/firefox';
  if (!existsSync(bin)) {
    return { finished: false, summary: null, cspLines: [], errorLines: [`${kind} binary not found at ${bin}`], tool: bin };
  }
  const verOut = spawnSync(bin, ['--version'], { encoding: 'utf8' }).stdout?.trim() ?? kind;
  const profile = mkdtempSync(join(tmpdir(), `epubcheck-xbrowser-${kind}-`));
  let proc: ChildProcess;
  if (isChrome) {
    const cargs = [
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-sync',
      '--disable-component-update',
    ];
    if (!headed) cargs.push('--headless=new');
    cargs.push(pageUrl);
    proc = spawn(bin, cargs, { stdio: 'ignore' });
  } else {
    const fargs = ['--no-remote', '--new-instance', '--profile', profile];
    if (!headed) fargs.push('--headless');
    fargs.push(pageUrl);
    proc = spawn(bin, fargs, { stdio: 'ignore' });
  }
  const finished = await waitForDone(current, 300_000);
  await new Promise((r) => setTimeout(r, 400));
  const result = collect(finished, verOut);
  proc.kill();
  await new Promise((r) => setTimeout(r, 300));
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch {
    /* leave temp profile */
  }
  return result;
}

async function runSafari(): Promise<RunResult> {
  current = [];
  const driver = '/usr/bin/safaridriver';
  if (!existsSync(driver)) {
    return { finished: false, summary: null, cspLines: [], errorLines: [`safaridriver not found at ${driver}`], tool: driver };
  }
  const verOut = spawnSync(driver, ['--version'], { encoding: 'utf8' }).stdout?.trim() ?? 'safaridriver';
  const sdPort = 40000 + Math.floor(Math.random() * 20000);
  const sd = spawn(driver, ['-p', String(sdPort)], { stdio: 'ignore' });
  const up = await tcpReady('127.0.0.1', sdPort, 15_000);
  if (!up) {
    sd.kill();
    return { finished: false, summary: null, cspLines: [], errorLines: [`safaridriver did not open port ${sdPort}`], tool: verOut };
  }
  const base = `http://127.0.0.1:${sdPort}`;
  let sessionId = '';
  try {
    const sessRes = await fetch(`${base}/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ capabilities: { alwaysMatch: { browserName: 'safari' } } }),
    });
    const sessJson = (await sessRes.json()) as { value?: { sessionId?: string; error?: string; message?: string } };
    if (!sessRes.ok || !sessJson.value?.sessionId) {
      sd.kill();
      return {
        finished: false,
        summary: null,
        cspLines: [],
        errorLines: [`safaridriver session failed: HTTP ${sessRes.status} ${JSON.stringify(sessJson.value ?? {})}`],
        tool: verOut,
      };
    }
    sessionId = sessJson.value.sessionId;
    const navRes = await fetch(`${base}/session/${sessionId}/url`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: pageUrl }),
    });
    if (!navRes.ok) {
      const navJson = await navRes.text();
      throw new Error(`navigate failed: HTTP ${navRes.status} ${navJson}`);
    }
    const finished = await waitForDone(current, 300_000);
    await new Promise((r) => setTimeout(r, 400));
    const result = collect(finished, verOut);
    return result;
  } catch (err) {
    return { finished: false, summary: null, cspLines: [], errorLines: [String((err as Error)?.message ?? err)], tool: verOut };
  } finally {
    if (sessionId) {
      try {
        await fetch(`${base}/session/${sessionId}`, { method: 'DELETE' });
      } catch {
        /* ignore */
      }
    }
    sd.kill();
    await new Promise((r) => setTimeout(r, 300));
  }
}

function collect(finished: boolean, tool: string): RunResult {
  const summaryLine = current.find((l) => l.includes('"kind":"summary"'));
  const cspLines = current.filter((l) => l.includes('"kind":"csp-violation"'));
  const errorLines = current.filter(
    (l) => l.includes('"kind":"error"') || l.includes('"kind":"page-error"') || l.includes('"kind":"page-rejection"'),
  );
  let summary: Summary | null = null;
  if (summaryLine) {
    try {
      summary = JSON.parse(summaryLine) as Summary;
    } catch {
      summary = null;
    }
  }
  return { finished, summary, cspLines, errorLines, tool };
}

const results = new Map<string, RunResult>();
for (const b of requested) {
  console.log(`\n[main] === launching ${b} ===`);
  if (b === 'chrome' || b === 'firefox') results.set(b, await runChromeOrFirefox(b));
  else if (b === 'safari') results.set(b, await runSafari());
  else console.log(`[main] unknown browser '${b}' -- skipped`);
}

// Shared reference verdict: prefer Chrome, else the first browser that produced one.
let reference: Verdict | null = null;
let referenceFrom = '';
for (const b of ['chrome', 'firefox', 'safari']) {
  const r = results.get(b);
  if (r?.summary?.run1?.exit != null) {
    reference = r.summary.run1;
    referenceFrom = b;
    break;
  }
}

function verdictEq(a: Verdict | null | undefined, ref: Verdict | null): boolean {
  if (!a || !ref) return false;
  return a.exit === ref.exit && a.valid === ref.valid && a.messages === ref.messages && JSON.stringify(a.codes) === JSON.stringify(ref.codes);
}

console.log('\n[main] =================================================');
console.log(`[main] reference verdict (from ${referenceFrom || 'none'}): ${JSON.stringify(reference)}`);
const expandedExpected = expandedRoot !== null;
let allOk = true;
for (const b of requested) {
  const r = results.get(b);
  if (!r) {
    allOk = false;
    continue;
  }
  const s = r.summary;
  const engineLoaded = !!s && typeof s.run1?.exit === 'number';
  const verdictMatches = verdictEq(s?.run1, reference);
  const live = s?.run1SawLiveMessage === true && (s?.run1MessagesSeen ?? 0) > 0;
  const rerun = s?.run2MatchesRun1 === true;
  const noCsp = (s?.cspViolations ?? 1) === 0 && r.cspLines.length === 0;
  const noErrors = (s?.pageErrors ?? 1) === 0 && r.errorLines.length === 0;
  const mainThread = s?.onMainThread === true;
  const fileListOk =
    !expandedExpected ||
    (s?.expandedRan === true && typeof s?.fileListExit === 'number' && (s?.fileListReads ?? 0) > 0 && s?.fileListReadsWerePromises === true);
  const ok = r.finished && engineLoaded && verdictMatches && live && rerun && noCsp && noErrors && mainThread && fileListOk;
  allOk &&= ok;

  console.log(`\n[main] ----- ${b.toUpperCase()} (${r.tool}) -----`);
  console.log(`[main]   finished:                 ${r.finished}`);
  console.log(`[main]   engine loaded under CSP:  ${engineLoaded}   verdict=${JSON.stringify(s?.run1)}`);
  console.log(`[main]   verdict matches reference:${verdictMatches}`);
  console.log(`[main]   onMessage live:           ${live}   (seen=${s?.run1MessagesSeen}, live=${s?.run1SawLiveMessage})`);
  console.log(`[main]   warm rerun matched:       ${rerun}`);
  console.log(`[main]   fileList async reads:     ${fileListOk}   (ran=${s?.expandedRan}, exit=${s?.fileListExit}, reads=${s?.fileListReads}, promises=${s?.fileListReadsWerePromises})`);
  console.log(`[main]   zero CSP violations:      ${noCsp}   (count=${s?.cspViolations}, lines=${r.cspLines.length})`);
  console.log(`[main]   zero console errors:      ${noErrors}   (pageErrors=${s?.pageErrors}, lines=${r.errorLines.length})`);
  console.log(`[main]   real main thread:         ${mainThread}`);
  for (const e of r.errorLines) console.log(`[main]     ERROR: ${e}`);
  for (const c of r.cspLines) console.log(`[main]     CSP:   ${c}`);
  console.log(`[main]   ==> ${ok ? 'PASS' : 'FAIL'}`);
}

console.log('\n[main] =================================================');
console.log(`[main] VERDICT: ${allOk ? 'PASS -- engine verified under strict CSP in ' + requested.join(', ') + ' with identical verdicts' : 'FAIL'}`);

server.close();
if (expandedTmp) {
  try {
    rmSync(expandedTmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch {
    /* leave temp tree */
  }
}
process.exit(allOk ? 0 : 1);
