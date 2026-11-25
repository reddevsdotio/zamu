import { defineConfig } from 'tsdown';

// The published CLI bundles the workspace packages it uses (they ship as TypeScript source) and imports
// its npm dependencies at runtime.
//
// ZAMU_CLI_VERSION sets the version `zamu --version` prints. scripts/npm-package.ts sets it from the release
// tag; a build without it says 0.0.0-dev.
const version = process.env.ZAMU_CLI_VERSION || '0.0.0-dev';

export default defineConfig({
  entry: ['src/index.ts'],
  format: 'esm',
  platform: 'node',
  target: 'node24',
  outDir: 'dist',
  clean: true,
  dts: false,
  // package.json has "type": "module", so emit dist/index.js (the bin path) instead of .mjs.
  fixedExtension: false,
  define: {
    __ZAMU_CLI_VERSION__: JSON.stringify(version),
  },
  deps: {
    alwaysBundle: [/^@zamu\//],
  },
});
