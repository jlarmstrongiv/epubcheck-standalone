#!/usr/bin/env node
// Generate LARGE, structurally-VALID EPUBs full of big JPEGs, to stress the
// SIZE dimension of the wasm epubcheck build (2 GB / 3.5 GB / 4+ GB books).
//
// Usage:
//   node testing/scripts/generate-big-books.ts <name> <targetBytes> [--broken] [--img=BYTES]
// Examples:
//   node testing/scripts/generate-big-books.ts valid-2gb   2000000000
//   node testing/scripts/generate-big-books.ts broken-2gb  2000000000 --broken
//   node testing/scripts/generate-big-books.ts valid-3_5gb 3500000000
//   node testing/scripts/generate-big-books.ts valid-4_4gb 4400000000
//   node testing/scripts/generate-big-books.ts browser-500mb 500000000
//
// The image trick (why this is cheap AND valid):
// - epubcheck's image check reads image HEADERS only. For JPEG it walks markers
//   to find an SOFn segment and reads width/height from it; it learns the byte
//   length by DRAINING the stream. It never decodes pixel data.
// - So each "image" here is a minimal but genuinely-valid JPEG: SOI (FF D8) +
//   a baseline SOF0 marker (real 3-component width/height) + random filler +
//   EOI (FF D9). The magic bytes say JPEG, the extension says .jpg, the media
//   type says image/jpeg -> all three agree, so the image checks PASS.
// - Filler is random bytes (do not compress), so entries are STORED (zip -0):
//   generation stays fast and file-size == content-size, which is what puts the
//   full book weight into the in-memory VFS at validation time.
//
// One random filler buffer is generated once and REUSED for every image (the
// books are byte-identical images; epubcheck validates each independently).
//
// --broken injects a few REAL errors (for the "does it stay accurate at scale"
// test): (1) a manifest item whose file is missing -> RSC-007; (2) a JPEG whose
// file is named .png and declared image/png -> mislabeled extension (PKG-022).

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync, statSync, openSync, writeSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { randomFillSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(REPO, 'test/corpus/generated-big');
const WORK = join(REPO, 'test/corpus/_genwork-big');

const name = process.argv[2];
const targetBytes = Number(process.argv[3]);
const broken = process.argv.includes('--broken');
const imgArg = process.argv.find(a => a.startsWith('--img='));
const IMG_BYTES = imgArg ? Number(imgArg.slice(6)) : 64 * 1024 * 1024; // 64 MiB default

if (!name || !Number.isFinite(targetBytes)) {
  console.error('usage: node generate-big-books.ts <name> <targetBytes> [--broken] [--img=BYTES]');
  process.exit(64);
}

// ---- VALID JPEG = complete real JPEG + trailing random filler --------------
// A header-only JPEG is enough for the wasm pure-Java header reader, but the
// NATIVE binary uses real libjpeg (via ImageIO) which rejects a JPEG with no
// valid entropy data as "PKG-021 Corrupted image file" -- a parity divergence.
// So each image is a COMPLETE, genuinely-decodable 16x16 JPEG (made once with
// macOS `sips`, embedded below as base64) followed by random filler AFTER the
// EOI marker. Every JPEG decoder stops at EOI and ignores trailing bytes, so
// BOTH readers get the same dimensions with no error, while the file is as big
// as we like. The full file is still drained for byte-length (OPF-057), which
// is what loads the VFS to full size.
const TEMPLATE_JPEG_B64 =
  '/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAEKADAAQAAAABAAAAEAAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgAEAAQAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAgICAgICAwICAwUDAwMFBgUFBQUGCAYGBgYGCAoICAgICAgKCgoKCgoKCgwMDAwMDA4ODg4ODw8PDw8PDw8PD//bAEMBAgICBAQEBwQEBxALCQsQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEP/dAAQAAf/aAAwDAQACEQMRAD8AKKKKAP/Z';
const TEMPLATE = Buffer.from(TEMPLATE_JPEG_B64, 'base64');

// One reusable random filler buffer, appended after the template's EOI.
const fillerLen = IMG_BYTES - TEMPLATE.length;
if (fillerLen <= 0) { console.error('IMG_BYTES too small'); process.exit(1); }
const filler = Buffer.allocUnsafe(fillerLen);
randomFillSync(filler, 0, Math.min(fillerLen, 1024 * 1024)); // 1 MiB of real randomness is plenty; rest is arbitrary heap bytes (never decoded)

function writeJpeg(path: string): void {
  const fd = openSync(path, 'w');
  writeSync(fd, TEMPLATE);
  writeSync(fd, filler);
  closeSync(fd);
}

// ---- epub scaffolding ------------------------------------------------------
const CONTAINER = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

function scaffold(root: string): void {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, 'META-INF'), { recursive: true });
  mkdirSync(join(root, 'OEBPS/img'), { recursive: true });
  writeFileSync(join(root, 'mimetype'), 'application/epub+zip');
  writeFileSync(join(root, 'META-INF/container.xml'), CONTAINER);
}

function packEpub(root: string, outName: string): string {
  mkdirSync(OUT, { recursive: true });
  const out = join(OUT, outName + '.epub');
  if (existsSync(out)) rmSync(out);
  // mimetype first, STORED; everything else STORED too (random data => no gain).
  execFileSync('/usr/bin/zip', ['-X', '-0', '-q', out, 'mimetype'], { cwd: root });
  execFileSync('/usr/bin/zip', ['-X', '-r', '-0', '-q', out, '.', '-x', 'mimetype'], { cwd: root });
  return out;
}

const nImages = Math.max(1, Math.round(targetBytes / IMG_BYTES));
const root = join(WORK, name);
scaffold(root);

const manifestItems = [];
const spineItems = [];
const navLis = [];

for (let i = 0; i < nImages; i++) {
  const id = String(i).padStart(4, '0');
  writeJpeg(join(root, `OEBPS/img/p${id}.jpg`));
  const xhtml = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en" xml:lang="en">
<head><meta charset="utf-8"/><title>Page ${id}</title></head>
<body><section epub:type="chapter"><h1>Page ${id}</h1>
<p><img src="img/p${id}.jpg" alt="Large test image ${id}"/></p></section></body></html>`;
  writeFileSync(join(root, `OEBPS/page${id}.xhtml`), xhtml);
  manifestItems.push(`<item id="img${id}" href="img/p${id}.jpg" media-type="image/jpeg"/>`);
  manifestItems.push(`<item id="pg${id}" href="page${id}.xhtml" media-type="application/xhtml+xml"/>`);
  spineItems.push(`<itemref idref="pg${id}"/>`);
  navLis.push(`<li><a href="page${id}.xhtml">Page ${id}</a></li>`);
}

if (broken) {
  // ERROR 1: manifest item whose file is MISSING -> RSC-007 (could not be found).
  manifestItems.push(`<item id="ghost" href="img/ghost.jpg" media-type="image/jpeg"/>`);
  // reference it from a page so it is definitely exercised.
  const gx = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en" xml:lang="en">
<head><meta charset="utf-8"/><title>Ghost</title></head>
<body><section epub:type="chapter"><h1>Ghost</h1><p><img src="img/ghost.jpg" alt="missing"/></p></section></body></html>`;
  writeFileSync(join(root, 'OEBPS/ghost.xhtml'), gx);
  manifestItems.push(`<item id="pgghost" href="ghost.xhtml" media-type="application/xhtml+xml"/>`);
  spineItems.push(`<itemref idref="pgghost"/>`);

  // ERROR 2: JPEG content in a file named .png, declared image/png -> PKG-022
  // (wrong file extension / content-type mismatch for image).
  writeJpeg(join(root, 'OEBPS/img/mislabeled.png'));
  manifestItems.push(`<item id="mis" href="img/mislabeled.png" media-type="image/png"/>`);
  const mx = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en" xml:lang="en">
<head><meta charset="utf-8"/><title>Mislabeled</title></head>
<body><section epub:type="chapter"><h1>Mislabeled</h1><p><img src="img/mislabeled.png" alt="jpeg-as-png"/></p></section></body></html>`;
  writeFileSync(join(root, 'OEBPS/mislabeled.xhtml'), mx);
  manifestItems.push(`<item id="pgmis" href="mislabeled.xhtml" media-type="application/xhtml+xml"/>`);
  spineItems.push(`<itemref idref="pgmis"/>`);
}

const nav = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en" xml:lang="en">
<head><meta charset="utf-8"/><title>Contents</title></head>
<body><nav epub:type="toc" id="toc"><h1>Contents</h1><ol>${navLis.join('')}</ol></nav></body></html>`;
writeFileSync(join(root, 'OEBPS/nav.xhtml'), nav);

const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">urn:uuid:00000000-0000-4000-8000-${String(Math.abs(hashCode(name))).padStart(12,'0').slice(0,12)}</dc:identifier>
    <dc:title>${name}</dc:title>
    <dc:language>en</dc:language>
    <meta property="dcterms:modified">2026-09-03T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    ${manifestItems.join('\n    ')}
  </manifest>
  <spine>
    <itemref idref="nav"/>
    ${spineItems.join('\n    ')}
  </spine>
</package>`;
writeFileSync(join(root, 'OEBPS/content.opf'), opf);

function hashCode(s: string): number { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }

const out = packEpub(root, name);
rmSync(root, { recursive: true, force: true });
const sz = statSync(out).size;
console.log(`${(sz / 1e9).toFixed(3)} GB (${sz} bytes)  ${nImages} images  ${out}`);
