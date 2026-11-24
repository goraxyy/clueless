// deno test supabase/functions/api
import { assert, assertEquals } from 'jsr:@std/assert@1'
import { costMicro, handle, SseUsage, type Deps, type UsageRow } from './handler.ts'

const BASE = 'https://x.supabase.co/functions/v1/api'

interface Call {
  url: string
  init: RequestInit
}

function setup(over: Partial<Deps> = {}, reply: (call: Call) => Response = () => okMessage()) {
  const calls: Call[] = []
  const rows: UsageRow[] = []
  const subs: { userId: string; plan: string; id: string; status: string }[] = []
  const deps: Deps = {
    anthropicKey: 'sk-server',
    deepgramKey: 'dg-server',
    elevenLabsKey: 'el-server',
    fetch: (async (url: string | URL | Request, init: RequestInit = {}) => {
      const call = { url: String(url), init }
      calls.push(call)
      return reply(call)
    }) as typeof fetch,
    verifyUser: async (token) => (token === 'good' ? { id: 'u1', email: 'a@b.c' } : null),
    plan: async () => 'free',
    monthSpend: async () => 0,
    recordUsage: async (row) => {
      rows.push(row)
    },
    setSubscription: async (userId, sub) => {
      subs.push({ userId, ...sub })
    },
    limits: { free: 1_000_000, pro: 8_000_000 },
    ...over
  }
  return { deps, calls, rows, subs }
}

function okMessage(model = 'claude-sonnet-5-5'): Response {
  return new Response(
    JSON.stringify({ id: 'msg_1', model, content: [], usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 5000 } }),
    { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req_1' } }
  )
}

function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: { authorization: 'Bearer good', 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  })
}

const ask = { model: 'claude-sonnet-5-5', max_tokens: 1000, messages: [{ role: 'user', content: 'hi' }] }

Deno.test('no token or a bad token is refused', async () => {
  const { deps, calls } = setup()
  const none = await handle(new Request(`${BASE}/v1/messages`, { method: 'POST', body: '{}' }), deps)
  assertEquals(none.status, 401)
  const bad = await handle(post('/v1/messages', ask, { authorization: 'Bearer nope' }), deps)
  assertEquals(bad.status, 401)
  assertEquals(calls.length, 0)
})

Deno.test('a Claude call goes through with the server key, not the user token, and is recorded', async () => {
  const { deps, calls, rows } = setup()
  const res = await handle(post('/v1/messages?beta=true', ask, { 'anthropic-beta': 'server-side-fallback-2026-07-01', 'x-api-key': 'user-key' }), deps)
  assertEquals(res.status, 200)
  assertEquals(res.headers.get('request-id'), 'req_1')
  assertEquals(calls[0].url, 'https://api.anthropic.com/v1/messages?beta=true')
  const h = calls[0].init.headers as Record<string, string>
  assertEquals(h['x-api-key'], 'sk-server')
  assertEquals(h['anthropic-beta'], 'server-side-fallback-2026-07-01')
  assert(!('authorization' in h))
  assertEquals(rows.length, 1)
  // 1000 * 2 + 100 * 10 + 5000 * 0.1
  assertEquals(rows[0].cost_micro, 3500)
  assertEquals(rows[0].user_id, 'u1')
})

Deno.test('models other than the two the app uses are refused', async () => {
  const { deps, calls } = setup()
  const res = await handle(post('/v1/messages', { ...ask, model: 'claude-fable-5-2' }), deps)
  assertEquals(res.status, 400)
  assertEquals(calls.length, 0)
})

Deno.test('max_tokens is capped', async () => {
  const { deps } = setup()
  const res = await handle(post('/v1/messages', { ...ask, max_tokens: 500000 }), deps)
  assertEquals(res.status, 400)
})

Deno.test('over the monthly limit: 402 with a message, and Claude is not called', async () => {
  const { deps, calls } = setup({ monthSpend: async () => 1_000_000 })
  const res = await handle(post('/v1/messages', ask), deps)
  assertEquals(res.status, 402)
  const body = await res.json()
  assertEquals(body.type, 'error')
  assert(/free/.test(body.error.message))
  assertEquals(calls.length, 0)
})

Deno.test('Pro has its own limit', async () => {
  const { deps } = setup({ plan: async () => 'pro', monthSpend: async () => 1_000_000 })
  const res = await handle(post('/v1/messages', ask), deps)
  assertEquals(res.status, 200)
})

Deno.test("Claude's errors come back as they were, and nothing is recorded", async () => {
  const err = { type: 'error', error: { type: 'invalid_request_error', message: 'fallbacks: beta not enabled' } }
  const { deps, rows } = setup({}, () => new Response(JSON.stringify(err), { status: 400, headers: { 'content-type': 'application/json' } }))
  const res = await handle(post('/v1/messages', ask), deps)
  assertEquals(res.status, 400)
  assertEquals(await res.json(), err)
  assertEquals(rows.length, 0)
})

Deno.test('a streamed reply passes through and its usage is recorded at the end', async () => {
  const events = [
    'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-haiku-5-5","usage":{"input_tokens":2000,"output_tokens":1,"cache_read_input_tokens":0}}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":400}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n'
  ]
  const enc = new TextEncoder()
  // Split mid-line to check the parser buffers across chunks.
  const all = events.join('')
  const chunks = [all.slice(0, 50), all.slice(50, 210), all.slice(210)]
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch))
      c.close()
    }
  })
  const { deps, rows } = setup({}, () => new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }))
  const res = await handle(post('/v1/messages', { ...ask, model: 'claude-haiku-5-5', stream: true }), deps)
  assertEquals(res.headers.get('content-type'), 'text/event-stream')
  assertEquals(await res.text(), all)
  await new Promise((r) => setTimeout(r, 0))
  assertEquals(rows.length, 1)
  assertEquals(rows[0].model, 'claude-haiku-5-5')
  assertEquals(rows[0].output_tokens, 400)
  // 2000 * 0.1 + 400 * 0.5
  assertEquals(rows[0].cost_micro, 400)
})

Deno.test('a refusal fallback is priced at the model that answered', () => {
  assertEquals(costMicro('claude-opus-4-8', { input_tokens: 100, output_tokens: 10 }), 750)
  assertEquals(costMicro('something-new', { input_tokens: 100 }), 500)
})

Deno.test('SseUsage ignores pings and junk', () => {
  const m = new SseUsage('claude-sonnet-5-5')
  m.feed('event: ping\ndata: {"type": "ping"}\n\ndata: not json\n')
  assertEquals(m.usage, {})
})

Deno.test('/me shows the plan, spend and limit', async () => {
  const { deps } = setup({ monthSpend: async () => 250_000, now: () => new Date('2026-11-24T10:00:00Z') })
  const res = await handle(new Request(`${BASE}/me`, { headers: { authorization: 'Bearer good' } }), deps)
  assertEquals(await res.json(), {
    email: 'a@b.c',
    plan: 'free',
    spentMicro: 250_000,
    limitMicro: 1_000_000,
    resetsAt: '2026-12-01T00:00:00.000Z',
    upgradeUrl: null,
    manageUrl: null
  })
})

Deno.test('a Deepgram token is minted with the server key', async () => {
  const { deps, calls, rows } = setup({}, () => Response.json({ access_token: 'dg-temp', expires_in: 30 }))
  const res = await handle(post('/voice/stt-token', {}), deps)
  assertEquals(await res.json(), { token: 'dg-temp', expiresIn: 30 })
  assertEquals(calls[0].url, 'https://api.deepgram.com/v1/auth/grant')
  assertEquals((calls[0].init.headers as Record<string, string>).authorization, 'Token dg-server')
  assertEquals(rows[0].kind, 'stt')
})

Deno.test('ElevenLabs: speech goes through and its characters are counted; other paths are refused', async () => {
  const { deps, calls, rows } = setup({}, () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'audio/mpeg' } }))
  const res = await handle(post('/elevenlabs/v1/text-to-speech/abc123?output_format=mp3_44100_128', { text: 'Hello there' }), deps)
  assertEquals(res.status, 200)
  assertEquals(new Uint8Array(await res.arrayBuffer()), new Uint8Array([1, 2, 3]))
  assertEquals(calls[0].url, 'https://api.elevenlabs.io/v1/text-to-speech/abc123?output_format=mp3_44100_128')
  assertEquals((calls[0].init.headers as Record<string, string>)['xi-api-key'], 'el-server')
  assertEquals(rows[0].characters, 11)

  const voices = await handle(new Request(`${BASE}/elevenlabs/v2/voices?page_size=100`, { headers: { authorization: 'Bearer good' } }), deps)
  assertEquals(voices.status, 200)
  const other = await handle(post('/elevenlabs/v1/user/delete', {}), deps)
  assertEquals(other.status, 404)
})

Deno.test('unknown paths are 404', async () => {
  const { deps } = setup()
  const res = await handle(new Request(`${BASE}/v1/models`, { headers: { authorization: 'Bearer good' } }), deps)
  assertEquals(res.status, 404)
})

Deno.test("Claude refusing the server's key is the server's error, not a sign-in problem", async () => {
  const { deps } = setup({}, () => new Response('{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}', { status: 401 }))
  const res = await handle(post('/v1/messages', ask), deps)
  assertEquals(res.status, 502)
  assert(/can't reach Claude/.test((await res.json()).error.message))
})

Deno.test('a stream the app cancels midway is still counted', async () => {
  const enc = new TextEncoder()
  let upstreamCancelled = false
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc.encode('data: {"type":"message_start","message":{"model":"claude-sonnet-5-5","usage":{"input_tokens":3000,"output_tokens":1}}}\n\n'))
      c.enqueue(enc.encode('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"' + 'x'.repeat(300) + '"}}\n\n'))
      // ...and never ends on its own
    },
    cancel() {
      upstreamCancelled = true
    }
  })
  const { deps, rows } = setup({}, () => new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }))
  const res = await handle(post('/v1/messages', { ...ask, stream: true }), deps)
  const reader = res.body!.getReader()
  await reader.read()
  await reader.read()
  await reader.cancel()
  await new Promise((r) => setTimeout(r, 0))
  assert(upstreamCancelled)
  assertEquals(rows.length, 1)
  assertEquals(rows[0].input_tokens, 3000)
  assertEquals(rows[0].output_tokens, 100) // 300 characters / 3
})

Deno.test('server tools, MCP and containers are refused; plain tools are fine', async () => {
  const { deps, calls } = setup()
  for (const extra of [
    { tools: [{ type: 'web_search_20260209', name: 'web_search' }] },
    { mcp_servers: [{ type: 'url', url: 'https://x', name: 'x' }] },
    { container: { skills: [] } }
  ]) {
    const res = await handle(post('/v1/messages', { ...ask, ...extra }), deps)
    assertEquals(res.status, 400)
  }
  assertEquals(calls.length, 0)
  const ok = await handle(post('/v1/messages', { ...ask, tools: [{ name: 'reply', input_schema: { type: 'object' } }] }), deps)
  assertEquals(ok.status, 200)
})

// ---------- payments ----------

const PAY = { webhookSecret: 'whsec-test', checkoutUrl: 'https://clueless.lemonsqueezy.com/checkout/buy/abc', portalUrl: 'https://app.lemonsqueezy.com/my-orders', testMode: false }
const USER = '11111111-2222-4333-8444-555555555555'

async function signed(body: unknown, secret = PAY.webhookSecret): Promise<Request> {
  const raw = JSON.stringify(body)
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw)))].map((b) => b.toString(16).padStart(2, '0')).join('')
  return new Request(`${BASE}/webhooks/lemonsqueezy`, { method: 'POST', headers: { 'x-signature': sig, 'content-type': 'application/json' }, body: raw })
}

const subEvent = (name: string, status: string, extra: Record<string, unknown> = {}) => ({
  meta: { event_name: name, custom_data: { user_id: USER } },
  data: { type: 'subscriptions', id: '42', attributes: { status, test_mode: false, ...extra } }
})

Deno.test('payments: a signed subscription event sets the plan, no sign-in needed', async () => {
  const { deps, subs } = setup({ payments: PAY })
  const res = await handle(await signed(subEvent('subscription_created', 'active')), deps)
  assertEquals(res.status, 200)
  assertEquals(subs, [{ userId: USER, plan: 'pro', id: '42', status: 'active' }])
})

Deno.test('payments: cancelled keeps Pro until it expires; expired, unpaid and paused are Free', async () => {
  const { deps, subs } = setup({ payments: PAY })
  for (const [name, status] of [['subscription_cancelled', 'cancelled'], ['subscription_expired', 'expired'], ['subscription_updated', 'unpaid'], ['subscription_paused', 'paused'], ['subscription_payment_failed', 'past_due']]) {
    await handle(await signed(subEvent(name, status)), deps)
  }
  assertEquals(subs.map((s) => s.plan), ['pro', 'free', 'free', 'free', 'pro'])
})

Deno.test('payments: a wrong signature, test-mode events and other events change nothing', async () => {
  const { deps, subs } = setup({ payments: PAY })
  assertEquals((await handle(await signed(subEvent('subscription_created', 'active'), 'wrong-secret'), deps)).status, 401)
  assertEquals((await handle(await signed(subEvent('subscription_created', 'active', { test_mode: true })), deps)).status, 200)
  assertEquals((await handle(await signed({ meta: { event_name: 'order_created' }, data: { type: 'orders' } }), deps)).status, 200)
  const noUser = subEvent('subscription_created', 'active')
  noUser.meta.custom_data = { user_id: 'not-a-uuid' }
  assertEquals((await handle(await signed(noUser), deps)).status, 200)
  assertEquals(subs.length, 0)
  // Without payments set up, the route doesn't exist.
  const off = setup()
  assertEquals((await handle(await signed(subEvent('subscription_created', 'active')), off.deps)).status, 404)
})

Deno.test('/me: a checkout link carrying the user for Free, the portal for Pro', async () => {
  const free = setup({ payments: PAY })
  const me = await (await handle(new Request(`${BASE}/me`, { headers: { authorization: 'Bearer good' } }), free.deps)).json()
  assertEquals(me.upgradeUrl, `${PAY.checkoutUrl}?checkout[custom][user_id]=u1&checkout[email]=a%40b.c`)
  assertEquals(me.manageUrl, null)
  const pro = setup({ payments: PAY, plan: async () => 'pro' })
  const me2 = await (await handle(new Request(`${BASE}/me`, { headers: { authorization: 'Bearer good' } }), pro.deps)).json()
  assertEquals([me2.upgradeUrl, me2.manageUrl], [null, PAY.portalUrl])
})

Deno.test('without a Claude key, Claude calls say so; the rest still works', async () => {
  const { deps, calls } = setup({ anthropicKey: '' })
  const res = await handle(post('/v1/messages', ask), deps)
  assertEquals(res.status, 503)
  assert(/no Claude key/.test((await res.json()).error.message))
  assertEquals(calls.length, 0)
  const me = await handle(new Request(`${BASE}/me`, { headers: { authorization: 'Bearer good' } }), deps)
  assertEquals(me.status, 200)
})
