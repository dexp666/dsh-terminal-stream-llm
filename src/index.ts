/**
 * dsh-terminal-stream-llm — plugin entry (host half, no UI).
 *
 * Pipeline: tools/result capture → line/200ms aggregation → bounded queue
 * (backpressure, no data loss) → DeepSeek streaming Responses API →
 * `ctx.emit` + host log.
 *
 * There is deliberately no client half: analysis deltas are published on the
 * typed cordis event bus (other host-side plugins may subscribe) and echoed to
 * the host log (`logAnalysis` config, default on). All side effects are
 * registered through `ctx.effect()`, so the Fiber unrolls them (listener
 * removal, in-flight request aborts, queue shutdown) automatically on plugin
 * unload or hot reload. Only the plugin identity (`name`), the
 * hard-dependency list (`inject`) and the settings schema (`Config`) are
 * exported besides `apply` — that is the full DSH plugin surface.
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { startDeepSeekStream } from './host/deepseek-stream.js'
import { BoundedQueue, commandOf, contentText, startTerminalCapture } from './host/terminal-capture.js'
import type { CaptureChunk } from './types.js'

export const name = 'terminal-stream-llm'

/** Hard service dependencies; cordis holds activation until all are ready. */
export const inject = ['tools'] as const

/** User-facing configuration, persisted through the settings subsystem. */
export interface Config {
  /** DeepSeek API key (stored via the settings subsystem, never hardcoded). */
  apiKey: string
  /** DeepSeek API base URL. */
  baseURL: string
  /** Model id for the streaming analysis calls. */
  model: string
  /** System instructions for the analysis persona. */
  instructions: string
  /** Tool names captured; empty array captures every tool's text output. */
  watchTools: string[]
  /** Aggregation window in milliseconds; complete lines flush immediately. */
  flushWindowMs: number
  /** Bounded queue capacity; the producer blocks (50 ms retries) when full. */
  maxQueueSize: number
  /** Per-command cap on ingested output text, in bytes. */
  maxOutputBytes: number
  /** Exponential-backoff retries for 429/5xx streaming failures. */
  maxRetries: number
  /** Echo analysis deltas and status changes to the host log. */
  logAnalysis: boolean
}

export const Config: z<Config> = z.object({
  apiKey: z.string().role('secret').required(),
  baseURL: z.string().default('https://api.deepseek.com'),
  model: z.string().default('deepseek-flash'),
  instructions: z.string()
    .default('你是一个实时终端日志分析助手。持续分析以下终端输出，识别错误、异常模式和关键事件，用简洁中文给出增量结论。'),
  watchTools: z.array(z.string()).default(['terminal_send', 'terminal_read', 'bash', 'shell']),
  flushWindowMs: z.number().default(200).min(50),
  maxQueueSize: z.number().default(10).min(1),
  maxOutputBytes: z.number().default(16_384).min(1024),
  maxRetries: z.number().default(3).min(0).max(10),
  logAnalysis: z.boolean().default(true),
})

const DEFAULT_ABORT_REASON = new Error('dsh-terminal-stream-llm unloaded')

export function apply(ctx: Context, config: Config): void {
  const queue = new BoundedQueue<CaptureChunk>(config.maxQueueSize)
  const controller = new AbortController()

  // The capture object is plain state (no side effects yet); the effects below
  // own its listener subscription and its teardown.
  const capture = startTerminalCapture(ctx, {
    watchTools: config.watchTools,
    flushWindowMs: config.flushWindowMs,
    maxOutputBytes: config.maxOutputBytes,
    signal: controller.signal,
  }, queue)

  // Capture: subscribe to completed command-running tool results and feed the
  // aggregation queue. The `ctx.on` listener is removed by the Fiber on unload.
  ctx.effect(() => {
    const offResult = ctx.on('tools/result', (exec, result) => {
      try {
        if (!capture.shouldCapture(exec.name)) return
        const text = contentText(result.content, config.maxOutputBytes)
        if (text.length === 0) return
        capture.ingest(exec.name, commandOf(exec.arguments), text)
      } catch (error) {
        // Observer errors must never break the tool pipeline.
        ctx.logger?.warn?.('terminal-stream-llm: capture observer failed:', error)
      }
    })
    return () => {
      offResult()
      capture.stop()
    }
  }, 'terminal-stream-llm: terminal capture')

  // Streaming: consume the capture generator, stream analysis deltas onto the
  // event bus and (optionally) into the host log. Aborting the lifecycle
  // controller ends every in-flight API request on unload.
  ctx.effect(() => {
    const streaming = startDeepSeekStream({
      ctx,
      capture,
      signal: controller.signal,
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      model: config.model,
      instructions: config.instructions,
      maxRetries: config.maxRetries,
      listener: {
        analysis: (payload) => {
          ctx.emit('terminal-stream/analysis-delta', payload)
          if (config.logAnalysis) ctx.logger?.info?.(`[分析] ${payload.delta}`)
        },
        reasoning: (payload) => {
          ctx.emit('terminal-stream/reasoning-delta', payload)
          if (config.logAnalysis) ctx.logger?.info?.(`[思考] ${payload.delta}`)
        },
        status: (payload) => {
          ctx.emit('terminal-stream/status', payload)
          if (config.logAnalysis && payload.state === 'error') {
            ctx.logger?.warn?.(`[状态] 分析出错: ${payload.lastError}`)
          }
        },
      },
    })
    return () => {
      controller.abort(DEFAULT_ABORT_REASON)
      streaming.stop()
    }
  }, 'terminal-stream-llm: deepseek streaming')
}
