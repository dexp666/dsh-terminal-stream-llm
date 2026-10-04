/**
 * Testing subpath — exposes pipeline internals for tests and advanced tooling.
 * Not part of the plugin surface proper (the entry module stays apply-only).
 */

export { BoundedQueue } from './host/terminal-capture.js'
export type { CaptureChunk } from './types.js'
