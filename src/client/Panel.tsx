/**
 * The live-analysis overlay panel (client half).
 *
 * Registered into the additive `shell.overlay` list slot: entries render
 * beside the shell frame and are click-through until they opt into pointer
 * events, so the collapsed pill never blocks the app. Collapse state is local
 * React state; the stream snapshot is bound with `useSyncExternalStore`, so
 * only text deltas trigger re-renders. Styles are injected once as a `<style>`
 * element and use the DSH semantic tokens (`--dsw-alias-*`), matching the
 * web-styling contract without depending on the in-repo CSS-modules preset.
 */

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { AnalysisController } from './controller.js'
import type { TerminalStreamKey } from './locales.js'

export interface AnalysisPanelProps {
  /** Locale seat supplied by the slots framework for the registered namespace. */
  t(key: TerminalStreamKey): string
  controller: AnalysisController
}

const STYLE_ID = 'dsh-terminal-stream-llm-styles'

const STYLES = `
.dsh-tsl-panel {
  position: fixed;
  right: 16px;
  bottom: 16px;
  width: 360px;
  max-height: 40vh;
  display: flex;
  flex-direction: column;
  pointer-events: auto;
  border-radius: 10px;
  border: 1px solid var(--dsw-alias-border-l4, var(--dsw-alias-border-default, rgba(127,127,127,.35)));
  background: var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-default, canvas));
  color: var(--dsw-alias-label-primary, canvastext);
  box-shadow: var(--dsw-elevation-panel, 0 8px 24px rgba(0,0,0,.18));
  font-size: var(--dsh-content-font-size, 13px);
  overflow: hidden;
  z-index: 40;
}
.dsh-tsl-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l4, rgba(127,127,127,.25));
  user-select: none;
}
.dsh-tsl-title { font-weight: 600; }
.dsh-tsl-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.dsh-tsl-dot.live { background: var(--dsw-alias-status-success, #22a06b); }
.dsh-tsl-dot.connecting { background: var(--dsw-alias-status-warning, #e2b203); }
.dsh-tsl-dot.disconnected { background: var(--dsw-alias-status-danger, #ca3521); }
.dsh-tsl-metrics {
  margin-left: auto;
  display: flex;
  gap: 10px;
  color: var(--dsw-alias-label-secondary, graytext);
  font-size: 11px;
  white-space: nowrap;
}
.dsh-tsl-button {
  border: none;
  background: transparent;
  color: var(--dsw-alias-label-secondary, graytext);
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 6px;
  font-size: 12px;
}
.dsh-tsl-button:hover { background: var(--dsw-alias-bg-hover, rgba(127,127,127,.15)); }
.dsh-tsl-body {
  overflow-y: auto;
  padding: 10px 12px;
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.5;
  min-height: 0;
}
.dsh-tsl-reason {
  border-top: 1px dashed var(--dsw-alias-border-l4, rgba(127,127,127,.25));
  color: var(--dsw-alias-label-secondary, graytext);
  font-size: 12px;
}
.dsh-tsl-reason summary { cursor: pointer; padding: 6px 12px; }
.dsh-tsl-reason pre {
  margin: 0;
  padding: 0 12px 8px;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: inherit;
}
.dsh-tsl-pill {
  position: fixed;
  right: 16px;
  bottom: 16px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-radius: 999px;
  pointer-events: auto;
  border: 1px solid var(--dsw-alias-border-l4, rgba(127,127,127,.35));
  background: var(--dsw-alias-bg-layer-1, canvas);
  color: var(--dsw-alias-label-primary, canvastext);
  box-shadow: var(--dsw-elevation-panel, 0 8px 24px rgba(0,0,0,.18));
  cursor: pointer;
  font-size: 12px;
  z-index: 40;
}
.dsh-tsl-empty { color: var(--dsw-alias-label-secondary, graytext); font-style: italic; }
`

/** Inject the stylesheet once per document; idempotent across hot reloads. */
function ensureStyles(): () => void {
  if (document.getElementById(STYLE_ID) !== null) return () => {}
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = STYLES
  document.head.appendChild(style)
  return () => {
    style.remove()
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  return `${(bytes / 1024).toFixed(1)} KB`
}

export function AnalysisPanel({ t, controller }: AnalysisPanelProps) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const [collapsed, setCollapsed] = useState(false)
  const [showReasoning, setShowReasoning] = useState(false)
  const bodyRef = useRef<HTMLDivElement | null>(null)

  useEffect(ensureStyles, [])
  useEffect(() => {
    const body = bodyRef.current
    if (body !== null) body.scrollTop = body.scrollHeight
  }, [state.analysis, collapsed])

  const stateLabel = t(`state.${state.pipeline}` as TerminalStreamKey)
  const ttft = state.ttftMs === undefined ? '—' : `${state.ttftMs} ms`

  if (collapsed) {
    return (
      <button type="button" className="dsh-tsl-pill" onClick={() => setCollapsed(false)}>
        <span className={`dsh-tsl-dot ${state.connection}`} aria-hidden="true" />
        {t('panel.title')}
      </button>
    )
  }

  return (
    <section className="dsh-tsl-panel" aria-label={t('panel.title')}>
      <header className="dsh-tsl-head">
        <span className={`dsh-tsl-dot ${state.connection}`} aria-hidden="true" />
        <span className="dsh-tsl-title">{t('panel.title')}</span>
        <span className="dsh-tsl-metrics">
          <span title={t(`status.${state.connection}` as TerminalStreamKey)}>{stateLabel}</span>
          <span title={t('bytes.label')}>{formatBytes(state.receivedBytes)}</span>
          <span title={t('ttft.label')}>{ttft}</span>
        </span>
        <button type="button" className="dsh-tsl-button" onClick={() => controller.clear()}>
          {t('panel.clear')}
        </button>
        <button
          type="button"
          className="dsh-tsl-button"
          aria-label={t('panel.collapse')}
          onClick={() => setCollapsed(true)}
        >
          —
        </button>
      </header>
      <div ref={bodyRef} className="dsh-tsl-body">
        {state.analysis.length === 0 && state.reasoning.length === 0
          ? <span className="dsh-tsl-empty">{t('empty.hint')}</span>
          : state.analysis}
        {state.lastError !== undefined && state.pipeline === 'error'
          ? <div className="dsh-tsl-empty">{state.lastError}</div>
          : null}
      </div>
      {state.reasoning.length > 0 && (
        <details className="dsh-tsl-reason" open={showReasoning} onToggle={(e) => setShowReasoning((e.target as HTMLDetailsElement).open)}>
          <summary>{t('panel.reasoning')}</summary>
          <pre>{state.reasoning}</pre>
        </details>
      )}
    </section>
  )
}
