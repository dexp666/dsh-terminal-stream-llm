/**
 * SSE bridge for dsh-terminal-stream-llm (host side).
 *
 * The application's forwarded-host-event allowlist
 * (packages/api/remotes/src/remote-events.ts) is closed to external plugins,
 * so the browser half subscribes to this plugin's own HTTP route instead. The
 * route is registered on the shared web server (`ctx.webServer`); handlers own
 * the full response lifecycle and may hold it open, which is exactly the SSE
 * pattern the webserver package documents. gzip compression skips
 * `text/event-stream` responses automatically.
 *
 * Electron deployments that do not run the web server get a no-op bridge; the
 * client panel then simply reports "disconnected" without erroring.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { SSE_PATH } from '../types.js'

/** Heartbeat comment period, keeps proxies from idling the connection out. */
const HEARTBEAT_MS = 15_000

export interface SseBridge {
  /** Fan an event out to every connected browser subscriber. */
  publish(event: string, payload: unknown): void
}

class SubscriberSet {
  private readonly subscribers = new Set<(frame: string) => void>()

  add(write: (frame: string) => void): void {
    this.subscribers.add(write)
  }

  remove(write: (frame: string) => void): void {
    this.subscribers.delete(write)
  }

  isEmpty(): boolean {
    return this.subscribers.size === 0
  }

  frame(event: string, payload: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`
  }

  send(event: string, payload: unknown): void {
    const frame = this.frame(event, payload)
    for (const write of this.subscribers) write(frame)
  }
}

/**
 * Mount the SSE route. Returns the publisher; when no web server service is
 * present the publisher discards events and the panel shows "disconnected".
 */
export function mountSseBridge(ctx: Context): SseBridge {
  // Optional service: property access through the context proxy throws for
  // unprovided names, so the non-strict `ctx.get` is the correct probe.
  const webServer = ctx.get('webServer') as import('../dsh.js').DshWebServer | undefined
  if (webServer === undefined) {
    ctx.logger?.warn?.('terminal-stream-llm: no webServer service; the client analysis panel will be disconnected')
    return { publish: () => {} }
  }

  const subscribers = new SubscriberSet()

  ctx.effect(() => {
    const dispose = webServer.register({
      kind: 'exact',
      path: SSE_PATH,
      handler: (req: IncomingMessage, res: ServerResponse) => {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        })
        const write = (frame: string): void => {
          res.write(frame)
        }
        subscribers.add(write)
        // Greet the fresh subscriber so the panel can flip to "live" at once.
        write(subscribers.frame('terminal-stream/hello', { path: SSE_PATH }))
        const heartbeat = setInterval(() => {
          res.write(': heartbeat\n\n')
        }, HEARTBEAT_MS)
        const cleanup = (): void => {
          clearInterval(heartbeat)
          subscribers.remove(write)
        }
        req.on('close', cleanup)
        res.on('close', cleanup)
      },
    })
    return () => {
      subscribers.send('terminal-stream/bye', {})
      void Promise.resolve(dispose()).catch((error: unknown) => {
        ctx.logger?.warn?.('terminal-stream-llm: SSE route disposal failed:', error)
      })
    }
  }, 'terminal-stream-llm: /plugins/dsh-terminal-stream/events SSE route')

  return {
    publish(event, payload) {
      if (!subscribers.isEmpty()) subscribers.send(event, payload)
    },
  }
}
