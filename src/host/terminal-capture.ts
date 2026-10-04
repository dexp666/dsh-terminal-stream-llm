/**
 * Terminal output capture for dsh-terminal-stream-llm (host side).
 *
 * Capture model: DSH's persistent-PTY service is owner-scoped and pull-mode,
 * and the forwarded-host-event allowlist is application-owned, so the seam an
 * external host plugin can observe command output through is the tool
 * lifecycle — `tools/result` fires with the frozen result (including the
 * rendered viewport/output text) of every command-running tool call
 * (`terminal_send`, `terminal_read`, shell tools, …). Raw result text is
 * ingested here, aggregated by line or by a 200 ms window, and pushed through
 * a bounded queue into the DeepSeek stream consumer.
 *
 * Backpressure: when the bounded queue is full, the aggregation stage awaits
 * `queue.push()` (50 ms retry loop) instead of dropping data; the raw ingest
 * buffer only grows while the consumer is stalled.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CaptureChunk } from '../types.js'

/** Fixed retry delay while the bounded queue is full, in milliseconds. */
const BACKPRESSURE_RETRY_MS = 50
/** Idle polling delay for the consumer generator, in milliseconds. */
const CONSUMER_POLL_MS = 25

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error('sleep aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Bounded FIFO queue with producer-side backpressure.
 *
 * `push()` never drops data: while full it sleeps 50 ms and retries. `pop()`
 * waits on an internal signal so consumers do not busy-poll. Closing the queue
 * lets pending items drain before `pop()` resolves `undefined`.
 */
export class BoundedQueue<T> {
  private readonly items: T[] = []
  private closed = false
  private popWaiter: (() => void) | undefined

  constructor(readonly maxsize: number) {}

  get size(): number {
    return this.items.length
  }

  /** Resolve once at least one item is available or the queue is closed. */
  private waitForItems(): void {
    if (this.items.length > 0 || this.closed) return
    void new Promise<void>((resolve) => {
      this.popWaiter = resolve
    }).then(() => {
      this.popWaiter = undefined
    })
  }

  private notifyPop(): void {
    this.popWaiter?.()
  }

  /** Enqueue one item, blocking (asynchronously) while the queue is full. */
  async push(item: T, signal?: AbortSignal): Promise<void> {
    while (!this.closed && this.items.length >= this.maxsize) {
      await sleep(BACKPRESSURE_RETRY_MS, signal)
    }
    if (this.closed) return
    this.items.push(item)
    this.notifyPop()
  }

  /**
   * Dequeue one item. Resolves `undefined` only after the queue is closed and
   * fully drained.
   */
  async pop(signal?: AbortSignal): Promise<T | undefined> {
    while (this.items.length === 0) {
      if (this.closed) return undefined
      this.waitForItems()
      await sleep(CONSUMER_POLL_MS, signal).catch(() => {})
    }
    return this.items.shift()
  }

  /** Close the queue: further pushes are ignored, consumers drain then end. */
  close(): void {
    this.closed = true
    this.notifyPop()
  }
}

export interface CaptureOptions {
  /** Tool names whose results are captured; an empty array captures every tool. */
  watchTools: readonly string[]
  /** Aggregation window in milliseconds; complete lines flush immediately. */
  flushWindowMs: number
  /** Per-command cap on ingested output, in bytes. */
  maxOutputBytes: number
  /** Abort signal owned by the plugin lifecycle. */
  signal: AbortSignal
}

export interface TerminalCapture {
  /** Whether a tool's result text should be captured. */
  shouldCapture(tool: string): boolean
  /** Ingest one tool result's output text (called from the tools/result listener). */
  ingest(tool: string, command: string | undefined, text: string): void
  /** Async generator yielding aggregated chunks until the capture stops. */
  consume(): AsyncGenerator<CaptureChunk>
  /** Stop aggregation, close the queue and end the generator. */
  stop(): void
}

interface RawIngest {
  readonly tool: string
  readonly command: string | undefined
  readonly text: string
}

/**
 * Create the capture pipeline: ingest → (line | flushWindowMs window)
 * aggregation → bounded queue → async generator.
 */
export function startTerminalCapture(
  ctx: Context,
  options: CaptureOptions,
  queue: BoundedQueue<CaptureChunk>,
): TerminalCapture {
  const { watchTools, flushWindowMs, maxOutputBytes, signal } = options
  let seq = 0
  let stopped = false

  // Raw ingest stage: tool results arrive synchronously; they queue here and
  // the aggregation task below moves them into the bounded queue with
  // backpressure, so a stalled consumer blocks here instead of losing data.
  const pending: RawIngest[] = []

  const watchers = new Set(watchTools)

  function shouldCapture(tool: string): boolean {
    return watchers.size === 0 || watchers.has(tool)
  }

  function ingest(tool: string, command: string | undefined, text: string): void {
    if (stopped || text.length === 0) return
    const clipped = text.length > maxOutputBytes ? `${text.slice(0, maxOutputBytes)}\n…[truncated]` : text
    pending.push({ tool, command, text: clipped })
  }

  // Aggregation task: coalesce pending raw ingests into chunks aligned on line
  // boundaries, flushing at least every `flushWindowMs` while data keeps
  // arriving. Pushes into the bounded queue apply backpressure.
  void (async (): Promise<void> => {
    let buffer: RawIngest | undefined
    let windowStarted: number | undefined
    while (!stopped) {
      const next = pending.shift()
      if (next === undefined) {
        // No new data: flush a partial window if it is due, otherwise idle.
        if (buffer !== undefined && windowStarted !== undefined && Date.now() - windowStarted >= flushWindowMs) {
          await flush(buffer)
          buffer = undefined
          windowStarted = undefined
        }
        await sleep(10, signal).catch(() => {})
        continue
      }
      if (buffer === undefined) {
        buffer = next
        windowStarted = Date.now()
      } else {
        buffer = {
          tool: buffer.tool,
          command: buffer.command ?? next.command,
          text: `${buffer.text}${next.text}`,
        }
      }
      const endsWithNewline = buffer.text.endsWith('\n')
      const windowDue = windowStarted !== undefined && Date.now() - windowStarted >= flushWindowMs
      if (endsWithNewline || windowDue) {
        await flush(buffer)
        buffer = undefined
        windowStarted = undefined
      }
    }
    if (buffer !== undefined) await flush(buffer)
  })().catch((error: unknown) => {
    ctx.logger?.error?.('terminal-stream-llm: aggregation task failed:', error)
  })

  async function flush(part: RawIngest): Promise<void> {
    const text = part.text.endsWith('\n') ? part.text.slice(0, -1) : part.text
    if (text.length === 0) return
    seq += 1
    const chunk: CaptureChunk = {
      seq,
      tool: part.tool,
      command: part.command,
      text,
      bytes: Buffer.byteLength(text, 'utf8'),
    }
    // Backpressure: await while the queue is full; never drop.
    await queue.push({ ...chunk }, signal).catch(() => {})
    ctx.emit('terminal-stream/chunk-captured', chunk)
  }

  async function* consume(): AsyncGenerator<CaptureChunk> {
    while (true) {
      const chunk = await queue.pop(signal)
      if (chunk === undefined) return
      yield chunk
    }
  }

  function stop(): void {
    if (stopped) return
    stopped = true
    pending.length = 0
    queue.close()
  }

  return { shouldCapture, ingest, consume, stop }
}

/** Extract a best-effort command line from tool arguments for context headers. */
export function commandOf(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const record = args as Record<string, unknown>
  for (const key of ['command', 'cmd', 'text', 'input', 'script']) {
    const value = record[key]
    if (typeof value === 'string' && value.trim().length > 0) {
      const line = value.length > 120 ? `${value.slice(0, 120)}…` : value
      return line.replace(/\s+/gu, ' ').trim()
    }
  }
  return undefined
}

/** Extract UTF-8 text from tool result content blocks, clipped to a byte budget. */
export function contentText(content: unknown, maxOutputBytes: number): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  let budget = maxOutputBytes
  for (const block of content) {
    if (budget <= 0) break
    if (typeof block !== 'object' || block === null) continue
    const typed = block as { type?: unknown; text?: unknown }
    if (typed.type !== 'text' || typeof typed.text !== 'string') continue
    const slice = typed.text.length > budget ? typed.text.slice(0, budget) : typed.text
    parts.push(slice)
    budget -= slice.length
  }
  const joined = parts.join('\n')
  return joined.length >= maxOutputBytes ? `${joined}\n…[truncated]` : joined
}
