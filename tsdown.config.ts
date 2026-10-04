import { defineConfig } from 'tsdown'

/**
 * Host bundle — plain Node ESM, loaded by the DSH Host Loader as `lib/index.js`.
 * This plugin has no client half; there is nothing to serve to the browser.
 */
const host = defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  dts: true,
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  external: ['openai', '@deepseek-ai/cordis', '@deepseek-ai/schemastery'],
})

/**
 * Testing subpath — built separately (single entry per build) so no shared
 * chunks appear in `lib/` and the published file list stays deterministic.
 */
const testing = defineConfig({
  entry: ['src/testing.ts'],
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  dts: true,
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  external: ['@deepseek-ai/cordis'],
})

export default [host, testing]
