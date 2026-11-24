// The Clueless server: the app signs in with Supabase, and this function calls Claude, Deepgram and
// ElevenLabs for it with our keys, within the user's monthly limit. Plain (Request, deps) => Response
// with no Deno or Supabase imports, so it's tested with fakes (handler_test.ts).
//
// Routes, under /functions/v1/api:
//   POST /v1/messages              Claude Messages API, passed through (streaming too)
//   GET  /me                       plan, spend this month, limit
//   POST /voice/stt-token          a short-lived Deepgram token for one recording
//   GET  /elevenlabs/v2/voices     ElevenLabs voice list, passed through
//   POST /elevenlabs/v1/text-to-speech/:voiceId   ElevenLabs speech, passed through
//   POST /webhooks/lemonsqueezy    payments: a subscription started, changed or ended (no sign-in;
//                                  checked by its signature instead)

export type Plan = 'free' | 'pro'

export interface UsageRow {
  user_id: string
  kind: 'claude' | 'tts' | 'stt'
  model: string
  input_tokens?: number
  output_tokens?: number
  cache_read_tokens?: number
  cache_write_tokens?: number
  characters?: number
  cost_micro: number
}

export interface Deps {
  anthropicKey: string
  deepgramKey?: string
  elevenLabsKey?: string
  fetch: typeof fetch
  /** The user behind a Supabase access token, or null if it isn't valid. */
  verifyUser(token: string): Promise<{ id: string; email?: string } | null>
  plan(userId: string): Promise<Plan>
  /** Spent this calendar month (UTC), in millionths of a dollar. */
  monthSpend(userId: string): Promise<number>
  recordUsage(row: UsageRow): Promise<void>
  /** A user's plan from their subscription (the payments webhook). */
  setSubscription(userId: string, sub: { plan: Plan; id: string; status: string }): Promise<void>
  /** Lemon Squeezy: the webhook's signing secret, the checkout link for Pro, the customer portal. */
  payments?: { webhookSecret: string; checkoutUrl: string; portalUrl: string; testMode: boolean }
  /** Monthly limit per plan, in millionths of a dollar. */
  limits: Record<Plan, number>
  /** Keep work going after the response is sent (EdgeRuntime.waitUntil). */
  waitUntil?(work: Promise<unknown>): void
  log?(line: string): void
  now?(): Date
}

const ANTHROPIC = 'https://api.anthropic.com'
const DEEPGRAM = 'https://api.deepgram.com'
const ELEVENLABS = 'https://api.elevenlabs.io'

/** Models the app may ask for. Anything else is refused, so the key can't be used for other work. */
export const ALLOWED_MODELS = new Set(['claude-sonnet-5-5', 'claude-haiku-5-5'])
const MAX_TOKENS = 64000
const MAX_BODY_BYTES = 8 * 1024 * 1024 // a conversation with several screenshots is well under this
const MAX_TTS_CHARS = 2500

/** Dollars per million tokens: input, output, cache read, cache write (5-minute). */
const PRICES: Record<string, [number, number, number, number]> = {
  'claude-sonnet-5-5': [2, 10, 0.1, 2.5],
  'claude-haiku-5-5': [0.1, 0.5, 0.01, 0.125],
  // Models a refusal fallback can land on.
  'claude-sonnet-5': [2, 10, 0.2, 2.5],
  'claude-opus-5-5': [4, 20, 0.2, 5],
  'claude-opus-5': [5, 25, 0.5, 6.25],
  'claude-opus-4-8': [5, 25, 0.5, 6.25]
}
const UNKNOWN_PRICE: [number, number, number, number] = [5, 25, 0.5, 6.25] // priced like the dearest
/** ElevenLabs, millionths of a dollar per character (about $0.10 per 1,000). Set to your plan's rate. */
export const TTS_MICRO_PER_CHAR = 100
/** Deepgram streaming, charged per recording up front (about 1 minute of nova-3). */
export const STT_MICRO_PER_RECORDING = 8000

export interface Usage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

/** What a call cost, in millionths of a dollar (a dollar per million tokens = 1 micro per token). */
export function costMicro(model: string, u: Usage): number {
  const [i, o, cr, cw] = PRICES[model] ?? UNKNOWN_PRICE
  return Math.ceil(
    (u.input_tokens ?? 0) * i + (u.output_tokens ?? 0) * o + (u.cache_read_input_tokens ?? 0) * cr + (u.cache_creation_input_tokens ?? 0) * cw
  )
}

export async function handle(req: Request, deps: Deps): Promise<Response> {
  const url = new URL(req.url)
  const path = url.pathname.replace(/^.*?\/api(?=\/|$)/, '') || '/'
  try {
    // Webhooks don't sign in: they're checked by their signature.
    if (req.method === 'POST' && path === '/webhooks/lemonsqueezy') return await lemonSqueezy(req, deps)
    const user = await authenticate(req, deps)
    if (!user) return error(401, 'authentication_error', 'Sign in to Clueless again.')

    if (req.method === 'POST' && path === '/v1/messages') return await messages(req, url, user.id, deps)
    if (req.method === 'GET' && path === '/me') return await me(user, deps)
    if (req.method === 'POST' && path === '/voice/stt-token') return await sttToken(user.id, deps)
    if (path.startsWith('/elevenlabs/')) return await elevenLabs(req, url, path.slice('/elevenlabs'.length), user.id, deps)
    return error(404, 'not_found_error', 'Not found.')
  } catch (err) {
    deps.log?.(`api: ${err instanceof Error ? err.stack || err.message : String(err)}`)
    return error(500, 'api_error', 'Something went wrong on the Clueless server. Try again.')
  }
}

async function authenticate(req: Request, deps: Deps): Promise<{ id: string; email?: string } | null> {
  const m = (req.headers.get('authorization') ?? '').match(/^Bearer\s+(.+)$/i)
  return m ? deps.verifyUser(m[1].trim()) : null
}

/** Over the limit: 402 rather than 429, since the SDK retries a 429 on its own. */
async function overLimit(userId: string, deps: Deps): Promise<Response | null> {
  const [plan, spent] = await Promise.all([deps.plan(userId), deps.monthSpend(userId)])
  if (spent < deps.limits[plan]) return null
  const message =
    plan === 'free'
      ? "You've used this month's free Clueless. Upgrade to Pro to keep going, or wait for next month."
      : "You've used this month's Clueless. It resets on the 1st."
  return error(402, 'billing_error', message)
}

// ---------- Claude ----------

async function messages(req: Request, url: URL, userId: string, deps: Deps): Promise<Response> {
  if (!deps.anthropicKey) return error(503, 'api_error', 'The Clueless server has no Claude key yet.')
  const declared = Number(req.headers.get('content-length') ?? 0)
  if (declared > MAX_BODY_BYTES) return error(413, 'request_too_large', 'That request is too large.')
  const raw = await req.text()
  if (raw.length > MAX_BODY_BYTES) return error(413, 'request_too_large', 'That request is too large.')

  let body: Record<string, unknown>
  try {
    body = JSON.parse(raw)
  } catch {
    return error(400, 'invalid_request_error', 'The request body is not JSON.')
  }
  const model = typeof body.model === 'string' ? body.model : ''
  if (!ALLOWED_MODELS.has(model)) return error(400, 'invalid_request_error', `Model "${model}" is not available on Clueless.`)
  if (typeof body.max_tokens !== 'number' || body.max_tokens > MAX_TOKENS) {
    return error(400, 'invalid_request_error', `max_tokens must be a number up to ${MAX_TOKENS}.`)
  }
  // Server tools (web search, code execution, MCP) bill outside the token count: not allowed.
  // Plain tools the app defines (no `type`) are fine.
  const tools = Array.isArray(body.tools) ? (body.tools as Record<string, unknown>[]) : []
  if (body.mcp_servers || body.container || tools.some((t) => t && typeof t === 'object' && 'type' in t && t.type !== 'custom')) {
    return error(400, 'invalid_request_error', 'Server tools are not available on Clueless.')
  }

  const blocked = await overLimit(userId, deps)
  if (blocked) return blocked

  const headers: Record<string, string> = {
    'x-api-key': deps.anthropicKey,
    'content-type': 'application/json',
    'anthropic-version': req.headers.get('anthropic-version') ?? '2023-06-01'
  }
  const beta = req.headers.get('anthropic-beta')
  if (beta) headers['anthropic-beta'] = beta

  // No req.signal: if the app goes away, a plain request still finishes here and is counted. A
  // stream the app cancels is cancelled upstream below, and counted up to that point.
  const upstream = await deps.fetch(`${ANTHROPIC}/v1/messages${url.search}`, { method: 'POST', headers, body: raw })
  const out = new Headers({ 'content-type': upstream.headers.get('content-type') ?? 'application/json' })
  const requestId = upstream.headers.get('request-id')
  if (requestId) out.set('request-id', requestId)

  // Our key was refused: our problem, not the student's (their own 401 means "sign in again").
  if (upstream.status === 401 || upstream.status === 403) {
    deps.log?.(`api: Claude refused the server key (${upstream.status}): ${await upstream.text().catch(() => '')}`)
    return error(502, 'api_error', "Clueless can't reach Claude right now. Try again later.")
  }
  // Other errors go back exactly as Claude sent them: the app reads their status and message.
  if (!upstream.ok || !upstream.body) return new Response(upstream.body, { status: upstream.status, headers: out })

  const record = (usedModel: string, usage: Usage): Promise<void> =>
    deps
      .recordUsage({
        user_id: userId,
        kind: 'claude',
        model: usedModel,
        input_tokens: usage.input_tokens ?? 0,
        output_tokens: usage.output_tokens ?? 0,
        cache_read_tokens: usage.cache_read_input_tokens ?? 0,
        cache_write_tokens: usage.cache_creation_input_tokens ?? 0,
        cost_micro: costMicro(usedModel, usage)
      })
      .catch((err) => deps.log?.(`api: couldn't record usage: ${err instanceof Error ? err.message : String(err)}`))

  if (body.stream === true) {
    // Pass the events through as they come, and add up the usage they carry on the way. If the app
    // stops reading early, Claude has still billed what it sent: count that too (estimated).
    const meter = new SseUsage(model)
    const decoder = new TextDecoder()
    const reader = upstream.body.getReader()
    let counted = false
    const count = (cancelled: boolean): void => {
      if (counted) return
      counted = true
      const done = record(meter.model, cancelled ? meter.soFar(raw.length) : meter.usage)
      if (deps.waitUntil) deps.waitUntil(done)
    }
    const piped = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { done, value } = await reader.read()
        if (done) {
          count(false)
          controller.close()
          return
        }
        controller.enqueue(value)
        meter.feed(decoder.decode(value, { stream: true }))
      },
      cancel(reason) {
        count(true)
        return reader.cancel(reason)
      }
    })
    return new Response(piped, { status: upstream.status, headers: out })
  }

  const text = await upstream.text()
  try {
    const message = JSON.parse(text) as { model?: string; usage?: Usage }
    const done = record(message.model || model, message.usage ?? {})
    if (deps.waitUntil) deps.waitUntil(done)
    else await done
  } catch {
    deps.log?.('api: Claude replied with something other than JSON')
  }
  return new Response(text, { status: upstream.status, headers: out })
}

/** Reads `usage` out of a Messages API event stream: message_start has the input side, each
 *  message_delta the output so far. */
export class SseUsage {
  usage: Usage = {}
  private buffer = ''
  private started = false
  private deltaChars = 0

  constructor(public model: string) {}

  feed(text: string): void {
    this.buffer += text
    let end: number
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end).trim()
      this.buffer = this.buffer.slice(end + 1)
      if (!line.startsWith('data:')) continue
      try {
        this.event(JSON.parse(line.slice(5)))
      } catch {
        // not JSON (or a ping): skip
      }
    }
  }

  /** Usage for a stream stopped early: output estimated from what was sent (about 3 characters a
   *  token), and input from the request size if Claude hadn't even started. */
  soFar(requestChars: number): Usage {
    const output = Math.max(this.usage.output_tokens ?? 0, Math.ceil(this.deltaChars / 3))
    const input = this.started ? (this.usage.input_tokens ?? 0) : Math.ceil(requestChars / 4)
    return { ...this.usage, input_tokens: input, output_tokens: output }
  }

  private event(e: {
    type?: string
    message?: { model?: string; usage?: Usage }
    usage?: Usage
    delta?: { text?: string; thinking?: string; partial_json?: string }
  }): void {
    if (e.type === 'content_block_delta' && e.delta) {
      this.deltaChars += (e.delta.text ?? e.delta.thinking ?? e.delta.partial_json ?? '').length
    } else if (e.type === 'message_start' && e.message) {
      this.started = true
      if (e.message.model) this.model = e.message.model
      this.usage = { ...this.usage, ...e.message.usage }
    } else if (e.type === 'message_delta' && e.usage) {
      // Counts here are running totals for the message, not increments.
      for (const [k, v] of Object.entries(e.usage)) if (typeof v === 'number') (this.usage as Record<string, number>)[k] = v
    }
  }
}

// ---------- the account ----------

async function me(user: { id: string; email?: string }, deps: Deps): Promise<Response> {
  const [plan, spent] = await Promise.all([deps.plan(user.id), deps.monthSpend(user.id)])
  const now = deps.now?.() ?? new Date()
  const resets = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
  const pay = deps.payments
  const upgradeUrl =
    pay && plan === 'free'
      ? `${pay.checkoutUrl}${pay.checkoutUrl.includes('?') ? '&' : '?'}checkout[custom][user_id]=${encodeURIComponent(user.id)}` +
        (user.email ? `&checkout[email]=${encodeURIComponent(user.email)}` : '')
      : null
  return json(200, {
    email: user.email ?? null,
    plan,
    spentMicro: spent,
    limitMicro: deps.limits[plan],
    resetsAt: resets.toISOString(),
    upgradeUrl,
    manageUrl: pay && plan === 'pro' ? pay.portalUrl : null
  })
}

// ---------- payments ----------

/** Statuses that keep Pro: paying, trying a failed payment again, or cancelled but not yet ended
 *  (Lemon Squeezy sends subscription_expired when a cancelled one runs out). */
const PRO_STATUSES = new Set(['on_trial', 'active', 'past_due', 'cancelled'])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function lemonSqueezy(req: Request, deps: Deps): Promise<Response> {
  const pay = deps.payments
  if (!pay) return error(404, 'not_found_error', 'Not found.')
  const raw = await req.text()
  const expected = await hmacHex(pay.webhookSecret, raw)
  if (!sameText(expected, req.headers.get('x-signature') ?? '')) return error(401, 'authentication_error', 'Bad signature.')

  let event: {
    meta?: { event_name?: string; custom_data?: { user_id?: unknown } }
    data?: { id?: unknown; type?: string; attributes?: { status?: string; test_mode?: boolean } }
  }
  try {
    event = JSON.parse(raw)
  } catch {
    return error(400, 'invalid_request_error', 'Not JSON.')
  }
  const name = event.meta?.event_name ?? ''
  // 200 for anything we don't act on, so Lemon Squeezy doesn't keep retrying it.
  if (!name.startsWith('subscription_') || event.data?.type !== 'subscriptions') return json(200, { ignored: name })
  const attrs = event.data.attributes ?? {}
  if (attrs.test_mode && !pay.testMode) return json(200, { ignored: 'test mode' })
  const userId = event.meta?.custom_data?.user_id
  if (typeof userId !== 'string' || !UUID.test(userId)) {
    deps.log?.(`api: ${name} without a Clueless user_id (subscription ${String(event.data.id)})`)
    return json(200, { ignored: 'no user' })
  }
  const status = attrs.status ?? ''
  const plan: Plan = PRO_STATUSES.has(status) ? 'pro' : 'free'
  await deps.setSubscription(userId, { plan, id: String(event.data.id ?? ''), status })
  deps.log?.(`api: ${name}: ${userId} is ${plan} (${status})`)
  return json(200, { plan })
}

async function hmacHex(secret: string, body: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(body)))
  return [...sig].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Compare without stopping at the first difference (so timing doesn't give the signature away). */
function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

// ---------- voice ----------

async function sttToken(userId: string, deps: Deps): Promise<Response> {
  if (!deps.deepgramKey) return error(503, 'api_error', 'Talking is not set up on this server.')
  const blocked = await overLimit(userId, deps)
  if (blocked) return blocked
  const res = await deps.fetch(`${DEEPGRAM}/v1/auth/grant`, {
    method: 'POST',
    headers: { authorization: `Token ${deps.deepgramKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ttl_seconds: 30 })
  })
  if (!res.ok) {
    deps.log?.(`api: deepgram grant failed (${res.status}): ${await res.text().catch(() => '')}`)
    return error(502, 'api_error', "Couldn't start talking. Try again.")
  }
  const grant = (await res.json()) as { access_token?: string; expires_in?: number }
  if (!grant.access_token) return error(502, 'api_error', "Couldn't start talking. Try again.")
  await deps.recordUsage({ user_id: userId, kind: 'stt', model: 'deepgram', cost_micro: STT_MICRO_PER_RECORDING })
  return json(200, { token: grant.access_token, expiresIn: grant.expires_in ?? 30 })
}

const VOICE_PATHS = [/^\/v2\/voices$/, /^\/v1\/text-to-speech\/[A-Za-z0-9]{1,40}$/]

async function elevenLabs(req: Request, url: URL, path: string, userId: string, deps: Deps): Promise<Response> {
  if (!deps.elevenLabsKey) return error(503, 'api_error', 'Spoken replies are not set up on this server.')
  const speech = path.startsWith('/v1/text-to-speech/')
  if (!VOICE_PATHS.some((p) => p.test(path)) || req.method !== (speech ? 'POST' : 'GET')) {
    return error(404, 'not_found_error', 'Not found.')
  }

  let body: string | undefined
  let characters = 0
  if (speech) {
    const blocked = await overLimit(userId, deps)
    if (blocked) return blocked
    body = await req.text()
    let text: unknown
    try {
      text = (JSON.parse(body) as { text?: unknown }).text
    } catch {
      return error(400, 'invalid_request_error', 'The request body is not JSON.')
    }
    if (typeof text !== 'string' || !text || text.length > MAX_TTS_CHARS) {
      return error(400, 'invalid_request_error', `text must be 1 to ${MAX_TTS_CHARS} characters.`)
    }
    characters = text.length
  }

  const res = await deps.fetch(`${ELEVENLABS}${path}${url.search}`, {
    method: req.method,
    headers: {
      'xi-api-key': deps.elevenLabsKey,
      ...(speech ? { 'content-type': 'application/json', accept: req.headers.get('accept') ?? 'audio/mpeg' } : {})
    },
    body,
    signal: req.signal
  })
  if (speech && res.ok) {
    const done = deps
      .recordUsage({ user_id: userId, kind: 'tts', model: 'elevenlabs', characters, cost_micro: characters * TTS_MICRO_PER_CHAR })
      .catch((err) => deps.log?.(`api: couldn't record usage: ${err instanceof Error ? err.message : String(err)}`))
    if (deps.waitUntil) deps.waitUntil(done)
    else await done
  }
  return new Response(res.body, {
    status: res.status,
    headers: { 'content-type': res.headers.get('content-type') ?? 'application/octet-stream' }
  })
}

// ---------- helpers ----------

function json(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

/** Errors in the Claude API's own shape, so the SDK reads the message the same way. */
function error(status: number, type: string, message: string): Response {
  return json(status, { type: 'error', error: { type, message } })
}
