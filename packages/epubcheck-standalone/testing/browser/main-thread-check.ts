#!/usr/bin/env node
// epubcheck-standalone -- headless-Chrome MAIN-THREAD integration proof.
//
//   node testing/browser/main-thread-check.ts [path-to-epub] [--headed]
//
// The newest features only exercise their interesting path on a browser MAIN
// thread: async Blob reads that suspend the engine mid-run, an abort during
// those reads, and warm-scope reuse/discard across runs, plus the plugins the
// async-first sweep un-restricted from Worker-only (fileList/opfs/opfsDir) and
// the Blob customMessages main-thread fix. The Node suites prove the logic;
// this proves the combination where it matters -- in a page, with no Worker
// anywhere. It drives main-thread-page.ts, which runs these scenarios in order
// in ONE page:
//   1. blob(): a small book as a Blob validates to a verdict, and onMessage
//      fires LIVE mid-run (the tap streams before validate() settles).
//   2. abort mid-flight: the run rejects with the AbortError reason while a
//      blob read is in flight (the honest abort window -- aborts land at read
//      boundaries; here a slowed main-thread blob read opens the window).
//   3. clean run again: the same book validates once more and the verdict
//      matches scenario 1 (the aborted scope was discarded, next run healthy).
//   4. fileList() on the main thread: an expanded book (unzipped server-side,
//      fetched into File[]) validates, and its reads are promises (the async
//      slice().arrayBuffer() path, not FileReaderSync).
//   5. opfs()/opfsDir() on the main thread: the book and the expanded tree are
//      written into OPFS (createWritable, main-thread-legal in Chrome) and read
//      back through getFile()+slice().arrayBuffer(); opfs() single matches the
//      blob() verdict, opfsDir() matches fileList().
//   6. Blob customMessages on the main thread: a Blob override is read with
//      async Blob.arrayBuffer() (not FileReaderSync) and its suppression applies.
// Scenarios 4 and 5 are skipped if unzip or the minimal corpus book is absent.
//
// It is a sibling of csp-check.ts: same package-root static server +
// transpile-on-request + version.js self-reference rewrite, and the SAME strict
// CSP header (no 'unsafe-eval') on every response. Exit 0 only if the page
// finished, all three scenarios asserted true, and there were zero CSP
// violations.

import { createServer } from 'node:http';
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
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, extname, join, normalize, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const packageRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));

const args = process.argv.slice(2);
const headed = args.includes('--headed');
// Default to a tiny committed corpus book (the same one csp-check.ts uses). Any
// small .epub works; the proof is about the main-thread paths, not the verdict.
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

// Expanded (directory) tree for the fileList()/opfsDir() main-thread scenarios:
// unzip a minimal corpus book into a temp dir and expose its files as a
// manifest the page fetches to build File[] and to populate OPFS. Best-effort:
// if unzip or the corpus book is missing, the expanded scenarios are skipped
// (the page still runs the blob/abort/opfs-single scenarios).
const minimalBook = join(
  packageRoot,
  'test',
  'corpus',
  'epubcheck-prezipped',
  'epub3_00-minimal_files_minimal.epub',
);
let expandedRoot: string | null = null;
let expandedManifest: Array<{ path: string; size: number }> = [];
let expandedTmp: string | null = null;
if (existsSync(minimalBook) && spawnSync('unzip', ['-v'], { encoding: 'utf8' }).status === 0) {
  expandedTmp = mkdtempSync(join(tmpdir(), 'epubcheck-mainthread-exp-'));
  const dir = join(expandedTmp, 'minimal');
  mkdirSync(dir);
  spawnSync('unzip', ['-q', minimalBook, '-d', dir], { encoding: 'utf8' });
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const abs = join(d, entry.name);
      if (entry.isDirectory()) walk(abs);
      else {
        const rel = relative(dir, abs).split(/[\\/]/).join('/');
        expandedManifest.push({ path: rel, size: statSync(abs).size });
      }
    }
  };
  walk(dir);
  expandedManifest.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  expandedRoot = dir;
}

const CHROME = process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!existsSync(CHROME)) {
  console.error(`Chrome not found at ${CHROME} (set CHROME_BIN)`);
  process.exit(69);
}

// The SAME strict CSP as csp-check.ts: same-origin scripts/workers/connections,
// but NO 'unsafe-eval' (and no 'wasm-unsafe-eval'). This proof creates no Worker
// but keeps worker-src 'self' so the policy is byte-identical to the CSP sibling.
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
  console.log(`[main] ${line}`);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  // Every response carries the strict CSP header.
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
  // Expanded-tree routes for the fileList()/opfsDir() scenarios.
  if (url.pathname === '/expanded/manifest.json') {
    const body = JSON.stringify(expandedManifest);
    res
      .writeHead(200, baseHeaders({ 'content-type': MIME['.json'] as string, 'content-length': String(Buffer.byteLength(body)) }))
      .end(body);
    return;
  }
  if (url.pathname.startsWith('/expanded/file/') && expandedRoot) {
    const rel = decodeURIComponent(url.pathname.slice('/expanded/file/'.length));
    const abs = join(expandedRoot, normalize(rel).replace(/^([/\\])+/, ''));
    if (!abs.startsWith(expandedRoot) || !existsSync(abs) || !statSync(abs).isFile()) {
      res.writeHead(404, baseHeaders({})).end();
      return;
    }
    const size = statSync(abs).size;
    res.writeHead(200, baseHeaders({ 'content-type': 'application/octet-stream', 'content-length': String(size) }));
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
  // Transpile-on-request for the .ts harness files (the page module).
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
  `http://127.0.0.1:${port}/testing/browser/main-thread.html` +
  `?book=${encodeURIComponent(`/book/${bookName}`)}&name=${encodeURIComponent(bookName)}` +
  (expandedRoot ? `&expanded=1` : '');

const profile = mkdtempSync(join(tmpdir(), 'epubcheck-mainthread-chrome-'));
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

console.log(`[main] serving ${packageRoot} on :${port} with CSP: ${CSP}`);
console.log(`[main] book: ${bookAbs} (${statSync(bookAbs).size} bytes)`);
console.log(`[main] chrome: ${CHROME} ${headed ? '(headed)' : '(--headless=new)'}`);

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

interface Summary {
  cspViolations?: number;
  run1?: { exit: number | null; valid: boolean; messages: number };
  run1SawLiveMessage?: boolean;
  run1MessagesSeen?: number;
  abortRejected?: boolean;
  abortReads?: number;
  abortName?: string;
  run3?: { exit: number | null; valid: boolean; messages: number };
  run3MatchesRun1?: boolean;
  // Async main-thread scenarios for the newly un-restricted plugins.
  expandedRan?: boolean;
  fileListExit?: number | null;
  fileListReadsWerePromises?: boolean;
  fileListReads?: number;
  opfsRan?: boolean;
  opfsSingleMatchesRun1?: boolean;
  opfsDirExit?: number | null;
  opfsDirMatchesFileList?: boolean;
  customMsgRan?: boolean;
  customMsgThrew?: boolean;
  customMsgApplied?: boolean;
}

const summaryLine = logLines.find((l) => l.includes('"kind":"summary"'));
const violationLines = logLines.filter((l) => l.includes('"kind":"csp-violation"'));
let summary: Summary | null = null;
if (summaryLine) {
  try {
    summary = JSON.parse(summaryLine) as Summary;
  } catch {
    summary = null;
  }
}

let ok = false;
console.log('\n[main] ---------------------------------------------');
if (summary) {
  const s1Completed = summary.run1 !== undefined && typeof summary.run1.exit === 'number';
  const s1Live = summary.run1SawLiveMessage === true && (summary.run1MessagesSeen ?? 0) > 0;
  const s2Aborted = summary.abortRejected === true && (summary.abortReads ?? 0) > 0;
  const s3Clean = summary.run3MatchesRun1 === true;
  const noCsp = summary.cspViolations === 0 && violationLines.length === 0;
  // fileList() main-thread: it ran, produced a verdict, and its reads were
  // promises (proving the async slice().arrayBuffer() path, not a sync read).
  const s4FileList =
    summary.expandedRan === true &&
    typeof summary.fileListExit === 'number' &&
    summary.fileListReadsWerePromises === true &&
    (summary.fileListReads ?? 0) > 0;
  // OPFS main-thread (opfs single-file + opfsDir), when the browser allows OPFS
  // writes on the main thread (Chrome does). opfs() single must match the
  // blob() verdict on the same book; opfsDir() must match fileList().
  const s5Opfs =
    summary.opfsRan === true &&
    summary.opfsSingleMatchesRun1 === true &&
    typeof summary.opfsDirExit === 'number' &&
    summary.opfsDirMatchesFileList === true;
  // Blob customMessages on the main thread: ran, did not throw, and applied.
  const s6CustomMsg =
    summary.customMsgRan === true && summary.customMsgThrew !== true && summary.customMsgApplied === true;
  // The expanded (fileList/opfsDir) and OPFS scenarios are required only when
  // the driver set up the expanded tree (unzip + corpus book present).
  const expandedExpected = expandedRoot !== null;
  ok =
    finished &&
    s1Completed &&
    s1Live &&
    s2Aborted &&
    s3Clean &&
    noCsp &&
    s6CustomMsg &&
    (!expandedExpected || (s4FileList && s5Opfs));

  console.log(`[main] scenario 1  blob() completed:        ${s1Completed}  verdict=${JSON.stringify(summary.run1)}`);
  console.log(`[main] scenario 1  onMessage fired LIVE:    ${s1Live}  (messagesSeen=${summary.run1MessagesSeen}, sawLive=${summary.run1SawLiveMessage})`);
  console.log(`[main] scenario 2  aborted mid-flight:      ${s2Aborted}  (reads=${summary.abortReads}, error=${summary.abortName})`);
  console.log(`[main] scenario 3  clean run matches run 1: ${s3Clean}  verdict=${JSON.stringify(summary.run3)}`);
  console.log(`[main] scenario 4  fileList() main-thread:  ${s4FileList}  exit=${summary.fileListExit} reads=${summary.fileListReads} promises=${summary.fileListReadsWerePromises}`);
  console.log(`[main] scenario 5  opfs()/opfsDir() m-thd:  ${s5Opfs}  opfsSingle=${summary.opfsSingleMatchesRun1} opfsDirExit=${summary.opfsDirExit} opfsDirMatchesFileList=${summary.opfsDirMatchesFileList}`);
  console.log(`[main] scenario 6  Blob customMessages:     ${s6CustomMsg}  ran=${summary.customMsgRan} threw=${summary.customMsgThrew} applied=${summary.customMsgApplied}`);
  console.log(`[main] cspViolations=${summary.cspViolations}`);
} else {
  console.log('[main] no summary produced -- proof did not complete');
}
if (violationLines.length > 0) {
  console.log(`[main] CSP VIOLATIONS (${violationLines.length}):`);
  for (const v of violationLines) console.log(`[main]   ${v}`);
}
console.log(
  `[main] VERDICT: ${
    ok
      ? 'PASS -- main-thread blob() + live onMessage, mid-flight abort, clean scope-reuse rerun, fileList()/opfs()/opfsDir() async reads, and Blob customMessages, all under strict CSP'
      : 'FAIL'
  }`,
);

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
  console.log(`[main] note: temp profile left behind at ${profile}`);
}
if (expandedTmp) {
  try {
    rmSync(expandedTmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch {
    console.log(`[main] note: temp expanded tree left behind at ${expandedTmp}`);
  }
}
process.exit(ok ? 0 : 1);
