#!/usr/bin/env node
// Consumer packaging test: prove what `npm pack` actually ships works for a
// real outside consumer -- NOT the in-repo source the other suites import.
//
//   mise exec -- node testing/pack-consumer.ts
//
// Every other suite in this package imports from ../dist or the package root, so
// they never exercise the published surface: the `exports` map, the `files`
// field, the package self-reference (`epubcheck-standalone/package.json`, which
// EPUBCHECK_VERSION relies on), or the shipped .d.ts as a stranger's tsc sees
// them. Those three are the classic first-publish breakages. This test packs the
// library, installs the tarball into a throwaway project, and checks it from the
// OUTSIDE.
//
// What it does, failing loudly at every step:
//   1. Refresh dist (tsc only -- the ~21 MB engine must already be built) and
//      confirm the engine asset is present, then `npm pack` into a temp dir.
//   2. Inspect the tarball listing: required files present, nothing junk.
//   3. Make a fresh consumer project ("type":"module"), `npm install` the
//      tarball plus typescript (public-registry deps are fine; nothing is
//      published).
//   4. Copy the known-good fixture (test/fixtures/test.epub) in, then from the
//      INSTALLED package import { validate, fs } in an ESM TypeScript file and
//      assert the same verdict the in-repo smoke test asserts (valid, exit 0,
//      zero errors, no ERROR/FATAL). This also proves the self-reference import
//      resolves, because EPUBCHECK_VERSION would throw otherwise.
//   5. Typecheck a consumer .ts against the SHIPPED declarations under both
//      module-resolution modes a consumer might pick: nodenext and bundler.
//
// Temp files: by default under the OS temp dir. Set PACK_CONSUMER_TMP to place
// the throwaway project elsewhere (this repo's agents point it at their session
// scratchpad, never /tmp and never inside the repo). The work dir is removed on
// success and kept on failure for debugging.

import { execFileSync, type ExecFileSyncOptions } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_DIR = fileURLToPath(new URL('..', import.meta.url)); // packages/epubcheck-standalone
const FIXTURE = join(PKG_DIR, 'test', 'fixtures', 'test.epub');
const ENGINE_ASSET = join(PKG_DIR, 'dist', 'epubcheck-engine.js');

// The npm the pinned toolchain resolves (mise puts it on PATH). Everything runs
// through this so the test never picks up a stray global npm.
const NPM = 'npm';

let failures = 0;
function check(name: string, cond: unknown, detail?: string): void {
  if (cond) {
    console.log(`  ok  - ${name}`);
  } else {
    failures++;
    console.log(`  NOT OK - ${name}${detail ? ': ' + detail : ''}`);
  }
}

// Extract the exported symbol names from a .d.ts, ignoring the `default` export.
// Covers the forms tsc's declaration emit produces: `export declare
// function/const/class/enum NAME`, `export interface/type/enum/class NAME`, and
// re-export lists `export [type] { a, b as c } [from '...'];`. Inline type
// references (e.g. a function returning `import("./x.js").Foo`) are NOT exports
// and are correctly not matched -- that is exactly what lets a subpath USE a
// type it does not re-export.
function exportedNames(dts: string): Set<string> {
  const names = new Set<string>();
  // export declare function/const/let/var/class/enum/namespace NAME
  for (const m of dts.matchAll(
    /^export\s+declare\s+(?:abstract\s+)?(?:function|const|let|var|class|enum|namespace)\s+([A-Za-z_$][\w$]*)/gm,
  )) {
    names.add(m[1]!);
  }
  // export interface/type/enum/class NAME (no `declare`)
  for (const m of dts.matchAll(
    /^export\s+(?:interface|type|enum|abstract\s+class|class)\s+([A-Za-z_$][\w$]*)/gm,
  )) {
    names.add(m[1]!);
  }
  // export [type] { a, b as c, ... } [from '...'];
  for (const m of dts.matchAll(/^export\s+(?:type\s+)?\{([^}]*)\}/gm)) {
    for (const raw of m[1]!.split(',')) {
      const part = raw.trim();
      if (!part) continue;
      // "orig as exported" -> the exported (public) name is what follows `as`.
      const exported = / as /.test(part) ? part.split(/\s+as\s+/).pop()!.trim() : part;
      const clean = exported.replace(/^type\s+/, '').trim();
      if (clean && clean !== 'default') names.add(clean);
    }
  }
  names.delete('default');
  return names;
}

// Run a command, throwing a clear, labelled error when it fails. stdout is
// captured and returned; stderr streams through so npm progress stays visible.
function run(label: string, cmd: string, args: string[], opts: ExecFileSyncOptions = {}): string {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
      ...opts,
    }).toString();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`STEP FAILED (${label}): \`${cmd} ${args.join(' ')}\`\n${message}`);
  }
}

// --- work dir ----------------------------------------------------------------
const tmpBase = process.env.PACK_CONSUMER_TMP || tmpdir();
mkdirSync(tmpBase, { recursive: true });
const workDir = mkdtempSync(join(tmpBase, 'epubcheck-pack-consumer-'));
const consumerDir = join(workDir, 'consumer');
mkdirSync(consumerDir, { recursive: true });
console.log('work dir:', workDir);

let succeeded = false;
try {
  // --- 1. refresh dist + confirm engine, then pack ---------------------------
  console.log('\n[1] Refresh dist (tsc) and pack the library:');
  run('build:ts', NPM, ['run', 'build:ts'], { cwd: PKG_DIR });
  if (!existsSync(ENGINE_ASSET)) {
    throw new Error(
      `STEP FAILED (engine-asset): ${ENGINE_ASSET} is missing. The engine is a ` +
        'build artifact (dist/ is gitignored). Run `npm run build` in ' +
        'packages/epubcheck-standalone to generate it before packing.',
    );
  }
  const packJson = run('npm pack', NPM, [
    'pack',
    '--json',
    '--pack-destination',
    workDir,
  ], { cwd: PKG_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
  const packInfo = JSON.parse(packJson)[0] as {
    filename: string;
    entryCount: number;
    files: { path: string; size: number }[];
  };
  const tarball = join(workDir, packInfo.filename);
  if (!existsSync(tarball)) {
    throw new Error(`STEP FAILED (npm pack): tarball ${tarball} was not written`);
  }
  console.log(`  packed ${packInfo.filename} (${packInfo.entryCount} entries)`);

  // --- 2. inspect the tarball listing ----------------------------------------
  console.log('\n[2] Tarball listing checks:');
  const shipped = new Set(packInfo.files.map((f) => f.path));
  // These are the entry points and assets the exports map + drivers depend on.
  const required = [
    'package.json',
    'README.md',
    'LICENSE',
    'dist/index.js',
    'dist/index.d.ts',
    'dist/validate-browser.js',
    'dist/validate-browser.d.ts',
    'dist/plugins.js',
    'dist/plugins.d.ts',
    'dist/parse.js',
    'dist/parse.d.ts',
    // result-types.js is the internal home of the validate() result types. It is
    // NOT a public subpath (absent from the exports map), but it must ship under
    // dist/ so the relative `./result-types.js` re-export in index.d.ts and the
    // inline type references in parse.d.ts resolve for an outside consumer.
    'dist/result-types.js',
    'dist/result-types.d.ts',
    'dist/formatters/index.js',
    'dist/formatters/index.d.ts',
    'dist/epubcheck-engine.js',
  ];
  for (const rel of required) {
    check(`ships ${rel}`, shipped.has(rel), 'MISSING from tarball');
  }
  // The engine asset must be the real ~21 MB file, not an empty placeholder.
  const engineEntry = packInfo.files.find((f) => f.path === 'dist/epubcheck-engine.js');
  check(
    'engine asset is a full build (> 10 MB)',
    !!engineEntry && engineEntry.size > 10 * 1024 * 1024,
    engineEntry ? `${(engineEntry.size / 1048576).toFixed(1)} MB` : 'absent',
  );
  // Junk / accidental inclusions that must never ship.
  const junkPatterns = [/(^|\/)\.DS_Store$/, /(^|\/)node_modules\//, /\.log$/, /(^|\/)teavm\//, /(^|\/)test\//, /(^|\/)scripts\//];
  const junk = [...shipped].filter((p) => junkPatterns.some((re) => re.test(p)));
  check('no junk files shipped', junk.length === 0, junk.join(', '));
  // Anything shipped that is not obviously an entry point, its declaration, an
  // engine/formatters file, or a root doc/manifest is reported as suspicious.
  const knownRoots = new Set(['package.json', 'README.md', 'LICENSE', 'THIRD-PARTY-NOTICES.txt']);
  const suspicious = [...shipped].filter(
    (p) => !knownRoots.has(p) && !p.startsWith('dist/'),
  );
  if (suspicious.length) {
    console.log('  note - unexpected top-level entries:', suspicious.join(', '));
  }
  // Report the full listing so the caller can eyeball it.
  console.log('  --- full listing ---');
  for (const f of packInfo.files) {
    console.log(`    ${String(f.size).padStart(9)}  ${f.path}`);
  }

  // --- 3. fresh consumer project + install -----------------------------------
  console.log('\n[3] Install the tarball into a fresh consumer project:');
  writeFileSync(
    join(consumerDir, 'package.json'),
    JSON.stringify(
      {
        name: 'pack-consumer-smoketest',
        version: '0.0.0',
        private: true,
        type: 'module',
        dependencies: {
          'epubcheck-standalone': `file:${tarball}`,
          typescript: '5.9.3',
        },
      },
      null,
      2,
    ) + '\n',
  );
  // A local .npmrc so the consumer install never inherits repo-level supply-chain
  // gates (min-release-age / ignore-scripts) that would confuse a plain install.
  writeFileSync(join(consumerDir, '.npmrc'), 'fund=false\naudit=false\n');
  run('npm install', NPM, ['install', '--no-package-lock'], { cwd: consumerDir });
  const installed = join(consumerDir, 'node_modules', 'epubcheck-standalone');
  check('package installed', existsSync(join(installed, 'dist', 'index.js')), installed);
  check(
    'engine asset installed from tarball',
    existsSync(join(installed, 'dist', 'epubcheck-engine.js')),
    'engine missing after install',
  );

  // --- 4. runtime import from the INSTALLED package --------------------------
  console.log('\n[4] Validate a known-good book through the installed package:');
  cpSync(FIXTURE, join(consumerDir, 'test.epub'));
  // ESM TypeScript, run by Node's native type stripping. Imports resolve through
  // the installed package's exports map -- NOT the repo source. Asserts the exact
  // verdict test/smoke.ts asserts for this fixture, plus the self-reference
  // import (EPUBCHECK_VERSION) that only exists once the package is installed.
  writeFileSync(
    join(consumerDir, 'consumer-run.ts'),
    [
      // The main entry ships validate + EPUBCHECK_VERSION + result types; the
      // plugins ship ONLY from the /plugins subpath (one import path per symbol).
      `import { validate, EPUBCHECK_VERSION } from 'epubcheck-standalone';`,
      `import { fs } from 'epubcheck-standalone/plugins';`,
      `import type { EpubCheckResult } from 'epubcheck-standalone';`,
      ``,
      `const result: EpubCheckResult = await validate(await fs('./test.epub'));`,
      `const out = {`,
      `  version: EPUBCHECK_VERSION,`,
      `  valid: result.valid,`,
      `  exitCode: result.exitCode,`,
      `  errors: result.summary?.errors ?? null,`,
      `  hardMessages: result.messages.filter((m) => m.severity === 'ERROR' || m.severity === 'FATAL').length,`,
      `};`,
      `process.stdout.write('CONSUMER_RESULT ' + JSON.stringify(out) + '\\n');`,
    ].join('\n'),
  );
  const runOut = run('consumer-run', process.execPath, ['consumer-run.ts'], {
    cwd: consumerDir,
  });
  const line = runOut.split('\n').find((l) => l.startsWith('CONSUMER_RESULT '));
  if (!line) {
    throw new Error(`STEP FAILED (consumer-run): no CONSUMER_RESULT line in output:\n${runOut}`);
  }
  const r = JSON.parse(line.slice('CONSUMER_RESULT '.length)) as {
    version: string;
    valid: boolean;
    exitCode: number | null;
    errors: number | null;
    hardMessages: number;
  };
  check('self-reference import resolved (EPUBCHECK_VERSION)', r.version === '5.3.0', r.version);
  check('test.epub is valid', r.valid === true);
  check('exit code is 0', r.exitCode === 0, `got ${r.exitCode}`);
  check('zero errors', r.errors === 0, `got ${r.errors}`);
  check('no ERROR/FATAL messages', r.hardMessages === 0, `got ${r.hardMessages}`);

  // --- 5. typecheck each subpath against the shipped declarations ------------
  console.log('\n[5] Typecheck consumer .ts files against the shipped .d.ts:');
  const tscEntry = join(consumerDir, 'node_modules', 'typescript', 'bin', 'tsc');
  // Run tsc over the given files with the given compilerOptions overrides.
  // Returns whether it type-checked clean plus tsc's diagnostics.
  function runTsc(
    label: string,
    files: string[],
    overrides: Record<string, unknown>,
  ): { ok: boolean; diag: string } {
    // The label doubles as a human-readable assertion name, so it can contain
    // spaces and slashes; sanitize it into a safe tsconfig filename token.
    const safe = label.replace(/[^A-Za-z0-9._-]+/g, '-');
    const tsconfigPath = join(consumerDir, `tsconfig.${safe}.json`);
    writeFileSync(
      tsconfigPath,
      JSON.stringify(
        {
          compilerOptions: {
            target: 'ES2022',
            lib: ['ES2022', 'DOM'],
            strict: true,
            noEmit: true,
            skipLibCheck: true,
            types: [],
            ...overrides,
          },
          files,
        },
        null,
        2,
      ) + '\n',
    );
    // tsc is a Node CLI; run it through this same Node so it never depends on a
    // shebang resolving the right runtime. Capture its output (tsc prints
    // diagnostics to stdout).
    try {
      execFileSync(process.execPath, [tscEntry, '-p', tsconfigPath], {
        cwd: consumerDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { ok: true, diag: '' };
    } catch (error) {
      const e = error as { stdout?: string; stderr?: string; message?: string };
      return { ok: false, diag: ((e.stdout || '') + (e.stderr || '') || e.message || String(error)).trim() };
    }
  }
  // A consumer that imports a symbol from its ONE canonical subpath must
  // typecheck; a consumer that imports it from the WRONG subpath must NOT.
  function expectPass(label: string, files: string[], overrides: Record<string, unknown>): void {
    const { ok, diag } = runTsc(label, files, overrides);
    check(`typecheck passes: ${label}`, ok, ok ? '' : '\n' + diag);
  }
  function expectFail(label: string, files: string[], overrides: Record<string, unknown>): void {
    const { ok } = runTsc(label, files, overrides);
    check(`typecheck FAILS as required: ${label}`, !ok, 'the wrong-subpath import unexpectedly type-checked');
  }

  const nodenext = { module: 'nodenext', moduleResolution: 'nodenext' };
  const bundler = { module: 'esnext', moduleResolution: 'bundler' };
  // customConditions requires nodenext/bundler; used to force the browser branch.
  const browserCond = { ...bundler, customConditions: ['browser'] };

  // 5a. The main entry: validate + run option/result types + EPUBCHECK_VERSION,
  //     with a plugin imported from /plugins (its one home). Both the two
  //     module-resolution modes a consumer might pick.
  writeFileSync(
    join(consumerDir, 'consumer-types.ts'),
    [
      `import { validate, EPUBCHECK_VERSION } from 'epubcheck-standalone';`,
      `import type { EpubCheckResult, ValidateOptions } from 'epubcheck-standalone';`,
      `import type { ReportMessage } from 'epubcheck-standalone/formatters';`,
      `import { fs, memory } from 'epubcheck-standalone/plugins';`,
      ``,
      `// Exercise the exported surface a consumer actually touches, so a broken`,
      `// or missing declaration fails the typecheck rather than passing silently.`,
      `const version: string = EPUBCHECK_VERSION;`,
      `const opts: ValidateOptions = { name: 'book.epub' };`,
      `export async function checkOne(bytes: Uint8Array): Promise<number> {`,
      `  const result: EpubCheckResult = await validate(memory(bytes), opts);`,
      `  const first: ReportMessage | undefined = result.messages[0];`,
      `  void first;`,
      `  void fs;`,
      `  void version;`,
      `  return result.summary?.errors ?? 0;`,
      `}`,
    ].join('\n'),
  );
  expectPass('main-nodenext', ['consumer-types.ts'], nodenext);
  expectPass('main-bundler', ['consumer-types.ts'], bundler);

  // 5b. Every public symbol imported from its ONE canonical subpath: the main
  //     entry, /plugins, /parse, /formatters, /formatters/adapter. If any symbol
  //     is missing from the subpath it is supposed to live on, this fails.
  writeFileSync(
    join(consumerDir, 'consumer-subpaths.ts'),
    [
      `import { validate, EPUBCHECK_VERSION } from 'epubcheck-standalone';`,
      `import type { EpubCheckResult, EpubCheckMessage, EpubCheckSummary, EpubCheckReports, MessageLocation, Severity, ValidateOptions, ValidateSource } from 'epubcheck-standalone';`,
      `import { fs, blob, memory, url, opfs, fsDir, opfsDir, fileList, memoryDir, isDirectorySource, isUrlSource, toBase64 } from 'epubcheck-standalone/plugins';`,
      `import type { RangeSource, DirectorySource, DirectoryEntry, UrlSource, HttpBridge, FsLike, FsPromisesLike, FileHandleLike, FsBackend, FsDirLike, FsDirPromisesLike, FsDirBackend } from 'epubcheck-standalone/plugins';`,
      `import { parseConsoleReport, parseReportMessageLine, parseEpubVersion, parseMessageLine, parseEpubcheckLines } from 'epubcheck-standalone/parse';`,
      `import type { ParsedSeverity, ParsedMessage, ParsedOutput } from 'epubcheck-standalone/parse';`,
      `import { formatJsonReport, formatXmlReport, formatXmpReport } from 'epubcheck-standalone/formatters';`,
      `import type { ReportData, ReportMessage, ReportFeature, ReportSeverity, FormatterOptions } from 'epubcheck-standalone/formatters';`,
      ``,
      `export const _version: string = EPUBCHECK_VERSION;`,
      `void validate; void fs; void blob; void memory; void url; void opfs; void fsDir; void opfsDir;`,
      `void fileList; void memoryDir; void isDirectorySource; void isUrlSource; void toBase64;`,
      `void parseConsoleReport; void parseReportMessageLine; void parseEpubVersion; void parseMessageLine; void parseEpubcheckLines;`,
      `void formatJsonReport; void formatXmlReport; void formatXmpReport;`,
      `export type _Types = [`,
      `  EpubCheckResult, EpubCheckMessage, EpubCheckSummary, EpubCheckReports, MessageLocation, Severity, ValidateOptions, ValidateSource,`,
      `  RangeSource, DirectorySource, DirectoryEntry, UrlSource, HttpBridge, FsLike, FsPromisesLike, FileHandleLike, FsBackend, FsDirLike, FsDirPromisesLike, FsDirBackend,`,
      `  ParsedSeverity, ParsedMessage, ParsedOutput,`,
      `  ReportData, ReportMessage, ReportFeature, ReportSeverity, FormatterOptions,`,
      `];`,
    ].join('\n'),
  );
  expectPass('subpaths-nodenext', ['consumer-subpaths.ts'], nodenext);
  expectPass('subpaths-bundler', ['consumer-subpaths.ts'], bundler);

  // 5c. The invariant's teeth: importing a symbol from a subpath it does NOT
  //     live on must fail to typecheck. Each proves one former double-export is
  //     gone.
  writeFileSync(
    join(consumerDir, 'neg-plugin-on-main.ts'),
    `import { fs } from 'epubcheck-standalone';\nvoid fs;\n`,
  );
  expectFail('plugin factory NOT on main entry', ['neg-plugin-on-main.ts'], nodenext);
  writeFileSync(
    join(consumerDir, 'neg-plugintype-on-main.ts'),
    `import type { RangeSource } from 'epubcheck-standalone';\nexport type X = RangeSource;\n`,
  );
  expectFail('plugin type NOT on main entry', ['neg-plugintype-on-main.ts'], nodenext);
  writeFileSync(
    join(consumerDir, 'neg-result-on-parse.ts'),
    `import type { EpubCheckResult } from 'epubcheck-standalone/parse';\nexport type X = EpubCheckResult;\n`,
  );
  expectFail('result type NOT on /parse', ['neg-result-on-parse.ts'], nodenext);

  // 5d. The browser condition resolves to the browser build (validate-browser):
  //     configureEngine exists ONLY there, so it type-checks under the browser
  //     condition and MUST NOT under the node condition (which resolves index).
  writeFileSync(
    join(consumerDir, 'consumer-browser.ts'),
    [
      `import { validate, configureEngine, EPUBCHECK_VERSION } from 'epubcheck-standalone';`,
      `void validate; void configureEngine;`,
      `export const _bv: string = EPUBCHECK_VERSION;`,
    ].join('\n'),
  );
  expectPass('browser condition resolves validate-browser (configureEngine present)', ['consumer-browser.ts'], browserCond);
  expectFail('node condition has no configureEngine', ['consumer-browser.ts'], nodenext);

  // --- 6. double-export invariant on the shipped .d.ts surface ---------------
  console.log('\n[6] No public symbol is exported from two subpaths:');
  const distDir = join(installed, 'dist');
  const read = (rel: string): string => readFileSync(join(distDir, rel), 'utf8');
  // The `.` subpath ships two builds (node + browser condition); its public
  // surface is the union of both. The rest are single-file subpaths.
  const surfaces: { subpath: string; names: Set<string> }[] = [
    {
      subpath: '.',
      names: new Set([...exportedNames(read('index.d.ts')), ...exportedNames(read('validate-browser.d.ts'))]),
    },
    { subpath: './plugins', names: exportedNames(read('plugins.d.ts')) },
    { subpath: './parse', names: exportedNames(read('parse.d.ts')) },
    { subpath: './formatters', names: exportedNames(read('formatters/index.d.ts')) },
  ];
  for (const s of surfaces) {
    check(`${s.subpath} exports at least one public symbol`, s.names.size > 0, `${s.names.size} found`);
  }
  let duplicates = 0;
  for (let i = 0; i < surfaces.length; i++) {
    for (let j = i + 1; j < surfaces.length; j++) {
      const a = surfaces[i]!;
      const b = surfaces[j]!;
      const shared = [...a.names].filter((n) => b.names.has(n));
      if (shared.length) {
        duplicates += shared.length;
        check(`no symbol shared between ${a.subpath} and ${b.subpath}`, false, shared.join(', '));
      }
    }
  }
  check('every public symbol has exactly one subpath home', duplicates === 0, `${duplicates} double-exported`);

  // --- verdict ---------------------------------------------------------------
  console.log('');
  if (failures) {
    console.error(`PACK CONSUMER TEST FAILED: ${failures} assertion(s) failed`);
    console.error(`work dir kept for debugging: ${workDir}`);
    process.exit(1);
  }
  succeeded = true;
  console.log('PACK CONSUMER TEST PASSED');
} finally {
  if (succeeded) {
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}
