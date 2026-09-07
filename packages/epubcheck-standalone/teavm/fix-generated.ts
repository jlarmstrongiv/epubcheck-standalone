// Post-processor for TeaVM 0.15.0 JS output: works around a compiler emission
// inconsistency where ABSTRACT classes that flow into Class.newInstance sites
// (xml-apis FactoryFinder, Xerces ObjectFactory, ...) are listed in the
// simple-constructors reflection table, but their <init> functions are
// eliminated as dead code -- leaving dangling identifiers that crash module
// evaluation with ReferenceError.
//
// Fix: any identifier referenced inside the table call that has no definition
// in the file is replaced with `null`. At runtime Class.newInstance then
// reports the class non-instantiable -- exactly the behavior an abstract class
// must have.
//
// Handles BOTH output modes:
//  - readable (obfuscated=false): the call is `$rt_simpleConstructors([...]);`
//  - obfuscated=true: names are minified; the consumer is located by its body
//    shape `NAME=data=>{let i=0;while(i<data.length){let cls=data[i++];
//    cls[XX].constructor=data[i++];}}` (property names survive minification),
//    then the call site `NAME([...])` is patched the same way.
//
//   mise exec -- node fix-generated.ts <path-to-epubcheck.js>
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const path = process.argv[2];
if (!path) {
  console.error('usage: node fix-generated.ts <js-file>');
  process.exit(2);
}

let src = readFileSync(path, 'utf8');

// We rewrite the TeaVM UMD output into a real ES module (an exported
// `createEngine()` factory, see wrapAsEsmFactory below), so the generated
// directory is marked "module" -- a source checkout imports the dev engine
// straight from here.
writeFileSync(join(dirname(path), 'package.json'), JSON.stringify({ type: 'module' }) + '\n');

// Locate the table call: readable name first, else the minified consumer by shape.
let callMarker = '$rt_simpleConstructors([';
let start = src.indexOf(callMarker);
if (start === -1) {
  const def = src.match(
    /[,;{}]([A-Za-z_$][\w$]*)=data=>\{let i=0;while\(i<data\.length\)\{let cls=data\[i\+\+\];cls\[[\w$]+\]\.constructor\s*=\s*data\[i\+\+\];\}\}/,
  );
  if (!def) {
    // Silently doing nothing here is a known regression trap: if the emission
    // shape changed and we can no longer find the table, the dead-constructor
    // stubs never get applied and the engine crashes at module evaluation with a
    // ReferenceError. Fail loudly so a toolchain change is caught at build time.
    throw new Error(
      'fix-generated: no simple-constructors consumer found (neither the ' +
        'readable `$rt_simpleConstructors([` marker nor the minified consumer ' +
        'shape). The TeaVM emission likely changed -- update the detection.',
    );
  }
  callMarker = `${def[1]}([`;
  const defEnd = (def.index ?? 0) + def[0].length;
  start = src.indexOf(callMarker, defEnd);
  if (start === -1) {
    // call may precede the definition in source order
    start = src.indexOf(callMarker);
  }
  if (start === -1) {
    throw new Error(
      `fix-generated: consumer ${def[1]} found but no call site -- the TeaVM ` +
        'emission likely changed; update the detection.',
    );
  }
}

const open = start + callMarker.length - 1;
const close = src.indexOf(']);', open);
if (close === -1) {
  throw new Error('unterminated simple-constructors call');
}
const arrayBody = src.slice(open + 1, close);
const ids = [...new Set(arrayBody.split(',').map((s) => s.trim()).filter((s) => /^[A-Za-z_$][\w$]*$/.test(s)))];

// One pass over the file (minus the table body) collecting every identifier
// that is a function declaration or an assignment target.
const outside = src.slice(0, open) + '\0' + src.slice(close);
const definedNames = new Set<string>();
for (const m of outside.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
  definedNames.add(m[1]);
}
for (const m of outside.matchAll(/(^|[^\w$<>!+\-*/&|^%=])([A-Za-z_$][\w$]*)\s*=(?![=>])/gm)) {
  definedNames.add(m[2]);
}

const missing = ids.filter((id) => !definedNames.has(id));
if (missing.length === 0) {
  // Every shipped build so far has had abstract classes whose <init> is
  // eliminated as dead code yet still listed in the table, so finding NONE
  // almost certainly means the detection (the table body scan or the
  // defined-name scan) broke -- not that the build is genuinely clean. Treat it
  // as a regression rather than a silent no-op. If a future engine legitimately
  // has no dead constructor refs, revisit this deliberately.
  throw new Error(
    'fix-generated: the simple-constructors table was found but no undefined ' +
      'constructor references were detected. Every prior build had some; this ' +
      'most likely means the identifier-scan regexes no longer match the ' +
      'emission. Verify before shipping.',
  );
}

let newBody = arrayBody;
for (const id of missing) {
  newBody = newBody.replace(new RegExp(`(^|[,\\s])${escapeRx(id)}(?=[,\\s]|$)`, 'g'), '$1null');
}
src = src.slice(0, open + 1) + newBody + src.slice(close);
console.log(`stubbed ${missing.length} undefined constructor refs:`, missing.slice(0, 10).join(', '), missing.length > 10 ? '...' : '');

// Turn the UMD IIFE into an eval-free build-time factory (see wrapAsEsmFactory),
// then write once.
src = wrapAsEsmFactory(src);
writeFileSync(path, src);
console.log('wrapped the engine UMD body in an exported createEngine() factory (eval-free)');

function escapeRx(s: string): string {
  return s.replace(/[$\\.*+?()[\]{}|^]/g, '\\$&');
}

// TeaVM emits the engine as a single UMD IIFE:
//   "use strict";
//   (function(module){ ...UMD dispatch... }(function(<P>){ <BODY> <P>.main=C; }));
// The whole thing evaluates ONCE at load and hands the module to whichever host
// the UMD dispatch detects. We rewrite it into a factory whose body IS the UMD
// body, so CALLING createEngine() runs <BODY> in a FRESH function scope (fresh
// bindings for every top-level let/const/var/function) and returns the module --
// the same fresh-runtime semantics the driver used to get from `new Function`,
// now with NO eval / string-to-code anywhere in the shipped library.
//
// The exact UMD preamble and the `}));` tail are asserted; a TeaVM change that
// moves either seam fails LOUDLY here instead of silently shipping a broken (or
// eval-reintroducing) engine.
function wrapAsEsmFactory(input: string): string {
  const preamble =
    /^"use strict";\n\(function\(module\)\{if\(typeof define==='function'&&define\.amd\)\{define\(\['exports'\],function\(exports\)\{module\(exports\);\}\);\}else if\(typeof exports==='object'&&exports!==null&&typeof exports\.nodeName!=='string'\)\{module\(exports\);\}else\{module\(typeof self!=='undefined'\?self:this\);\}\}\(function\(([A-Za-z_$][\w$]*)\)\{/;
  const m = input.match(preamble);
  if (!m) {
    throw new Error(
      'fix-generated: the TeaVM UMD preamble did not match, so the createEngine() ' +
        'wrapper cannot be applied. The emission likely changed -- update the ' +
        'preamble detection (and verify no `new Function`/eval sneaks back in).',
    );
  }
  const param = m[1] as string;
  const bodyStart = m[0].length; // first char after `function(<param>){`

  const tail = input.trimEnd();
  const closer = '}));';
  if (!tail.endsWith(closer)) {
    throw new Error(
      'fix-generated: the TeaVM UMD tail `}));` was not found at end of file, so ' +
        'the createEngine() wrapper cannot be applied. The emission likely changed ' +
        '-- update the tail detection.',
    );
  }
  const bodyEnd = tail.length - closer.length; // index of the inner `}` in `}));`
  const body = input.slice(bodyStart, bodyEnd);

  // ES modules are strict by default, so dropping the leading "use strict" keeps
  // the body's strict-mode semantics. `let <param> = {}` mirrors the UMD's
  // reassignable exports parameter; the trailing `<param>.main = C;` from the
  // body assigns onto it, and we hand it back.
  return (
    '// Generated by teavm/fix-generated.ts -- do not edit.\n' +
    '// The TeaVM engine UMD body, wrapped as a build-time factory: calling\n' +
    '// createEngine() executes the body in a fresh closure scope and returns the\n' +
    '// single-shot engine module. There is no eval and no new Function here; each\n' +
    '// call is just a fresh invocation of this function.\n' +
    'export function createEngine() {\n' +
    `let ${param} = {};\n` +
    body +
    `\nreturn ${param};\n` +
    '}\n'
  );
}
