/**
 * Stream-state controller for the analysis panel (client half).
 *
 * Consumes the host's SSE bridge (`/plugins/dsh-terminal-stream/events`) via
 * `EventSource` and exposes an immutable snapshot through the observable
 * `{ subscribe, getSnapshot }` face, so React can bind it with
 * `useSyncExternalStore` (keyed re-render: the snapshot reference only changes
 * when state actually changes).
 */

import type { AnalysisDeltaPayload, ReasoningDeltaPayload, StatusPayload } from '../types.js'

export interface AnalysisState {
  connection: 'connecting' | 'live' | 'disconnected'
  pipeline: 'idle' | 'capturing' | 'streaming' | 'error'
  analysis: string
  reasoning: string
  receivedBytes: number
  ttftMs: number | undefined
  model: string
  lastError: string | undefined
}

/** Retained analysis/reasoning text cap, in characters (keeps memory bounded). */
const TEXT_CAP = 100_000

const INITIAL_STATE: AnalysisState = {
  connection: 'connecting',
  pipeline: 'idle',
  analysis: '',
  reasoning: '',
  receivedBytes: 0,
  ttftMs: undefined,
  model: '',
  lastError: undefined,
}

function capTail(text: string): string {
  return text.length > TEXT_CAP ? text.slice(text.length - TEXT_CAP) : text
}

export interface AnalysisController {
  subscribe(listener: () => void): () => void
  getSnapshot(): AnalysisState
  /** Open the SSE source; the returned disposer closes it. */
  connect(url: string): () => void
  /** Clear accumulated analysis text (panel "clear" action). */
  clear(): void
  /** Close the SSE source; the controller becomes inert. */
  dispose(): void
}

export function createAnalysisController(): AnalysisController {
  let state: AnalysisState = INITIAL_STATE
  const listeners = new Set<() => void>()
  let source: EventSource | undefined
  let disposed = false

  function patch(next: Partial<AnalysisState>): void {
    const current = state as unknown as Record<string, unknown>
    let changed = false
    for (const [key, value] of Object.entries(next)) {
      if (current[key] !== value) {
        changed = true
        break
      }
    }
    if (!changed) return
    state = { ...state, ...next }
    for (const listener of listeners) listener()
  }

  function handleStatus(payload: StatusPayload): void {
    patch({
      pipeline: payload.state,
      receivedBytes: payload.receivedBytes,
      ttftMs: payload.ttftMs,
      model: payload.model,
      lastError: payload.lastError,
    })
  }

  function connect(url: string): () => void {
    if (disposed) return () => {}
    source = new EventSource(url)
    source.onopen = () => {
      patch({ connection: 'live' })
    }
    source.onerror = () => {
      // EventSource reconnects automatically; surface the interruption.
      patch({ connection: 'disconnected' })
    }
    source.addEventListener('terminal-stream/hello', () => {
      patch({ connection: 'live' })
    })
    source.addEventListener('terminal-stream/status', (event) => {
      try {
        handleStatus(JSON.parse((event as MessageEvent<string>).data) as StatusPayload)
      } catch {
        // Malformed frame: ignore, the next frame resynchronizes.
      }
    })
    source.addEventListener('terminal-stream/analysis-delta', (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent<string>).data) as AnalysisDeltaPayload
        patch({ analysis: capTail(state.analysis + payload.delta) })
      } catch {
        // Malformed frame: ignore.
      }
    })
    source.addEventListener('terminal-stream/reasoning-delta', (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent<string>).data) as ReasoningDeltaPayload
        patch({ reasoning: capTail(state.reasoning + payload.delta) })
      } catch {
        // Malformed frame: ignore.
      }
    })
    return () => {
      source?.close()
      source = undefined
    }
  }

  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getSnapshot() {
      return state
    },
    connect,
    clear() {
      patch({ analysis: '', reasoning: '' })
    },
    dispose() {
      disposed = true
      source?.close()
      source = undefined
    },
  }
}
