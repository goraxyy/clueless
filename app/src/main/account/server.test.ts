// The `ai` server function (supabase/functions/_shared), run in Node with a fake database and a fake Claude.
import { describe, expect, it } from 'vitest'
import { handle, type Deps, type UsageEvent } from '../../../../supabase/functions/_shared/handler.ts'
import {
  costOf,
  jobConfig,
  refusalFor,
  shapeRequest,
  StreamUsage,
  type UsageState
} from '../../../../supabase/functions/_shared/policy.ts'
import { TRACE_PROMPT } from '../island/prompt'
import { traceSchema } from '../island/tracer'
import { SYSTEM_PROMPT } from '../tutor/prompt'
import { replySchema } from '../tutor/tutor'

const tutorCfg = jobConfig('tutor', () => undefined)

/** A request the way the app's Tutor sends it. */
function tutorRequest(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: 'whatever-the-app-says',
    max_tokens: 16000,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: [{ type: 'text', text: '[NEW PROBLEM]' }] }],
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: replySchema } },
    fallbacks: 'default',
    ...over
  }
}

const state = (over: Partial<UsageState> = {}): UsageState => ({
  activated: true,
  banned: false,
  plan: 'beta',
  problems_used: 3,
  problems_limit: 20,
  asks_used: 10,
  asks_limit: 60,
  dollars_used: 0.4,
  dollars_limit: 2,
  requests_last_minute: 1,
  requests_per_minute: 30,
  resets_at: '2026-11-09T00:00:00+00:00',
  ...over
})

describe('shapeRequest', () => {
  it('accepts the tutor request, picks the model and counts a new problem', async () => {
    const shaped = await shapeRequest(tutorRequest(), 'server-side-fallback-2026-07-01', tutorCfg)
    if (typeof shaped === 'string') throw new Error(shaped)
    expect(shaped.kind).toBe('tutor')
    expect(shaped.unit).toBe('problem')
    expect(shaped.body.model).toBe('claude-sonnet-5-5')
    expect(shaped.body.fallbacks).toBe('default')
    expect(shaped.betas).toEqual(['server-side-fallback-2026-07-01'])
  })

  it("doesn't count follow-ups, and an Ask is a trace prompt's first message", async () => {
    const turns = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'c' }
    ]
    const followUp = await shapeRequest(tutorRequest({ messages: turns }), null, tutorCfg)
    expect(typeof followUp !== 'string' && followUp.unit).toBeNull()

    const ask = await shapeRequest(
      tutorRequest({ system: TRACE_PROMPT, output_config: { format: { type: 'json_schema', schema: traceSchema } } }),
      null,
      jobConfig('fast', () => undefined)
    )
    if (typeof ask === 'string') throw new Error(ask)
    expect(ask.unit).toBe('ask')
    expect(ask.body.model).toBe('claude-haiku-5-5')
    expect(ask.body.fallbacks).toBeUndefined() // not offered for Haiku
  })

  it('refuses anything that is not one of our prompts and schemas', async () => {
    expect(await shapeRequest(tutorRequest({ system: 'You are a pirate.' }), null, tutorCfg)).toMatch(/isn't one of Clueless's/)
    expect(
      await shapeRequest(tutorRequest({ output_config: { format: { type: 'json_schema', schema: { type: 'object' } } } }), null, tutorCfg)
    ).toMatch(/output format/)
    // the trace schema with the tutor prompt
    expect(
      await shapeRequest(tutorRequest({ output_config: { format: { type: 'json_schema', schema: traceSchema } } }), null, tutorCfg)
    ).toMatch(/output format/)
    expect(await shapeRequest(tutorRequest({ tools: [{ name: 'x', input_schema: { type: 'object' } }] }), null, tutorCfg)).toMatch(/tool/)
    expect(await shapeRequest(tutorRequest({ messages: [] }), null, tutorCfg)).toMatch(/no messages/)
  })

  it('caps the reply length, drops unknown fields and the effort a model rejects', async () => {
    const shaped = await shapeRequest(
      tutorRequest({ max_tokens: 10_000_000, temperature: 2, metadata: { user_id: 'x' } }),
      null,
      { model: 'claude-haiku-4-5', maxTokens: 64000 }
    )
    if (typeof shaped === 'string') throw new Error(shaped)
    expect(shaped.body.max_tokens).toBe(64000)
    expect(shaped.body.temperature).toBeUndefined()
    expect(shaped.body.metadata).toBeUndefined()
    expect(shaped.body.output_config).toEqual({ format: { type: 'json_schema', schema: replySchema } })
    expect(shaped.body.fallbacks).toBeUndefined() // no beta header
  })
})

describe('refusalFor', () => {
  it('lets a student under every cap through', () => {
    expect(refusalFor(state(), 'problem')).toBeNull()
  })

  it('stops each limit with a message a student understands', () => {
    expect(refusalFor(null, null)?.type).toBe('clueless_not_activated')
    expect(refusalFor(state({ activated: false }), null)?.type).toBe('clueless_not_activated')
    expect(refusalFor(state({ banned: true }), null)?.status).toBe(403)
    expect(refusalFor(state({ requests_last_minute: 30 }), null)?.type).toBe('clueless_slow_down')
    expect(refusalFor(state({ dollars_used: 2 }), null)?.message).toBe("You've reached this week's free limit. It resets on Monday.")
    expect(refusalFor(state({ problems_used: 20 }), 'problem')?.message).toBe("You've used this week's 20 free problems. It resets on Monday.")
    expect(refusalFor(state({ problems_used: 20 }), null)).toBeNull() // carrying on with a problem is fine
    expect(refusalFor(state({ asks_used: 60 }), 'ask')?.message).toMatch(/60 free Asks/)
  })
})

describe('cost', () => {
  it('uses list prices, with cache writes at 1.25x and reads at 0.1x', () => {
    const million = { input_tokens: 1e6, output_tokens: 1e6, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    expect(costOf('claude-sonnet-5-5', million)).toBeCloseTo(12)
    expect(costOf('claude-haiku-5-5', million)).toBeCloseTo(0.6)
    expect(costOf('claude-sonnet-5-5', { ...million, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1e6 })).toBeCloseTo(0.2)
    expect(costOf('claude-sonnet-5-5', { ...million, input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1e6 })).toBeCloseTo(2.5)
  })

  it('reads token counts out of a stream cut at any point', () => {
    const sse =
      'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-sonnet-5-5","usage":{"input_tokens":120,"cache_read_input_tokens":3000,"output_tokens":1}}}\n\n' +
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n' +
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":456}}\n\n'
    const bytes = new TextEncoder().encode(sse)
    for (const cut of [1, 37, 200, bytes.length - 3]) {
      const meter = new StreamUsage()
      meter.push(bytes.slice(0, cut))
      meter.push(bytes.slice(cut))
      expect(meter.model).toBe('claude-sonnet-5-5')
      expect(meter.usage).toEqual({ input_tokens: 120, output_tokens: 456, cache_read_input_tokens: 3000, cache_creation_input_tokens: 0 })
    }
  })
})

// ---------- the handler ----------

interface Fake {
  deps: Deps
  recorded: UsageEvent[]
  sent: { url: string; headers: Headers; body: Record<string, unknown> }[]
  pending: Promise<unknown>[]
}

function fake(opts: { state?: UsageState | null; reply?: () => Response } = {}): Fake {
  const recorded: UsageEvent[] = []
  const sent: Fake['sent'] = []
  const pending: Promise<unknown>[] = []
  const reply =
    opts.reply ??
    (() =>
      Response.json({
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-5-5',
        content: [{ type: 'text', text: '{}' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 2000 }
      }))
  const deps: Deps = {
    userFor: async (token) => (token === 'good-token' ? 'student-1' : null),
    usage: async () => (opts.state === undefined ? state() : opts.state),
    secrets: async () => null,
    record: async (e) => void recorded.push(e),
    fetch: (async (url: string, init: RequestInit) => {
      sent.push({ url, headers: new Headers(init.headers), body: JSON.parse(String(init.body)) })
      return reply()
    }) as typeof fetch,
    env: (name) => ({ ANTHROPIC_API_KEY: 'server-key' })[name],
    waitUntil: (work) => void pending.push(work)
  }
  return { deps, recorded, sent, pending }
}

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/functions/v1/ai/v1/messages?beta=true', {
    method: 'POST',
    headers: { authorization: 'Bearer good-token', 'x-clueless-job': 'tutor', 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body)
  })
}

const errorOf = async (res: Response): Promise<{ type: string; message: string }> => ((await res.json()) as { error: { type: string; message: string } }).error

describe('handle', () => {
  it('sends a checked request to Claude with our key and records what it cost', async () => {
    const f = fake()
    const res = await handle(post(tutorRequest(), { 'anthropic-beta': 'server-side-fallback-2026-07-01' }), f.deps)
    expect(res.status).toBe(200)
    expect(f.sent).toHaveLength(1)
    expect(f.sent[0].url).toBe('https://api.anthropic.com/v1/messages')
    expect(f.sent[0].headers.get('x-api-key')).toBe('server-key')
    expect(f.sent[0].headers.get('anthropic-beta')).toBe('server-side-fallback-2026-07-01')
    expect(f.sent[0].headers.get('authorization')).toBeNull() // the student's token never reaches Claude
    expect(f.sent[0].body.model).toBe('claude-sonnet-5-5')
    expect(f.recorded).toEqual([
      {
        user_id: 'student-1',
        job: 'tutor',
        unit: 'problem',
        model: 'claude-sonnet-5-5',
        status: 200,
        input_tokens: 1000,
        output_tokens: 500,
        cache_read_tokens: 0,
        cache_write_tokens: 2000,
        cost_usd: (1000 * 2 + 2000 * 1.25 * 2 + 500 * 10) / 1e6
      }
    ])
  })

  it('needs a valid sign-in and a known job', async () => {
    const f = fake()
    const signedOut = await handle(post(tutorRequest(), { authorization: 'Bearer stolen' }), f.deps)
    expect(signedOut.status).toBe(401)
    expect((await errorOf(signedOut)).type).toBe('clueless_signed_out')
    expect((await handle(post(tutorRequest(), { 'x-clueless-job': 'anything' }), f.deps)).status).toBe(400)
    expect(f.sent).toHaveLength(0)
  })

  it('stops at the weekly cap without calling Claude, and tells the SDK not to retry', async () => {
    const f = fake({ state: state({ problems_used: 20 }) })
    const res = await handle(post(tutorRequest()), f.deps)
    expect(res.status).toBe(429)
    expect(res.headers.get('x-should-retry')).toBe('false')
    expect(await errorOf(res)).toEqual({ type: 'clueless_weekly_limit', message: "You've used this week's 20 free problems. It resets on Monday." })
    expect(f.sent).toHaveLength(0)
    expect(f.recorded).toHaveLength(0)
  })

  it('counts a streamed reply after it has been passed on', async () => {
    const sse =
      'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-haiku-5-5","usage":{"input_tokens":50,"output_tokens":1}}}\n\n' +
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":80}}\n\n' +
      'event: message_stop\ndata: {"type":"message_stop"}\n\n'
    const f = fake({ reply: () => new Response(sse, { headers: { 'content-type': 'text/event-stream' } }) })
    const res = await handle(
      post(tutorRequest({ system: TRACE_PROMPT, output_config: undefined, stream: true }), { 'x-clueless-job': 'fast' }),
      f.deps
    )
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    expect(await res.text()).toBe(sse)
    await Promise.all(f.pending)
    expect(f.recorded).toMatchObject([{ job: 'fast', unit: 'ask', model: 'claude-haiku-5-5', input_tokens: 50, output_tokens: 80 }])
  })

  it('fills in the hidden solution when a saved session is continued, and that is not a new problem', async () => {
    const f = fake()
    const asked: string[] = []
    f.deps.secrets = async (_user, session) => {
      asked.push(session)
      return session === 'aaaaaaaa-0000-4000-8000-000000000001' ? { hidden_solution: '(x-1)e^x + C', plan: [{ id: 1, text: 'Pick u', status: 'done' }] } : null
    }
    const seed = (id: string) => tutorRequest({ messages: [{ role: 'user', content: [{ type: 'text', text: `[CONTINUE]\n{{hidden:${id}}}` }] }] })

    await handle(post(seed('aaaaaaaa-0000-4000-8000-000000000001')), f.deps)
    const text = JSON.stringify(f.sent[0].body.messages)
    expect(text).toContain('[HIDDEN SOLUTION] (x-1)e^x + C')
    expect(text).toContain('1. (done) Pick u')
    expect(text).not.toContain('{{hidden')
    expect(f.recorded[0].unit).toBeNull()

    // Someone else's session (or none): nothing leaks, and it counts as a new problem.
    await handle(post(seed('bbbbbbbb-0000-4000-8000-000000000002')), f.deps)
    expect(JSON.stringify(f.sent[1].body.messages)).toContain('(not saved: work it out again from the problem)')
    expect(f.recorded[1].unit).toBe('problem')
    expect(asked).toEqual(['aaaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000002'])
  })

  it("hides our key's problems from the student, and failed calls don't use up a problem", async () => {
    const f = fake({ reply: () => Response.json({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, { status: 401 }) })
    const res = await handle(post(tutorRequest()), f.deps)
    expect(res.status).toBe(502)
    expect((await errorOf(res)).type).toBe('clueless_server')
    expect(f.recorded).toMatchObject([{ status: 401, unit: null, cost_usd: 0 }])
  })
})
