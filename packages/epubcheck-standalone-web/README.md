# epubcheck-standalone demo

A static website that runs EPUBCheck, the official [W3C EPUB validator](https://www.w3.org/publishing/epubcheck/), entirely in your browser. Drop in an `.epub` and see whether it is valid, with the same messages the official validator gives.

This is the public demo for the [`epubcheck-standalone`](../epubcheck-standalone/README.md) library in the same monorepo.

Try it at [jlarmstrongiv.github.io/epubcheck-standalone](https://jlarmstrongiv.github.io/epubcheck-standalone/).

## What it does

- Drag and drop or pick an `.epub`, and it validates on the spot.
- Validates single files too: an `.xhtml`, `.html`, `.svg`, `.opf`, or `.smil` runs the matching single-file check.
- Validates unzipped books: pick a folder and its files validate as an expanded book.
- Three sample buttons load bundled fixtures, one per outcome: pass, warn, fail.
- Advanced options (closed by default): profile, message language, EPUB version for single-file checks, and a usage-messages toggle.
- A language switcher changes the interface language, remembers the choice, and preselects the matching engine message language.
- Results in an [Ant Design](https://ant.design/) UI: a verdict banner, a stats row, a filterable message table, and download buttons for the JSON, XML, and XMP reports.
- Nothing is uploaded. File and folder validation runs in a Web Worker; URL validation runs on the main thread. No server, no network upload, no telemetry.
- Works with zero browser flags in Chrome, Firefox, and Safari.

## How it works

- The engine is the TeaVM plain-JavaScript build of EPUBCheck, driven entirely by the library.
- File and folder validation runs in a single Web Worker, spawned on first use and reused across runs (kept warm so repeat validations skip the engine cold start), so the page's main thread stays responsive. URL validation runs on the main thread with no worker, since the engine suspends mid-run for the async download.
- The worker wraps a picked file in the `blob` range source (or a folder's files in the `fileList` directory source), points the build at the engine asset with `configureEngine`, then calls `validate` from `epubcheck-standalone`.
- It runs `validate` once in report mode (JSON, XML, XMP). The JSON report drives the results table; all three drive the download buttons.
- Each message reaches the table through `validate`'s `onMessage` callback, which fires live as the engine emits each message.
- Folder input is gathered on the main thread (`webkitGetAsEntry` for drops, `<input webkitdirectory>` for the picker); the worker needs only the `File` objects and their relative paths.
- React talks to the worker through a `comlink`-wrapped, typed `Remote`, so the boundary is type-safe end to end.
- UI copy is externalized with [Paraglide JS](https://inlang.com/m/gerre34r/library-inlang-paraglideJs). `messages/en.json` is the source of truth. Adding a `messages/<locale>.json` makes that locale appear in the switcher with no code change.

## Run it

The toolchain is pinned with [mise](https://mise.jdx.dev/) at the monorepo root. Do not install Node globally; provision it with mise. Install once at the root with npm workspaces.

```sh
# From the monorepo root:
mise install          # provision the pinned Node.js
npm install           # install the whole workspace
npm run web:dev      # dev server
npm run web:build    # static build into packages/epubcheck-standalone-web/dist/
npm run web:preview  # serve the built site locally
```

## License and credits

The validator is [EPUBCheck](https://github.com/w3c/epubcheck), a project of the W3C and DAISY Consortium (BSD-3-Clause), compiled to plain JavaScript with TeaVM. This demo is a thin UI around it.
