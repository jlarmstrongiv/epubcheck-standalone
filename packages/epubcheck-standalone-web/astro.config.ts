import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import { paraglideVitePlugin } from "@inlang/paraglide-js";

// Static site (no server component). Pages is served from this repo, so
// `base` is the repo name: https://jlarmstrongiv.github.io/epubcheck-standalone/.
// The engine JS URL comes from a Vite `?url` asset import of the
// epubcheck-standalone workspace package (see src/worker/vendor.ts) -- the engine
// is the TeaVM JS-backend build, not wasm -- so Vite rewrites it for the base
// path automatically; the fixture URLs are still built from
// import.meta.env.BASE_URL.
export default defineConfig({
  site: "https://jlarmstrongiv.github.io",
  base: "/epubcheck-standalone",
  output: "static",
  // The dev toolbar overlay adds nothing for this single-island demo and just
  // floats over the UI while developing; turn it off.
  devToolbar: { enabled: false },
  integrations: [react()],
  vite: {
    plugins: [
      // Paraglide JS compiles the message catalog (messages/<locale>.json) into
      // tree-shakable ESM under src/paraglide during dev and build. English is
      // the only catalog today and the baseLocale.
      //
      // Strategy ["localStorage", "baseLocale"]: on the server (this static SSG
      // build) localStorage is skipped, so every page renders in the baseLocale
      // (English) and the static HTML is deterministic. In the browser the header
      // language switcher calls Paraglide's setLocale, which writes the choice to
      // localStorage and then reloads the page (setLocale's documented default);
      // getLocale() then reads that stored choice, so the pick persists across
      // visits. localStorage comes first so a stored choice wins over the
      // baseLocale fallback. This is Paraglide's recommended runtime-switch setup
      // for a client-rendered surface with no locale routing (see
      // https://paraglidejs.com/strategy). To add a UI locale later, just add its
      // messages/<locale>.json; the switcher and engine-locale map pick it up on
      // their own (see src/components/demo/locales.ts).
      paraglideVitePlugin({
        project: "./project.inlang",
        outdir: "./src/paraglide",
        strategy: ["localStorage", "baseLocale"],
        emitTsDeclarations: true,
      }),
    ],
    worker: {
      // The worker is a MODULE worker (spawned with { type: "module" }); the
      // engine is the TeaVM JS-backend build, consumed as real ESM. Emit the
      // bundled worker chunk as ES too.
      format: "es",
    },
  },
});
