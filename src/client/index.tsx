/**
 * dsh-terminal-stream-llm — client entry (browser half).
 *
 * Discovered through package.json `dsh.client` (`platform: 'web'`) and the
 * `exports["./client"]` bundle. Registers:
 *  - locale dictionaries for the panel namespace;
 *  - the SSE subscription to the host bridge (auto-reconnecting EventSource);
 *  - the floating collapsible analysis panel in the additive `shell.overlay`
 *    list slot, so the entry is added beside the shell frame instead of
 *    shadowing it.
 *
 * Everything is registered through `ctx.effect()`, so unloading the client
 * plugin removes the slot entry, closes the EventSource and drops the
 * controller — no leaked listeners, timers or DOM.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { createAnalysisController } from './controller.js'
import { en, NS, zh } from './locales.js'
import type { AnalysisPanelProps } from './Panel.js'
import { AnalysisPanel } from './Panel.js'

export const inject = ['slots', 'locale'] as const

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'terminal-stream-llm: dictionaries')

  const controller = createAnalysisController()
  ctx.effect(() => {
    const close = controller.connect('/plugins/dsh-terminal-stream/events')
    return () => {
      close()
      controller.dispose()
    }
  }, 'terminal-stream-llm: SSE source')

  // The slots framework supplies the locale seat (`t`) at render time; the
  // controller comes from this closure. Components never receive ctx.
  function BoundPanel(props: Pick<AnalysisPanelProps, 't'>) {
    return <AnalysisPanel t={props.t} controller={controller} />
  }

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'terminal-stream-analysis',
    locale: NS,
  }, BoundPanel))
}
