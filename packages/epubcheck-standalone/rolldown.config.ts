import { defineConfig } from 'rolldown';
import { dts } from 'rolldown-plugin-dts';

// Every source module is an entry so dist/ keeps the same stable module layout
// as src/. Rolldown rewrites the source's explicit `.ts` specifiers to `.js`;
// the declaration plugin does the equivalent work for the bundled declarations
// and emits maps back to the shipped TypeScript sources.
export default defineConfig({
  input: {
    index: 'src/index.ts',
    'validate-core': 'src/validate-core.ts',
    'validate-browser': 'src/validate-browser.ts',
    'run-core': 'src/run-core.ts',
    'engine-run': 'src/engine-run.ts',
    'engine-node': 'src/engine-node.ts',
    'engine-browser': 'src/engine-browser.ts',
    plugins: 'src/plugins.ts',
    'http-bridge': 'src/http-bridge.ts',
    parse: 'src/parse.ts',
    'result-types': 'src/result-types.ts',
    version: 'src/version.ts',
    'formatters/index': 'src/formatters/index.ts',
    'formatters/console': 'src/formatters/console.ts',
  },
  external: [/^node:/, /^@aws-sdk\//, 'epubcheck-standalone/package.json'],
  plugins: [
    dts({
      tsconfig: 'tsconfig.json',
      sourcemap: true,
    }),
  ],
  output: {
    dir: 'dist',
    format: 'esm',
    entryFileNames: '[name].js',
    chunkFileNames: 'chunks/[name]-[hash].js',
  },
});
