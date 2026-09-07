# epubcheck-standalone

[![epubcheck-standalone version](https://img.shields.io/npm/v/epubcheck-standalone?label=epubcheck-standalone)](https://www.npmjs.com/package/epubcheck-standalone) [![epubcheck-standalone downloads](https://img.shields.io/npm/dm/epubcheck-standalone)](https://www.npmjs.com/package/epubcheck-standalone) [![epubcheck-standalone-cli version](https://img.shields.io/npm/v/epubcheck-standalone-cli?label=epubcheck-standalone-cli)](https://www.npmjs.com/package/epubcheck-standalone-cli) [![epubcheck-standalone-cli downloads](https://img.shields.io/npm/dm/epubcheck-standalone-cli)](https://www.npmjs.com/package/epubcheck-standalone-cli)

EPUBCheck, the official [W3C EPUB validator](https://www.w3.org/publishing/epubcheck/), compiled to plain JavaScript with TeaVM. It validates a book on your own machine in Node.js or the browser, byte for byte the same as the Java tool. No server, no upload, no Java to install.

- EPUBCheck on the web
- Supports large files >16 GB
- Identical output to the Java version
- Your ebook never leaves your device
- Node.js and browser support
- Full API parity
- JavaScript compiled by TeaVM
- Automatically up-to-date
- Permissive BSD-3-Clause license

## Packages

Three packages share one pinned toolchain and one test suite.

| Package | What it is |
| --- | --- |
| [`epubcheck-standalone`](packages/epubcheck-standalone/README.md) | The library. The TeaVM engine plus one `validate` API for Node.js and the browser. |
| [`epubcheck-standalone-cli`](packages/epubcheck-standalone-cli/README.md) | The command-line tool, run with `npx`. Same flags, output, and exit codes as the official CLI, no Java needed. |
| [`epubcheck-standalone-web`](packages/epubcheck-standalone-web/README.md) | The web demo. A static site that validates an `.epub` entirely in your browser. |

## Quickstart

### Library

```sh
npm install epubcheck-standalone
```

```ts
import { validate } from "epubcheck-standalone";
import { fs } from "epubcheck-standalone/plugins";

const result = await validate(await fs("book.epub"));
console.log(result.valid, result.summary);
```

See the [library README](packages/epubcheck-standalone/README.md) for the browser Worker setup, the read plugins, custom messages, and report files.

### CLI

```sh
npx epubcheck-standalone-cli book.epub
```

See the [CLI README](packages/epubcheck-standalone-cli/README.md) for the flags.

### Demo

Use it at [jlarmstrongiv.github.io/epubcheck-standalone](https://jlarmstrongiv.github.io/epubcheck-standalone/), or run it locally:

```sh
mise install        # provision the pinned Node.js
npm install         # install the workspace
npm run web:dev    # start the dev server
```

See the [demo README](packages/epubcheck-standalone-web/README.md) for details.

## Identical output

The test suite runs this build and the official EPUBCheck side by side over 446 EPUBs: EPUBCheck's own test fixtures, published Standard Ebooks, and generated stress books. Every message, severity, and exit code matches, 446 of 446, with no crashes. It also checks 105 report files byte for byte against what `epubcheck.jar` writes, across 35 books in the JSON, XML, and XMP formats.

```sh
npm test
```

## How it compares

- Official EPUBCheck (Java): the same engine, but it needs a Java install and some technical skill. This project is that engine as plain JavaScript, run with only Node.js or a browser.
- TypeScript ports such as `@likecoin/epubcheck-ts` and `@korzun/epubcheck-ts` re-implement the checks by hand, so their output tracks EPUBCheck without matching it. This project runs the official EPUBCheck code, so output is byte identical. See the [library README](packages/epubcheck-standalone/README.md#how-it-compares) for the details.
- Online validator websites upload your book to a server and cap file size and usage. This project runs on your machine, so your book never leaves your device.

## Build from source

You do not need to build anything to use the packages above. To rebuild the engine yourself, [mise](https://mise.jdx.dev/) provisions every tool the build needs, nothing installed globally.

```sh
mise install         # provision the pinned toolchain
npm install          # install the workspace
npm run build:deps   # fetch the build inputs (the EPUBCheck release, JZlib)
npm run build        # compile the engine with TeaVM
```

## License

BSD-3-Clause, the same license as EPUBCheck. EPUBCheck is a project of the [W3C](https://www.w3.org/publishing/epubcheck/) and [DAISY Consortium](https://daisy.org/); its source is at [w3c/epubcheck](https://github.com/w3c/epubcheck).
