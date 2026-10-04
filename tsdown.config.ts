import { defineConfig } from 'tsdown'

/**
 * Host bundle — plain Node ESM, loaded by the DSH Host Loader as `lib/index.js`.
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

/**
 * Client bundle — must match the DSH client module format produced by the
 * in-repo `clientBundle` preset (packages/client/tsdown.client.ts): the file
 * registers a `{ id, factory }` with `window.__ModuleLoader__`, the factory
 * receives the loader's injected `require`, and exports leave via
 * `module.exports`. Externals (react, react/jsx-runtime) are resolved from the
 * shell's platform module table at runtime.
 */
const client = defineConfig({
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: true,
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  banner: 'window.__ModuleLoader__.load({ id: "dsh-terminal-stream-llm", factory: (require) => {',
  intro: 'var module = { exports: {} }; var exports = module.exports;',
  footer: 'return module.exports; } });',
  external: ['react', 'react/jsx-runtime', '@deepseek-ai/cordis'],
})

export default [host, testing, client]
