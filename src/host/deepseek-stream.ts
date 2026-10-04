/**
 * DeepSeek streaming analysis for dsh-terminal-stream-llm (host side).
 *
 * Consumes the capture pipeline's async generator and, for every aggregated
 * chunk, opens one streaming Responses-API call against the DeepSeek API
 * (OpenAI-compatible). Model deltas are published twice:
 *  - `ctx.emit` on the typed cordis event bus (host-side consumers), and
 *  - through the injected `publish` bridge so the SSE route can forward them
 *    to the browser half.
 *
 * Robustness rules:
 *  - every in-flight call owns an AbortController, aborted on plugin unload;
 *  - 429 / 5xx responses retry with exponential backoff (max `maxRetries`);
 *  - `completed` / `failed` / transport errors always terminate the streaming
 *    loop cleanly and are logged, never thrown across the pipeline — one
 *    failed analysis must not stop the plugin.
 */

import OpenAI from 'openai'
import type { Context } from '@deepseek-ai/cordis'
import type { AnalysisDeltaPayload, CaptureChunk, ReasoningDeltaPayload, StatusPayload } from '../types.js'
import type { TerminalCapture } from './terminal-capture.js'

/** Transport-level retry backoff base, in milliseconds. */
const RETRY_BACKOFF_BASE_MS = 500
/** Transport-level retry backoff cap, in milliseconds. */
const RETRY_BACKOFF_CAP_MS = 8_000

/** Events the streaming stage publishes downstream (bus + log). */
export interface StreamListener {
  analysis(payload: AnalysisDeltaPayload): void
  reasoning(payload: ReasoningDeltaPayload): void
  status(payload: StatusPayload): void
}

export interface StreamOptions {
  ctx: Context
  capture: TerminalCapture
  signal: AbortSignal
  apiKey: string
  baseURL: string
  model: string
  instructions: string
  maxRetries: number
  /** Receive every published event. */
  listener: StreamListener
}

export interface DeepSeekStreamHandle {
  stop(): void
}

export function startDeepSeekStream(options: StreamOptions): DeepSeekStreamHandle {
  const { ctx, capture, signal, apiKey, baseURL, model, instructions, maxRetries, listener } = options

  // maxRetries: 0 — retry policy is owned by this module, not the SDK.
  const client = new OpenAI({ apiKey, baseURL, maxRetries: 0 })

  const runId = `dsl-${Date.now().toString(36)}`
  let analysisSeq = 0
  let reasoningSeq = 0
  let receivedBytes = 0
  let ttftMs: number | undefined
  let lastError: string | undefined
  let state: 'idle' | 'capturing' | 'streaming' | 'error' = 'idle'
  const inflight = new Set<AbortController>()

  function publishStatus(): void {
    const payload = { state, receivedBytes, ttftMs, model, lastError }
    ctx.emit('terminal-stream/status', payload)
    listener.status(payload)
  }

  function publishAnalysis(delta: string): void {
    analysisSeq += 1
    const payload = { runId, seq: analysisSeq, delta }
    ctx.emit('terminal-stream/analysis-delta', payload)
    listener.analysis(payload)
  }

  function publishReasoning(delta: string): void {
    reasoningSeq += 1
    const payload = { runId, seq: reasoningSeq, delta }
    ctx.emit('terminal-stream/reasoning-delta', payload)
    listener.reasoning(payload)
  }

  /** Derive a per-call AbortController from the plugin lifecycle signal. */
  function childSignal(): AbortSignal {
    const child = new AbortController()
    inflight.add(child)
    const forward = (): void => {
      child.abort(signal.reason)
    }
    if (signal.aborted) forward()
    else signal.addEventListener('abort', forward, { once: true })
    child.signal.addEventListener('abort', () => {
      inflight.delete(child)
      signal.removeEventListener('abort', forward)
    }, { once: true })
    return child.signal
  }

  function isRetryable(error: unknown): boolean {
    if (error instanceof OpenAI.APIError) {
      const status = typeof error.status === 'number' ? error.status : 0
      return status === 429 || status >= 500
    }
    return false
  }

  function backoffMs(attempt: number): number {
    return Math.min(RETRY_BACKOFF_BASE_MS * 2 ** attempt, RETRY_BACKOFF_CAP_MS)
  }

  function errorMessage(error: unknown): string {
    if (error instanceof OpenAI.APIError) return `API ${error.status ?? 'error'}: ${error.message}`
    return error instanceof Error ? error.message : String(error)
  }

  function chunkInput(chunk: CaptureChunk): string {
    const header = chunk.command === undefined
      ? `[terminal ${chunk.tool}]`
      : `[terminal ${chunk.tool}] $ ${chunk.command}`
    return `${header}\n${chunk.text}`
  }

  function interruptibleDelay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms)
      signal.addEventListener('abort', () => {
        clearTimeout(timer)
        resolve()
      }, { once: true })
    })
  }

  /** Run one streaming analysis call for one captured chunk, with retries. */
  async function analyzeChunk(chunk: CaptureChunk): Promise<void> {
    state = 'streaming'
    publishStatus()
    const callStart = Date.now()
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      if (signal.aborted) return
      const callSignal = childSignal()
      let sawFirstDelta = false
      try {
        const stream = await client.responses.create({
          model,
          instructions,
          input: chunkInput(chunk),
          stream: true,
        }, { signal: callSignal })

        for await (const event of stream) {
          if (event.type === 'response.output_text.delta') {
            if (!sawFirstDelta) {
              sawFirstDelta = true
              ttftMs = Date.now() - callStart
            }
            receivedBytes += event.delta.length
            publishAnalysis(event.delta)
          } else if (event.type === 'response.reasoning_text.delta'
            || event.type === 'response.reasoning_summary_text.delta') {
            if (!sawFirstDelta) {
              sawFirstDelta = true
              ttftMs = Date.now() - callStart
            }
            publishReasoning(event.delta)
          } else if (event.type === 'response.completed') {
            state = 'idle'
            publishStatus()
            return
          } else if (event.type === 'response.failed' || event.type === 'error') {
            const detail = 'response' in event
              ? JSON.stringify((event as { response?: unknown }).response)
              : 'unknown stream error'
            throw new Error(`deepseek stream failed: ${detail}`)
          }
        }
        // Stream ended without an explicit completed event — treat as done.
        state = 'idle'
        publishStatus()
        return
      } catch (error) {
        if (signal.aborted) return
        if (isRetryable(error) && attempt < maxRetries) {
          const wait = backoffMs(attempt)
          ctx.logger?.warn?.(`terminal-stream-llm: retryable API error (${errorMessage(error)}), retry ${attempt + 1}/${maxRetries} in ${wait}ms`)
          await interruptibleDelay(wait)
          continue
        }
        lastError = errorMessage(error)
        state = 'error'
        publishStatus()
        ctx.logger?.error?.(`terminal-stream-llm: analysis call failed: ${lastError}`)
        return
      }
    }
  }

  const consumer = (async (): Promise<void> => {
    try {
      for await (const chunk of capture.consume()) {
        if (signal.aborted) return
        await analyzeChunk(chunk)
      }
    } catch (error) {
      if (!signal.aborted) {
        lastError = error instanceof Error ? error.message : String(error)
        state = 'error'
        publishStatus()
        ctx.logger?.error?.('terminal-stream-llm: capture consumer crashed:', error)
      }
    }
  })()

  return {
    stop() {
      for (const child of inflight) child.abort(new Error('plugin unloaded'))
      inflight.clear()
      void consumer
    },
  }
}
