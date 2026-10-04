/**
 * Ambient type surface for the DSH services this plugin consumes.
 *
 * The @deepseek-ai/dsh-* RC packages are not installable from npm (their
 * internal dependency graph is unpublished), so the minimal service faces the
 * plugin touches — verified against the DeepSeek Harness sources — are
 * declared here structurally. Everything is deliberately narrower than the
 * real APIs; if richer types become installable, this file can shrink.
 */

import type { Events } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /**
     * Runtime mixed-ins of the context proxy. The shipped declarations live in
     * the package's internal relative augmentations
     * (`declare module './context.ts'`), which do not merge for external
     * consumers of the published .d.ts, so the plugin redeclares the members
     * it uses with their canonical signatures.
     */
    effect(execute: () => (() => unknown) | void | Promise<unknown>, label?: string): {
      dispose(): unknown
    }
    on<K extends keyof Events>(
      name: K,
      listener: (...args: Parameters<Events[K]>) => unknown,
      options?: unknown,
    ): () => void
    emit<K extends keyof Events>(name: K, ...args: Parameters<Events[K]>): void
  }

  interface Events {
    /**
     * A tool call settled; the result snapshot is deep-frozen.
     * Structural subset of @deepseek-ai/dsh-tools' declaration.
     * @param exec - execution identity (tool name, parsed arguments, …).
     * @param result - frozen result with its rendered content blocks.
     * @mode emit
     */
    'tools/result'(
      exec: { readonly name: string; readonly arguments: unknown },
      result: { readonly content: unknown },
    ): undefined
  }
}
