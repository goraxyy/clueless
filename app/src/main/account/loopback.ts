// Signing in happens in the student's own browser (Google, or the link in their email). The browser
// then comes back to a tiny web server the app runs on this computer only (127.0.0.1), which hands
// the sign-in code to the app. Desktop apps like Slack and VS Code sign in the same way.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

/** Each one is listed as an allowed redirect in supabase/config.toml. */
export const CALLBACK_PORTS = [47819, 47820, 47821]
const PATH = '/auth/callback'

export interface Callback {
  code: string | null
  /** Why there's no code: 'timeout', 'cancelled', or what the sign-in page said. */
  error: string | null
}

export interface Loopback {
  redirectTo: string
  result: Promise<Callback>
  close(): void
}

export async function listenForCallback(timeoutMs: number, ports: number[] = CALLBACK_PORTS): Promise<Loopback> {
  let finish: (cb: Callback) => void = () => {}
  const result = new Promise<Callback>((resolve) => (finish = resolve))

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== PATH) {
      res.writeHead(404).end()
      return
    }
    const code = url.searchParams.get('code')
    const error = code ? null : url.searchParams.get('error_description') || url.searchParams.get('error') || 'No sign-in code came back.'
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', connection: 'close' })
    res.end(page(error))
    done({ code, error })
  })

  const port = await listen(server, ports)
  const timer = setTimeout(() => done({ code: null, error: 'timeout' }), timeoutMs)
  let settled = false
  function done(cb: Callback): void {
    if (settled) return
    settled = true
    clearTimeout(timer)
    server.close()
    server.closeAllConnections()
    finish(cb)
  }

  return { redirectTo: `http://127.0.0.1:${port}${PATH}`, result, close: () => done({ code: null, error: 'cancelled' }) }
}

/** The first free port. */
async function listen(server: Server, ports: number[]): Promise<number> {
  for (const port of ports) {
    const ok = await new Promise<boolean>((resolve) => {
      const onError = (): void => resolve(false)
      server.once('error', onError)
      server.listen(port, '127.0.0.1', () => {
        server.off('error', onError)
        resolve(true)
      })
    })
    if (ok) return (server.address() as AddressInfo).port
  }
  throw new Error(`Ports ${ports.join(', ')} are all in use. Quit whatever is using them and try again.`)
}

const escape = (text: string): string =>
  text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

function page(error: string | null): string {
  const [title, line] = error
    ? ["Couldn't sign in", `${escape(error)} Go back to Clueless and try again.`]
    : ["You're signed in", 'Go back to Clueless. You can close this tab.']
  return `<!doctype html><html><head><meta charset="utf-8"><title>Clueless</title>
<style>body{font:15px/1.5 -apple-system,system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0;color:#27272a;background:#fafaf9}
main{text-align:center;max-width:24rem;padding:1rem}h1{font-size:20px;margin:0 0 .25rem}p{color:#71717a;margin:0}
@media (prefers-color-scheme:dark){body{background:#18181b;color:#f4f4f5}p{color:#a1a1aa}}</style></head>
<body><main><h1>${title}</h1><p>${line}</p></main></body></html>`
}
