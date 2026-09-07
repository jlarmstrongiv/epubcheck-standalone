#!/usr/bin/env node
// Generate stress EPUBs entirely from Node (no external libraries):
//   1. image-heavy-100  : 100 large random-pixel PNGs (~tens of MB) to probe
//                         memory scaling + the base64 hand-off + Inflater/zip.
//   2. image-heavy-300  : 300 smaller PNGs (many-entry zip, more manifest items).
//   3. deep-nesting     : one XHTML doc with deeply nested <div> elements to
//                         probe XML/parse stack depth (a past weak spot).
// Each is written mimetype-first / STORED via the system `zip`, like real epubs.
//
// Usage: node generate-books.ts
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { randomFillSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(REPO, 'test/corpus/generated');
const WORK = join(REPO, 'test/corpus/_genwork');

// ---- minimal PNG encoder (RGB, 8-bit, filter 0) --------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}
function makePng(w: number, h: number): Buffer {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  // raw scanlines: filter byte 0 + w*3 random bytes per row (random => barely compresses => large file)
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    const off = y * (1 + w * 3);
    raw[off] = 0;
    randomFillSync(raw, off + 1, w * 3);
  }
  const idat = deflateSync(raw, { level: 6 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ---- epub scaffolding ----------------------------------------------------
const CONTAINER = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

function packEpub(root: string, outName: string): string {
  const out = join(OUT, outName + '.epub');
  if (existsSync(out)) rmSync(out);
  execFileSync('/usr/bin/zip', ['-X', '-0', '-q', out, 'mimetype'], { cwd: root });
  execFileSync('/usr/bin/zip', ['-X', '-r', '-1', '-q', out, '.', '-x', 'mimetype'], { cwd: root });
  return out;
}

function scaffold(root: string): void {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, 'META-INF'), { recursive: true });
  mkdirSync(join(root, 'OEBPS/img'), { recursive: true });
  writeFileSync(join(root, 'mimetype'), 'application/epub+zip');
  writeFileSync(join(root, 'META-INF/container.xml'), CONTAINER);
}

function buildImageBook(name: string, nImages: number, w: number, h: number): string {
  const root = join(WORK, name);
  scaffold(root);
  const manifestItems = [];
  const spineItems = [];
  const navLis = [];
  for (let i = 0; i < nImages; i++) {
    const id = String(i).padStart(4, '0');
    const png = makePng(w, h);
    writeFileSync(join(root, `OEBPS/img/p${id}.png`), png);
    const xhtml = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en" xml:lang="en">
<head><meta charset="utf-8"/><title>Page ${id}</title></head>
<body><section epub:type="chapter"><h1>Page ${id}</h1>
<p><img src="img/p${id}.png" alt="Random test image number ${id}"/></p></section></body></html>`;
    writeFileSync(join(root, `OEBPS/page${id}.xhtml`), xhtml);
    manifestItems.push(`<item id="png${id}" href="img/p${id}.png" media-type="image/png"/>`);
    manifestItems.push(`<item id="pg${id}" href="page${id}.xhtml" media-type="application/xhtml+xml"/>`);
    spineItems.push(`<itemref idref="pg${id}"/>`);
    navLis.push(`<li><a href="page${id}.xhtml">Page ${id}</a></li>`);
  }
  const nav = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en" xml:lang="en">
<head><meta charset="utf-8"/><title>Contents</title></head>
<body><nav epub:type="toc" id="toc"><h1>Contents</h1><ol>${navLis.join('')}</ol></nav></body></html>`;
  writeFileSync(join(root, 'OEBPS/nav.xhtml'), nav);
  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">urn:uuid:00000000-0000-0000-0000-${name.replace(/[^0-9]/g,'').padStart(12,'0').slice(0,12)}</dc:identifier>
    <dc:title>${name}</dc:title>
    <dc:language>en</dc:language>
    <meta property="dcterms:modified">2026-09-03T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    ${manifestItems.join('\n    ')}
  </manifest>
  <spine>
    <itemref idref="nav" linear="no"/>
    ${spineItems.join('\n    ')}
  </spine>
</package>`;
  writeFileSync(join(root, 'OEBPS/content.opf'), opf);
  const out = packEpub(root, name);
  return out;
}

function buildDeepNestBook(name: string, depth: number): string {
  const root = join(WORK, name);
  scaffold(root);
  let open = '', close = '';
  for (let i = 0; i < depth; i++) { open += `<div class="d">`; close = `</div>` + close; }
  const deep = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en" xml:lang="en">
<head><meta charset="utf-8"/><title>Deep</title></head>
<body><section epub:type="chapter"><h1>Deep nesting ${depth}</h1>${open}<p>bottom</p>${close}</section></body></html>`;
  writeFileSync(join(root, 'OEBPS/deep.xhtml'), deep);
  const nav = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en" xml:lang="en">
<head><meta charset="utf-8"/><title>Contents</title></head>
<body><nav epub:type="toc" id="toc"><h1>Contents</h1><ol><li><a href="deep.xhtml">Deep</a></li></ol></nav></body></html>`;
  writeFileSync(join(root, 'OEBPS/nav.xhtml'), nav);
  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">urn:uuid:11111111-1111-1111-1111-111111111111</dc:identifier>
    <dc:title>${name}</dc:title>
    <dc:language>en</dc:language>
    <meta property="dcterms:modified">2026-09-03T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="deep" href="deep.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="deep"/></spine>
</package>`;
  writeFileSync(join(root, 'OEBPS/content.opf'), opf);
  return packEpub(root, name);
}

mkdirSync(OUT, { recursive: true });
mkdirSync(WORK, { recursive: true });
const made = [];
made.push(buildImageBook('image-heavy-100', 100, 640, 480));
made.push(buildImageBook('image-heavy-300', 300, 220, 220));
made.push(buildDeepNestBook('deep-nesting-3000', 3000));
rmSync(WORK, { recursive: true, force: true });
const { statSync } = await import('node:fs');
for (const p of made) console.log(`${(statSync(p).size/1048576).toFixed(1)} MB  ${p}`);
