// Tutor engine: one Tutor = one problem session with Claude.
// No Electron imports here, so scripts/try-tutor.mts and the tests can use it directly.
// Where Claude runs (Claude API or Bedrock) is decided in provider.ts.
import Anthropic, { BetaFallbackState } from '@anthropic-ai/sdk'
import type {
  BetaContentBlockParam,
  BetaMessage,
  BetaMessageParam
} from '@anthropic-ai/sdk/resources/beta/messages/messages'
import { z } from 'zod'
import { WireReply } from '../../shared/schema'
import type { TutorReplyT } from '../../shared/contracts'
import { SYSTEM_PROMPT } from './prompt'
import { outputConfig } from './provider'

export type Tag =
  | 'STUDENT'
  | 'HINT'
  | 'WHAT NEXT'
  | 'RECALL'
  | 'CHECK MY WORK'
  | 'STUCK'
  | 'REVEAL'
  | 'RECAP'
  | 'STEP STUCK'
  | 'STEP REVISIT'
  | 'STEP CLAIM'
  | 'ANIMATE'
  | 'EXAMPLE'

export interface ImageInput {
  data: string // base64, no data: prefix
  mediaType: 'image/jpeg' | 'image/png'
}

export interface StartInput {
  image?: ImageInput
  text?: string // the student's typed question, or the problem as text
  history?: string // [STUDENT HISTORY] summary
}

export interface SendInput {
  tag: Tag
  text?: string
  image?: ImageInput
  crop?: ImageInput // a close-up of the area the student selected (sent after `image`)
  notes?: string[] // extra lines such as [CHECKER] or [SUBJECT]
}

/** What the session controller needs from a tutor (tests swap in a fake). */
export interface TutorLike {
  start(input: StartInput): Promise<TutorReplyT>
  send(input: SendInput): Promise<TutorReplyT>
}

export class TutorError extends Error {
  constructor(
    message: string,
    readonly code: 'refusal' | 'max_tokens' | 'bad_output' | 'api'
  ) {
    super(message)
  }
}

/** The reply schema as plain JSON Schema. Structured outputs accept anyOf but not oneOf. */
export const replySchema = (() => {
  const schema = JSON.parse(JSON.stringify(z.toJSONSchema(WireReply)).replaceAll('"oneOf"', '"anyOf"'))
  delete schema.$schema
  return schema as Record<string, unknown>
})()

/** The slice of an Anthropic or AnthropicBedrockMantle client the tutor uses. */
export interface ClaudeClient {
  beta: {
    messages: {
      create(params: Record<string, unknown>, options?: { fallbackState?: BetaFallbackState }): Promise<BetaMessage>
    }
  }
}

export interface TutorTransport {
  client: ClaudeClient
  /** Same endpoint without the client-side refusal middleware, used if the middleware's beta is rejected. */
  plainClient?: ClaudeClient
  model: string
  /** 'structured': output_config.format (Claude API). 'tool': a `reply` tool (Bedrock has no structured outputs). */
  mode: 'structured' | 'tool'
  /** Server-side refusal fallbacks (Claude API only). */
  serverFallbacks: boolean
}

/** Bedrock path: Claude answers by calling this tool; its input is the reply. */
const REPLY_TOOL = {
  name: 'reply',
  description: 'Send your reply to the student. Call this exactly once per turn, with every field filled.',
  input_schema: replySchema
}

const TOOL_MODE_RULES =
  '\n\n# How to answer\nAlways answer by calling the `reply` tool exactly once, with every field filled. Write nothing outside the tool call.'

export class Tutor implements TutorLike {
  /** The whole conversation. Append-only: earlier turns are never edited. */
  readonly messages: BetaMessageParam[] = []
  private readonly fallbackState = new BetaFallbackState() // pins this conversation to a fallback model after a refusal
  private pendingToolUseId: string | null = null // tool mode: the next user message must answer this tool call
  private client: ClaudeClient
  private useServerFallbacks: boolean

  constructor(
    private readonly transport: TutorTransport,
    private readonly log: (line: string) => void = () => {}
  ) {
    this.client = transport.client
    this.useServerFallbacks = transport.serverFallbacks
  }

  async start(input: StartInput): Promise<TutorReplyT> {
    const lines = ['[NEW PROBLEM]']
    if (input.image) lines.push("The screenshot shows the student's screen. Find the problem they're working on.")
    if (input.text) lines.push(`Student's note: ${input.text}`)
    if (input.history) lines.push(`[STUDENT HISTORY] ${input.history}`)
    // The first call is the hard one (understand the problem, write the hidden solution), so it
    // thinks harder. Later turns are short and run at low effort for speed.
    const reply = await this.request({ text: lines.join('\n'), images: input.image ? [input.image] : [] }, 'medium')
    if (reply.problem) return reply
    // Without "problem" the app has no subject, title or hidden solution: ask once more.
    this.log('tutor: first reply had no problem, asking again')
    return this.request(
      { text: '[FORMAT] "problem" was null. Reply to [NEW PROBLEM] again, with "problem" filled in.' },
      'medium'
    )
  }

  async send(input: SendInput): Promise<TutorReplyT> {
    const lines = [...(input.notes ?? [])]
    lines.push(input.text ? `[${input.tag}] ${input.text}` : `[${input.tag}]`)
    const images = [input.image, input.crop].filter((i): i is ImageInput => Boolean(i))
    return this.request({ text: lines.join('\n'), images }, 'low')
  }

  private userMessage(turn: Turn): BetaMessageParam {
    const content: BetaContentBlockParam[] = []
    if (this.pendingToolUseId) {
      content.push({
        type: 'tool_result',
        tool_use_id: this.pendingToolUseId,
        content: turn.toolError ?? 'Shown to the student.',
        ...(turn.toolError ? { is_error: true } : {})
      })
    }
    for (const image of turn.images ?? []) {
      content.push({ type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } })
    }
    if (turn.text) content.push({ type: 'text', text: turn.text })
    return { role: 'user', content }
  }

  private async request(
    turn: Turn,
    effort: 'low' | 'medium',
    retries = 1
  ): Promise<TutorReplyT> {
    this.messages.push(this.userMessage(turn))
    const started = Date.now()
    let response: BetaMessage
    try {
      response = await this.create(effort)
    } catch (err) {
      // Don't leave a dangling user turn: the conversation must alternate user/assistant.
      this.messages.pop()
      throw err instanceof TutorError ? err : new TutorError(errorMessage(err), 'api')
    }

    // Keep Claude's whole reply (thinking blocks included) so the history stays append-only.
    this.pendingToolUseId = null
    this.messages.push({ role: 'assistant', content: response.content as unknown as BetaContentBlockParam[] })
    const usage = response.usage
    this.log(
      `tutor: ${effort} ${Date.now() - started}ms in=${usage.input_tokens} cached=${usage.cache_read_input_tokens ?? 0} out=${usage.output_tokens}`
    )

    if (response.stop_reason === 'refusal') {
      throw new TutorError("Clueless can't help with this one.", 'refusal')
    }
    if (response.stop_reason === 'max_tokens') {
      throw new TutorError('The reply was cut off. Try again.', 'max_tokens')
    }

    if (this.transport.mode === 'structured') {
      return parseReply(response.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join(''))
    }

    // Tool mode: the reply is the `reply` tool's input. One retry if it's missing or malformed.
    const call = response.content.find((b) => b.type === 'tool_use' && b.name === REPLY_TOOL.name)
    if (call && call.type === 'tool_use') {
      this.pendingToolUseId = call.id
      const parsed = WireReply.safeParse(withEmptyDefaults(call.input))
      if (parsed.success) return fromWire(parsed.data)
      if (retries > 0) {
        const problems = parsed.error.issues.slice(0, 6).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
        this.log(`tutor: reply didn't match the schema (${problems}), asking again`)
        return this.request(
          { text: '', toolError: `That reply didn't match the schema (${problems}). Call reply again with every field filled.` },
          effort,
          retries - 1
        )
      }
    } else if (retries > 0) {
      return this.request({ text: '[FORMAT] Answer by calling the reply tool.' }, effort, retries - 1)
    }
    throw new TutorError('Clueless got an unexpected reply. Try again.', 'bad_output')
  }

  private create(effort: 'low' | 'medium'): Promise<BetaMessage> {
    const params: Record<string, unknown> = {
      model: this.transport.model,
      max_tokens: 16000,
      // Explicit cache breakpoints (work on the Claude API and Bedrock): the stable system prompt
      // (plus tools) and the newest user message, so each follow-up re-reads the screenshot from cache.
      system: [
        {
          type: 'text',
          text: this.transport.mode === 'tool' ? SYSTEM_PROMPT + TOOL_MODE_RULES : SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' }
        }
      ],
      messages: withCacheBreakpoint(this.messages),
      output_config: outputConfig(this.transport.model, effort, this.transport.mode === 'structured' ? replySchema : undefined)
    }
    if (!params.output_config) delete params.output_config
    if (this.transport.mode === 'tool') {
      params.tools = [REPLY_TOOL]
      params.tool_choice = { type: 'auto' } // forced tool use isn't allowed on Opus 5.5; the prompt asks for it
    }
    return this.send_(params)
  }

  private async send_(params: Record<string, unknown>): Promise<BetaMessage> {
    const options = { fallbackState: this.fallbackState }
    try {
      if (this.useServerFallbacks) {
        // If a safety classifier declines, the API re-runs the request on a fallback model.
        return await this.client.beta.messages.create(
          { ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' },
          options
        )
      }
      return await this.client.beta.messages.create(params, options)
    } catch (err) {
      if (!(err instanceof Anthropic.BadRequestError) || !/fallback|beta|credit/i.test(err.message)) throw err
      // The refusal-fallback feature isn't available here: carry on without it.
      if (this.useServerFallbacks) {
        this.log('tutor: server-side fallbacks not available, continuing without them')
        this.useServerFallbacks = false
      } else if (this.transport.plainClient && this.client !== this.transport.plainClient) {
        this.log('tutor: refusal-fallback middleware not available here, continuing without it')
        this.client = this.transport.plainClient
      } else {
        throw err
      }
      return this.send_(params)
    }
  }
}

/** One user message: text, then images in order, or a tool error (Bedrock retry). */
interface Turn {
  text: string
  images?: ImageInput[]
  toolError?: string
}

/**
 * Tool mode has no schema enforcement, and Claude sometimes leaves out fields that would only be
 * empty anyway (no visual, no answer check, no recap). Fill those in instead of spending a whole
 * extra request asking again; anything that carries content (message, kind, plan...) still has
 * to be there.
 */
export function withEmptyDefaults(input: unknown): unknown {
  if (!input || typeof input !== 'object') return input
  const reply = input as Record<string, unknown>
  const turn = reply.turn && typeof reply.turn === 'object' ? (reply.turn as Record<string, unknown>) : null
  return {
    ...reply,
    problem: reply.problem ?? null,
    recap: reply.recap ?? null,
    turn: turn && {
      hintLevel: 0,
      verdict: 'none',
      gap: { type: 'none', topic: '' },
      expects: 'text',
      choices: [],
      ...turn,
      visual: { caption: '', frames: [], narration: [], ...(turn.visual as object | undefined) },
      check: turn.check ?? { kind: 'none', reference: '', variable: '', unit: '' }
    }
  }
}

/** A copy of the history with a cache breakpoint on the last block of the newest user message. */
function withCacheBreakpoint(messages: BetaMessageParam[]): BetaMessageParam[] {
  const last = messages.length - 1
  if (last < 0 || messages[last].role !== 'user' || typeof messages[last].content === 'string') return messages
  const blocks = messages[last].content as BetaContentBlockParam[]
  if (!blocks.length) return messages
  const marked = [...blocks]
  marked[marked.length - 1] = { ...marked[marked.length - 1], cache_control: { type: 'ephemeral' } } as BetaContentBlockParam
  return [...messages.slice(0, last), { role: 'user', content: marked }]
}

export function parseReply(text: string): TutorReplyT {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new TutorError('Clueless got a garbled reply. Try again.', 'bad_output')
  }
  const parsed = WireReply.safeParse(json)
  if (!parsed.success) throw new TutorError('Clueless got an unexpected reply. Try again.', 'bad_output')
  return fromWire(parsed.data)
}

/** Wire format ("" / -1 / "none" placeholders) -> app types (null). */
export function fromWire(w: z.infer<typeof WireReply>): TutorReplyT {
  const t = w.turn
  return {
    problem: w.problem && { ...w.problem, language: w.problem.language.trim() || null },
    turn: {
      kind: t.kind,
      message: t.message,
      hintLevel: Math.max(0, Math.min(5, Math.round(t.hintLevel))),
      verdict: t.verdict,
      plan: t.plan,
      gap: t.gap.type === 'none' ? null : { type: t.gap.type, topic: t.gap.topic },
      expects: t.expects,
      choices: t.choices,
      visual: t.visual.frames.length ? t.visual : null,
      check:
        t.check.kind === 'none' || !t.check.reference.trim()
          ? null
          : {
              kind: t.check.kind,
              reference: t.check.reference,
              variable: t.check.variable.trim() || null,
              unit: t.check.unit.trim() || null
            }
    },
    recap: w.recap && { ...w.recap, similarProblem: w.recap.similarProblem.trim() || null }
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return 'Claude rejected the credentials. Check ANTHROPIC_API_KEY, or your AWS credentials and Bedrock model access.'
  }
  if (err instanceof Anthropic.NotFoundError) return `Claude API error (404): ${err.message}. Is this model enabled in your account/region?`
  if (err instanceof Anthropic.RateLimitError) return 'Claude is rate-limiting us. Wait a moment and try again.'
  if (err instanceof Anthropic.APIConnectionError) return "Can't reach Claude. Check your internet connection."
  if (err instanceof Anthropic.APIError) return `Claude API error (${err.status}): ${err.message}`
  return err instanceof Error ? err.message : String(err)
}
