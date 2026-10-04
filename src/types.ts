/**
 * Shared wire types for dsh-terminal-stream-llm.
 *
 * The host side emits these payloads on the cordis event bus (typed via the
 * `Events` declaration merge below) and, when `logAnalysis` is enabled,
 * echoes them to the host log.
 */

/** One terminal-output chunk accepted by the capture pipeline. */
export interface CaptureChunk {
  /** Monotonic per-plugin-activation sequence number. */
  readonly seq: number
  /** Name of the tool whose result produced this chunk. */
  readonly tool: string
  /** Best-effort command line extracted from the tool arguments, when known. */
  readonly command: string | undefined
  /** Aggregated output text (line- or window-aligned). */
  readonly text: string
  /** UTF-8 byte length of `text`. */
  readonly bytes: number
}

/** One incremental analysis text delta produced by the model. */
export interface AnalysisDeltaPayload {
  readonly runId: string
  readonly seq: number
  readonly delta: string
}

/** One incremental reasoning delta produced by the model. */
export interface ReasoningDeltaPayload {
  readonly runId: string
  readonly seq: number
  readonly delta: string
}

/** Lifecycle/status snapshot published whenever the pipeline state changes. */
export interface StatusPayload {
  readonly state: 'idle' | 'capturing' | 'streaming' | 'error'
  /** Model output bytes received since activation. */
  readonly receivedBytes: number
  /** Time to first token of the most recent streaming call, in milliseconds. */
  readonly ttftMs: number | undefined
  readonly model: string
  readonly lastError: string | undefined
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * A terminal-output chunk entered the bounded capture queue.
     * @param payload - capture chunk accepted by the pipeline.
     * @mode emit
     */
    'terminal-stream/chunk-captured'(payload: CaptureChunk): void
    /**
     * One incremental analysis text delta arrived from the DeepSeek stream.
     * @param payload - delta carrier.
     * @mode emit
     */
    'terminal-stream/analysis-delta'(payload: AnalysisDeltaPayload): void
    /**
     * One incremental reasoning delta arrived from the DeepSeek stream.
     * @param payload - delta carrier.
     * @mode emit
     */
    'terminal-stream/reasoning-delta'(payload: ReasoningDeltaPayload): void
    /**
     * Pipeline status changed (idle/capturing/streaming/error, TTFT, bytes).
     * @param payload - status snapshot.
     * @mode emit
     */
    'terminal-stream/status'(payload: StatusPayload): void
  }
}
