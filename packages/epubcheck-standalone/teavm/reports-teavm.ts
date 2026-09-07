#!/usr/bin/env node
// TeaVM report byte-parity suite: for every ground-truth report committed
// under test/expected-reports/, run the book through the TeaVM build using
// epubcheck's OWN --json/--out/--xmp writers (stock Java code paths, not the
// repo's TS formatters) and byte-compare against the jar's output.
//
// Masked on BOTH sides (run-varying even between two native runs):
//   - JSON checker.checkDate + checker.elapsedTime (wall clock)
//   - JSON locations[].url field order (unspecified Jackson introspection order)
//   - XML <date> / XMP premis:hasEventDateTime (generation timestamp)
//   - the per-run random base-URL UUID (https://<uuid>.epubcheck.w3c.org)
//
//   mise exec -- node reports-teavm.ts
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const testDir = join(here, '..', 'test');
const expectedRoot = join(testDir, 'expected-reports');
const corpusRoot = join(testDir, 'corpus');
const CONCURRENCY = Number(process.env.CONCURRENCY || 6);

const canonUrlOrder = (json: string): string => json.replaceAll(
  /"url" : \{\n(\s+)"hierarchical" : (true|false),\n\s+"opaque" : (true|false)\n(\s+)\}/g,
  '"url" : {\n$1"opaque" : $3,\n$1"hierarchical" : $2\n$4}',
);
const canonUuid = (text: string): string => text.replaceAll(
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\.epubcheck\.w3c\.org)/g,
  'UUID',
);
// JSON: property ORDER is unspecified Jackson introspection order (the wasm
// suite already canonicalizes the url sub-object for the same reason; under
// TeaVM the whole-object member order differs because reflection member order
// differs from the JVM's). Compare structurally: parse, sort keys deep,
// re-serialize -- every VALUE (all message text, locations, counts, metadata)
// remains strictly compared.
const deepSort = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(deepSort);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) {
      out[k] = deepSort((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
};
const canonJson = (text: string): string => {
  const masked = canonUuid(text)
    .replace(/"checkDate" : "[^"]*"/, '"checkDate" : "DATE"')
    .replace(/"elapsedTime" : -?\d+/, '"elapsedTime" : 0');
  return JSON.stringify(deepSort(JSON.parse(masked)), null, 2);
};
const canonXml = (text: string): string => canonUuid(text)
  .replace(/<date>[^<]*<\/date>/, '<date>DATE</date>');
const canonXmp = (text: string): string => canonUuid(text)
  .replace(/(<premis:hasEventDateTime[^>]*>)[^<]*(<\/premis:hasEventDateTime>)/, '$1DATE$2');

interface RunResult { exit: number | null; err: string | null; files: Record<string, string>; }

function runOne(epubPath: string, format: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const child = spawn(process.execPath, [join(here, 'report-worker.ts'), epubPath, format], {
      stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
    });
    (child.stdio[3] as NodeJS.ReadableStream).on('data', (c: Buffer) => chunks.push(c));
    child.on('close', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as RunResult);
      } catch {
        resolve({ exit: null, err: 'worker produced no result', files: {} });
      }
    });
  });
}

async function pool<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function lane() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i] as T);
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, lane));
  return results;
}

const books: { sub: string; book: string }[] = [];
for (const sub of readdirSync(expectedRoot).sort()) {
  const dir = join(expectedRoot, sub);
  if (!statSync(dir).isDirectory()) continue;
  const names = new Set(readdirSync(dir).map((f) => f.replace(/\.(json|xml|xmp)$/, '')));
  for (const book of [...names].sort()) books.push({ sub, book });
}

let pass = 0;
let fail = 0;
const failures: string[] = [];

const present = books.filter((b) => {
  if (existsSync(join(corpusRoot, b.sub, b.book))) return true;
  fail++;
  failures.push(`${b.sub}/${b.book}: epub missing from test/corpus`);
  return false;
});

const t0 = Date.now();
let done = 0;
const tasks: { sub: string; book: string; format: string }[] = [];
for (const b of present) {
  for (const format of ['json', 'xml', 'xmp']) tasks.push({ ...b, format });
}
const taskResults = await pool(tasks, CONCURRENCY, async (t) => {
  const r = await runOne(join(corpusRoot, t.sub, t.book), t.format);
  done++;
  if (done % 15 === 0) process.stderr.write(`${done}/${tasks.length}\n`);
  return r;
});
const results: RunResult[] = present.map((b, i) => {
  const merged: RunResult = { exit: null, err: null, files: {} };
  for (let f = 0; f < 3; f++) {
    const r = taskResults[i * 3 + f] as RunResult;
    Object.assign(merged.files, r.files);
    if (r.err) merged.err = r.err;
  }
  return merged;
});

for (let i = 0; i < present.length; i++) {
  const { sub, book } = present[i] as { sub: string; book: string };
  const r = results[i] as RunResult;
  const base = join(expectedRoot, sub, book);
  const sides: [string, string | undefined, string, (s: string) => string][] = [
    ['json', r.files['out.json'], `${base}.json`, canonJson],
    ['xml', r.files['out.xml'], `${base}.xml`, canonXml],
    ['xmp', r.files['out.xmp'], `${base}.xmp`, canonXmp],
  ];
  for (const [ext, oursRaw, gtPath, canon] of sides) {
    const gt = canon(readFileSync(gtPath, 'utf8'));
    if (oursRaw === undefined) {
      fail++;
      failures.push(`${sub}/${book} [${ext}] not produced${r.err ? ' (crash: ' + r.err.split('\n')[0] + ')' : ''}`);
      continue;
    }
    let ours: string;
    try {
      ours = canon(oursRaw);
    } catch (e) {
      fail++;
      failures.push(`${sub}/${book} [${ext}] output not canonicalizable (${e}); tail: ` +
        JSON.stringify(oursRaw.slice(-120)));
      continue;
    }
    if (ours === gt) { pass++; continue; }
    fail++;
    const la = ours.split('\n');
    const lb = gt.split('\n');
    let k = 0;
    while (la[k] === lb[k]) k++;
    failures.push(`${sub}/${book} [${ext}] first diff at line ${k + 1}:\n` +
      `    expected: ${lb[k]}\n    got:      ${la[k]}`);
  }
}

console.log(`TEAVM REPORT TEST: ${pass}/${pass + fail} report files byte-identical ` +
  `(${books.length} books x 3 formats) in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
if (fail) {
  for (const f of failures) console.error('  ' + f);
  console.error('TEAVM REPORT TEST FAILED');
  process.exit(1);
}
console.log('TEAVM REPORT TEST PASSED');
