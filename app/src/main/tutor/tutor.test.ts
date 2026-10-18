import Anthropic from '@anthropic-ai/sdk'
import { describe, expect, it } from 'vitest'
import { createTransport, detectProvider, providerInfo } from './provider'
import { fromWire, parseReply, replySchema, Tutor, TutorError, type ClaudeClient, type TutorTransport } from './tutor'

/** Walk a JSON schema and count what the structured-outputs limits count. */
function schemaStats(schema: unknown) {
  let unions = 0
  let optional = 0
  let openObjects = 0
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return
    const n = node as Record<string, unknown>
    if (Array.isArray(n.anyOf) || Array.isArray(n.type) || Array.isArray(n.oneOf)) unions++
    if (n.type === 'object' && n.properties) {
      const required = new Set((n.required as string[]) ?? [])
      optional += Object.keys(n.properties as object).filter((k) => !required.has(k)).length
      if (n.additionalProperties !== false) openObjects++
    }
    Object.values(n).forEach((v) => (Array.isArray(v) ? v.forEach(walk) : walk(v)))
  }
  walk(schema)
  return { unions, optional, openObjects }
}

const wireTurn = {
  kind: 'question',
  message: 'What do you get?',
  hintLevel: 7,
  verdict: 'none',
  plan: [{ id: 1, text: 'Integrate', status: 'current' }],
  gap: { type: 'none', topic: '' },
  expects: 'math',
  choices: [],
  visual: { caption: '', frames: [], narration: [] },
  check: { kind: 'antiderivative', reference: 'x^2*e^x', variable: 'x', unit: '' }
}

describe('reply schema', () => {
  it('stays inside the structured-outputs limits (16 unions, 24 optional, closed objects)', () => {
    const stats = schemaStats(replySchema)
    expect(stats.unions).toBeLessThanOrEqual(4)
    expect(stats.optional).toBe(0)
    expect(stats.openObjects).toBe(0)
    expect(JSON.stringify(replySchema)).not.toContain('"oneOf"')
  })
})

describe('fromWire / parseReply', () => {
  it('turns placeholders into nulls and clamps the hint level', () => {
    const reply = parseReply(
      JSON.stringify({
        problem: { subject: 'math', title: 't', summary: 's', language: '', hiddenSolution: 'h' },
        turn: wireTurn,
        recap: null
      })
    )
    expect(reply.problem?.language).toBeNull()
    expect(reply.turn.gap).toBeNull()
    expect(reply.turn.visual).toBeNull()
    expect(reply.turn.hintLevel).toBe(5)
    expect(reply.turn.check).toEqual({ kind: 'antiderivative', reference: 'x^2*e^x', variable: 'x', unit: null })
  })

  it('drops checks without a reference', () => {
    const reply = fromWire({
      problem: null,
      turn: { ...wireTurn, check: { kind: 'units', reference: ' ', variable: '', unit: 'm' } } as never,
      recap: null
    })
    expect(reply.turn.check).toBeNull()
  })

  it('rejects garbage', () => {
    expect(() => parseReply('not json')).toThrow(TutorError)
    expect(() => parseReply('{"turn":{}}')).toThrow(TutorError)
  })
})

type Block = Record<string, unknown>

function fakeClient(replies: Block[][]) {
  const calls: Record<string, unknown>[] = []
  const client: ClaudeClient = {
    beta: {
      messages: {
        create: async (params: Record<string, unknown>) => {
          calls.push(structuredClone(params))
          const content = replies.shift() ?? []
          return {
            content,
            stop_reason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
            usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0 }
          } as never
        }
      }
    }
  }
  return { client, calls }
}

const problem = { subject: 'math', title: 't', summary: 's', language: '', hiddenSolution: 'h' }
const asText = (reply: unknown): Block[] => [
  { type: 'thinking', thinking: '', signature: 'sig' },
  { type: 'text', text: JSON.stringify(reply) }
]
const asTool = (reply: unknown, id = 'toolu_1'): Block[] => [
  { type: 'thinking', thinking: '', signature: 'sig' },
  { type: 'tool_use', id, name: 'reply', input: reply }
]
const transport = (client: ClaudeClient, mode: 'structured' | 'tool'): TutorTransport => ({
  client,
  model: mode === 'tool' ? 'anthropic.claude-opus-5-5' : 'claude-opus-5-5',
  mode,
  serverFallbacks: mode === 'structured'
})
type Msg = { role: string; content: Block[] }

describe('Tutor on the Claude API (structured outputs)', () => {
  it('sends the screenshot, schema and cache breakpoints, and keeps the history append-only', async () => {
    const { client, calls } = fakeClient([
      asText({ problem, turn: wireTurn, recap: null }),
      asText({ problem: null, turn: wireTurn, recap: null })
    ])
    const tutor = new Tutor(transport(client, 'structured'))
    const first = await tutor.start({ image: { data: 'AAAA', mediaType: 'image/jpeg' }, history: 'python list of sets (recall_slip, 3x)' })
    expect(first.problem?.title).toBe('t')

    const req = calls[0]
    expect(req.model).toBe('claude-opus-5-5')
    expect(req.fallbacks).toBe('default')
    expect(req.tools).toBeUndefined()
    expect((req.output_config as { effort: string }).effort).toBe('medium')
    expect((req.output_config as { format: { type: string } }).format.type).toBe('json_schema')
    expect((req.system as Block[])[0].cache_control).toEqual({ type: 'ephemeral' })
    const content = (req.messages as Msg[])[0].content
    expect(content[0].type).toBe('image')
    expect(content[1].text).toContain('[NEW PROBLEM]')
    expect(content[1].text).toContain('[STUDENT HISTORY] python list of sets')
    expect(content[1].cache_control).toEqual({ type: 'ephemeral' }) // breakpoint on the newest block

    await tutor.send({ tag: 'STUDENT', text: 'x^2 e^x', notes: ['[CHECKER] matches'] })
    const msgs = calls[1].messages as Msg[]
    expect((calls[1].output_config as { effort: string }).effort).toBe('low')
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(msgs[0].content[1].cache_control).toBeUndefined() // only the newest user message is marked
    expect(msgs[1].content[0].type).toBe('thinking') // Claude's full reply is kept as-is
    expect(msgs[2].content[0].text).toBe('[CHECKER] matches\n[STUDENT] x^2 e^x')
    expect(tutor.messages[0].content).not.toHaveProperty('1.cache_control') // stored history is untouched
  })

  it('turns a refusal into a friendly error', async () => {
    const client: ClaudeClient = {
      beta: { messages: { create: async () => ({ content: [], stop_reason: 'refusal', usage: { input_tokens: 1, output_tokens: 0 } }) as never } }
    }
    await expect(new Tutor(transport(client, 'structured')).start({ text: 'p' })).rejects.toMatchObject({ code: 'refusal' })
  })
})

describe('Tutor on Bedrock (reply tool)', () => {
  it('asks for the reply tool, reads its input, and answers the tool call on the next turn', async () => {
    const { client, calls } = fakeClient([
      asTool({ problem, turn: wireTurn, recap: null }, 'toolu_A'),
      asTool({ problem: null, turn: { ...wireTurn, kind: 'hint', hintLevel: 2 }, recap: null }, 'toolu_B')
    ])
    const tutor = new Tutor(transport(client, 'tool'))
    const first = await tutor.start({ text: 'Integrate x^2 e^x' })
    expect(first.problem?.title).toBe('t')
    expect(calls[0].model).toBe('anthropic.claude-opus-5-5')
    expect(calls[0].fallbacks).toBeUndefined() // no server-side fallbacks on Bedrock
    expect((calls[0].output_config as Record<string, unknown>).format).toBeUndefined() // no structured outputs on Bedrock
    expect((calls[0].tools as Block[])[0].name).toBe('reply')
    expect(calls[0].tool_choice).toEqual({ type: 'auto' })
    expect(((calls[0].system as Block[])[0].text as string)).toContain('calling the `reply` tool')

    const second = await tutor.send({ tag: 'HINT' })
    expect(second.turn.hintLevel).toBe(2)
    const last = (calls[1].messages as Msg[])[2].content
    expect(last[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_A' })
    expect(last[1].text).toBe('[HINT]')
  })

  it('fills in left-out empty fields (visual, check, recap) instead of asking again', async () => {
    const { visual: _v, check: _c, ...turnWithoutEmpties } = wireTurn as Record<string, unknown>
    const { client, calls } = fakeClient([asTool({ problem, turn: turnWithoutEmpties }, 'toolu_1')])
    const reply = await new Tutor(transport(client, 'tool')).start({ text: 'p' })
    expect(calls).toHaveLength(1)
    expect(reply.turn.message).toBe('What do you get?')
    expect(reply.turn.visual).toBeNull()
    expect(reply.turn.check).toBeNull()
    expect(reply.recap).toBeNull()
  })

  it('asks again once when the tool input does not match the schema', async () => {
    const { client, calls } = fakeClient([
      asTool({ problem, turn: { kind: 'question' }, recap: null }, 'toolu_bad'),
      asTool({ problem, turn: wireTurn, recap: null }, 'toolu_good')
    ])
    const reply = await new Tutor(transport(client, 'tool')).start({ text: 'p' })
    expect(reply.turn.message).toBe('What do you get?')
    const retry = (calls[1].messages as Msg[])[2].content
    expect(retry[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_bad', is_error: true })
  })

  it('asks again once when the first reply has no problem', async () => {
    const { client, calls } = fakeClient([
      asTool({ problem: null, turn: wireTurn, recap: null }, 'toolu_1'),
      asTool({ problem, turn: wireTurn, recap: null }, 'toolu_2')
    ])
    const reply = await new Tutor(transport(client, 'tool')).start({ text: 'p' })
    expect(reply.problem?.title).toBe('t')
    const retry = (calls[1].messages as Msg[])[2].content
    expect(retry[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_1' })
    expect(retry[1].text).toContain('"problem" was null')
  })

  it('switches to the plain client if the refusal-fallback beta is rejected', async () => {
    const rejecting: ClaudeClient = {
      beta: {
        messages: {
          create: async () => {
            throw new Anthropic.BadRequestError(400, { error: { message: 'unsupported beta' } }, 'unsupported beta: fallback-credit-2026-07-01', new Headers())
          }
        }
      }
    }
    const { client: plain } = fakeClient([asTool({ problem, turn: wireTurn, recap: null })])
    const reply = await new Tutor({ ...transport(rejecting, 'tool'), plainClient: plain }).start({ text: 'p' })
    expect(reply.problem?.title).toBe('t')
  })
})

describe('provider detection', () => {
  it('picks Bedrock from AWS settings and the Claude API from an Anthropic key', () => {
    expect(detectProvider({ AWS_BEARER_TOKEN_BEDROCK: 'x' })).toBe('bedrock')
    expect(detectProvider({ AWS_PROFILE: 'hack' })).toBe('bedrock')
    expect(detectProvider({ ANTHROPIC_API_KEY: 'sk' })).toBe('anthropic')
    expect(detectProvider({ ANTHROPIC_API_KEY: 'sk', CLUELESS_PROVIDER: 'bedrock' })).toBe('bedrock')
    expect(detectProvider({})).toBeNull()
  })

  it('uses anthropic.-prefixed model IDs and a region on Bedrock', () => {
    expect(providerInfo({ AWS_BEARER_TOKEN_BEDROCK: 'x', AWS_REGION: 'us-west-2' })).toEqual({
      provider: 'bedrock',
      model: 'anthropic.claude-sonnet-5-5',
      fastModel: 'anthropic.claude-haiku-5-5',
      region: 'us-west-2'
    })
    expect(providerInfo({ ANTHROPIC_API_KEY: 'sk' })?.model).toBe('claude-sonnet-5-5')
    expect(providerInfo({ AWS_PROFILE: 'p', CLUELESS_MODEL: 'anthropic.claude-opus-5-5' })?.model).toBe('anthropic.claude-opus-5-5')
    expect(providerInfo({ AWS_PROFILE: 'p', CLUELESS_FAST_MODEL: 'anthropic.claude-sonnet-5-5' })?.fastModel).toBe('anthropic.claude-sonnet-5-5')
  })

  it('gives each job its own model, without server fallbacks on Haiku', () => {
    expect(createTransport({ ANTHROPIC_API_KEY: 'sk' })).toMatchObject({ model: 'claude-sonnet-5-5', serverFallbacks: true })
    expect(createTransport({ ANTHROPIC_API_KEY: 'sk' }, 'fast')).toMatchObject({ model: 'claude-haiku-5-5', serverFallbacks: false })
  })

  it('builds a Bedrock transport in tool mode', () => {
    const t = createTransport({ AWS_BEARER_TOKEN_BEDROCK: 'token', AWS_REGION: 'us-east-1' })
    expect(t?.mode).toBe('tool')
    expect(t?.serverFallbacks).toBe(false)
    expect(t?.plainClient).toBeDefined()
  })
})

describe('output_config per model', () => {
  it('leaves effort out for Haiku 4.5, and keeps the schema in structured mode', async () => {
    const { outputConfig } = await import('./provider')
    expect(outputConfig('anthropic.claude-haiku-4-5', 'low')).toBeUndefined()
    expect(outputConfig('claude-haiku-4-5', 'low', { type: 'object' })).toEqual({ format: { type: 'json_schema', schema: { type: 'object' } } })
    expect(outputConfig('anthropic.claude-sonnet-5', 'low')).toEqual({ effort: 'low' })
  })
})
