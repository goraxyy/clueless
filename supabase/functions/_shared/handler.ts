// The `ai` function: a signed-in student's Claude request goes in, Claude's reply comes out, and
// the tokens it used are recorded against their weekly caps. Everything outside (the database,
// Claude, the clock) comes in through `Deps`, so the app's tests run this exact code in Node with
// a fake database and a fake Claude.
//
// The app points the Anthropic SDK at this function, so requests arrive as POST .../v1/messages
// with the student's access token as the bearer token and the job in `x-clueless-job`.
import {
  costOf,
  fillHidden,
  hiddenMarker,
  hiddenText,
  jobConfig,
  refusalFor,
  shapeRequest,
  StreamUsage,
  usageFrom,
  type Job,
  type Unit,
  type Usage,
  type UsageState
} from './policy.ts'

/** One row of `usage_events`. */
export interface UsageEvent {
  user_id: string
  job: Job
  unit: Unit | null
  model: string
  status: number
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  cost_usd: number
}

export interface Deps {
  /** The student's id if the access token is valid, else null. */
  userFor(token: string): Promise<string | null>
  /** usage_check() for the student. */
  usage(userId: string): Promise<UsageState | null>
  /** A saved session's hidden solution and full plan; null when the student has no such session. */
  secrets(userId: string, sessionId: string): Promise<{ hidden_solution: string; plan: unknown } | null>
  record(event: UsageEvent): Promise<void>
  /** Calls Claude. */
  fetch: typeof fetch
  env(name: string): string | undefined
  /** Keeps work going after the response has been sent (recording a streamed reply's usage). */
  waitUntil(work: Promise<unknown>): void
  log?(line: string): void
}

/** Screenshots are base64 inside the JSON; a few full-screen ones fit well under this. */
const MAX_BODY_BYTES = 20_000_000

/** An error in the Claude API's own shape, so the SDK in the app reads it like any other. `x-should-retry:
 *  false` stops the SDK from retrying a limit that won't change in the next second. */
export function errorResponse(status: number, type: string, message: string): Response {
  return new Response(JSON.stringify({ type: 'error', error: { type, message } }), {
    status,
    headers: { 'content-type': 'application/json', 'x-should-retry': 'false' }
  })
}

export async function handle(req: Request, deps: Deps): Promise<Response> {
  const log = deps.log ?? (() => {})
  if (req.method !== 'POST') return errorResponse(405, 'clueless_bad_request', 'Use POST.')
  if (!new URL(req.url).pathname.endsWith('/v1/messages')) return errorResponse(404, 'clueless_bad_request', 'Unknown path.')

  const token = /^Bearer\s+(.+)$/i.exec(req.headers.get('authorization') ?? '')?.[1]?.trim()
  const userId = token ? await deps.userFor(token).catch(() => null) : null
  if (!userId) return errorResponse(401, 'clueless_signed_out', 'Sign in to Clueless again.')

  const job = req.headers.get('x-clueless-job')
  if (job !== 'tutor' && job !== 'fast') return errorResponse(400, 'clueless_bad_request', 'Unknown job.')

  const length = Number(req.headers.get('content-length') ?? 0)
  if (length > MAX_BODY_BYTES) return errorResponse(413, 'clueless_too_big', 'That request is too big. Try a smaller screenshot or highlight.')
  const text = await req.text()
  if (text.length > MAX_BODY_BYTES) return errorResponse(413, 'clueless_too_big', 'That request is too big. Try a smaller screenshot or highlight.')
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return errorResponse(400, 'clueless_bad_request', 'The request isn\'t JSON.')
  }

  const shaped = await shapeRequest(raw, req.headers.get('anthropic-beta'), jobConfig(job, deps.env))
  if (typeof shaped === 'string') {
    log(`refused a request from ${userId}: ${shaped}`)
    return errorResponse(400, 'clueless_bad_request', shaped)
  }

  // Continuing a saved session: put back what Clueless knew, which the student's app never had.
  // It's the same problem, so it doesn't count as a new one.
  const continued = hiddenMarker(shaped.body.messages as unknown[])
  if (continued) {
    let saved: Awaited<ReturnType<Deps['secrets']>> = null
    try {
      saved = await deps.secrets(userId, continued)
    } catch (err) {
      log(`reading the session's secrets failed: ${(err as Error).message}`)
    }
    shaped.body.messages = fillHidden(shaped.body.messages as unknown[], hiddenText(saved?.hidden_solution ?? '', saved?.plan ?? []))
    if (saved) shaped.unit = null
  }

  let state: UsageState | null
  try {
    state = await deps.usage(userId)
  } catch (err) {
    log(`usage_check failed: ${(err as Error).message}`)
    return errorResponse(503, 'clueless_server', 'Clueless is having trouble right now. Try again in a minute.')
  }
  const refusal = refusalFor(state, shaped.unit)
  if (refusal) return errorResponse(refusal.status, refusal.type, refusal.message)

  const key = deps.env('ANTHROPIC_API_KEY')
  if (!key) {
    log('ANTHROPIC_API_KEY is not set')
    return errorResponse(503, 'clueless_server', 'Clueless is having trouble right now. Try again in a minute.')
  }
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' }
  if (shaped.betas.length) headers['anthropic-beta'] = shaped.betas.join(',')
  const base = deps.env('ANTHROPIC_BASE_URL') || 'https://api.anthropic.com'

  // No abort signal on purpose: if the app gives up, Claude still finishes and bills the reply, and
  // reading it to the end is the only way to count it.
  let upstream: Response
  try {
    upstream = await deps.fetch(`${base}/v1/messages`, { method: 'POST', headers, body: JSON.stringify(shaped.body) })
  } catch (err) {
    log(`Claude unreachable: ${(err as Error).message}`)
    return errorResponse(502, 'clueless_server', 'Clueless can\'t reach Claude right now. Try again in a minute.')
  }

  const event = (status: number, model: string, usage: Usage, unit: Unit | null): UsageEvent => ({
    user_id: userId,
    job,
    unit,
    model,
    status,
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cache_read_tokens: usage.cache_read_input_tokens,
    cache_write_tokens: usage.cache_creation_input_tokens,
    cost_usd: costOf(model, usage)
  })
  const record = (e: UsageEvent): Promise<void> =>
    deps.record(e).catch((err) => log(`recording usage failed: ${(err as Error).message}`))

  // Claude refused the request (overloaded, bad input...). It still counts towards the per-minute
  // limit, but never towards the weekly problems or Asks.
  if (!upstream.ok) {
    const body = await upstream.text()
    log(`Claude returned ${upstream.status}: ${body.slice(0, 300)}`)
    await record(event(upstream.status, shaped.model, usageFrom(null), null))
    // Our key or our account being refused isn't the student's fault, and their sign-in is fine.
    if (upstream.status === 401 || upstream.status === 403) {
      return errorResponse(502, 'clueless_server', 'Clueless is having trouble reaching Claude. Try again later.')
    }
    return new Response(body, { status: upstream.status, headers: passThrough(upstream.headers) })
  }

  if (!shaped.stream || !upstream.body) {
    const body = await upstream.text()
    let reply: Record<string, unknown> = {}
    try {
      reply = JSON.parse(body)
    } catch {
      // passed on as is; nothing to count
    }
    const model = typeof reply.model === 'string' ? reply.model : shaped.model
    await record(event(upstream.status, model, usageFrom(reply.usage), shaped.unit))
    return new Response(body, { status: upstream.status, headers: passThrough(upstream.headers) })
  }

  // Streamed: the student gets one copy, the meter reads the other. The meter's copy is read to the
  // end even if the app stops listening, so every token Claude produced is counted.
  const [toStudent, toMeter] = upstream.body.tee()
  deps.waitUntil(
    (async () => {
      const meter = new StreamUsage()
      const reader = toMeter.getReader()
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          meter.push(value)
        }
      } catch (err) {
        log(`reading the stream for usage failed: ${(err as Error).message}`)
      }
      await record(event(upstream.status, meter.model ?? shaped.model, meter.usage, shaped.unit))
    })()
  )
  return new Response(toStudent, { status: upstream.status, headers: passThrough(upstream.headers) })
}

/** Only the headers the SDK needs from Claude's response. */
function passThrough(from: Headers): Headers {
  const out = new Headers()
  for (const name of ['content-type', 'request-id', 'retry-after', 'cache-control']) {
    const value = from.get(name)
    if (value) out.set(name, value)
  }
  return out
}
