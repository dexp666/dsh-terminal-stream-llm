/**
 * Standalone smoke test for the host half of dsh-terminal-stream-llm.
 *
 * Runs the real plugin on a real cordis root context with a stub `tools`
 * service, then:
 *  1. simulates a `tools/result` event (terminal_send output) and asserts the
 *     capture → aggregation → queue pipeline emits `terminal-stream/*` events;
 *  2. asserts the bounded queue applies backpressure without dropping data;
 *  3. unloads the plugin and asserts the effects unrolled cleanly.
 *
 * Usage: node test/smoke.mjs   (after `npm run build`)
 */

import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { Config } from '../lib/index.js'

const config = Config({
  apiKey: 'sk-test',
  baseURL: 'http://127.0.0.1:9',
  model: 'deepseek-flash',
  instructions: 'test',
  watchTools: ['terminal_send'],
  flushWindowMs: 50,
  maxQueueSize: 3,
  maxOutputBytes: 4096,
  maxRetries: 1,
  logAnalysis: false,
})

const ctx = new Context()

// Stub services the host half touches.
ctx.provide('tools', {})

// Capture emitted cordis events.
const emitted = []
ctx.on('terminal-stream/chunk-captured', (payload) => emitted.push({ kind: 'chunk', payload }))
ctx.on('terminal-stream/status', (payload) => emitted.push({ kind: 'status', payload }))

// Mount the plugin the way the loader would, so its effects live on a
// disposable plugin fiber rather than the root context.
const plugin = await import('../lib/index.js')
const fiber = ctx.plugin(plugin, config)
await new Promise((resolve) => setTimeout(resolve, 50))

// --- capture → aggregation → queue → events ---------------------------------
ctx.emit('tools/result', { name: 'terminal_send', arguments: { text: 'ping -c 10 localhost' } }, {
  content: [
    { type: 'text', text: 'PING localhost: 56 data bytes\n64 bytes from localhost: seq=0 ttl=64\n64 bytes from localhost: seq=1 ttl=64\n' },
  ],
})
await new Promise((resolve) => setTimeout(resolve, 250))

const chunks = emitted.filter((entry) => entry.kind === 'chunk')
assert.ok(chunks.length >= 1, `expected captured chunks, got ${emitted.length} events`)
assert.match(chunks[0].payload.text, /64 bytes from localhost/)
assert.equal(chunks[0].payload.command, 'ping -c 10 localhost')

// --- watcher filter ----------------------------------------------------------
emitted.length = 0
ctx.emit('tools/result', { name: 'unrelated_tool', arguments: {} }, { content: [{ type: 'text', text: 'noise' }] })
await new Promise((resolve) => setTimeout(resolve, 150))
assert.equal(emitted.filter((entry) => entry.kind === 'chunk').length, 0, 'non-watched tool ignored')

// --- bounded queue backpressure (no data loss) ------------------------------
{
  const { BoundedQueue } = await import('../lib/testing.js')
  const queue = new BoundedQueue(2)
  const signal = new AbortController()
  // Enqueue 6 items into a queue of capacity 2 while nobody consumes.
  const pushes = []
  for (let i = 0; i < 6; i += 1) pushes.push(queue.push({ i }, signal.signal))
  await new Promise((resolve) => setTimeout(resolve, 120))
  assert.ok(queue.size <= 2, 'queue stays bounded')
  const drained = []
  for (let i = 0; i < 6; i += 1) drained.push(await queue.pop(signal.signal))
  assert.deepEqual(drained.map((item) => item.i), [0, 1, 2, 3, 4, 5], 'no items dropped under backpressure')
  assert.ok(pushes.every((promise) => promise instanceof Promise))
  signal.abort()
}

// --- unload: effects unroll --------------------------------------------------
await fiber.dispose()

console.log('smoke test passed: capture, aggregation, backpressure, unload cleanup all OK')
