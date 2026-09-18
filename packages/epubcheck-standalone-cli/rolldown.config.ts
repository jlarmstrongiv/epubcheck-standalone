import { defineConfig } from 'rolldown';
import { dts } from 'rolldown-plugin-dts';

export default defineConfig({
  input: {
    archive: 'src/archive.ts',
    cli: 'src/cli.ts',
    'help-text': 'src/help-text.ts',
    'list-checks-data': 'src/list-checks-data.ts',
    'list-checks-locale-data': 'src/list-checks-locale-data.ts',
    'locale-messages': 'src/locale-messages.ts',
    messages: 'src/messages.ts',
  },
  external: [/^node:/, /^epubcheck-standalone(?:\/|$)/],
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
