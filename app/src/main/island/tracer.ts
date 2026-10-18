// Ask or Animate on highlighted text: one conversation per highlight.
// - Ask: the fast model (Haiku) explains it.
// - Animate, Python: the fast model picks an input and how to call the code, and the app runs
//   it for real (src/main/run) to get every step. If the run can't start, Claude writes the trace.
// - Animate, other languages: the tutor model (Sonnet) writes the step-by-step trace.
// - Animate, not code: the tutor model writes a concept lesson (a picture and a line per step).
// No Electron imports, so scripts/try-trace.mts and the tests use it directly.
import Anthropic, { BetaFallbackState } from '@anthropic-ai/sdk'
import type {
  BetaContentBlockParam,
  BetaMessage,
  BetaMessageParam
} from '@anthropic-ai/sdk/resources/beta/messages/messages'
import { z } from 'zod'
import { fromTraceWire, normalizeSnippet, numberLines, TraceWire, type TraceReply, type TraceWireT } from '../../shared/trace'
import { errorMessage, TutorError, type ImageInput, type TutorTransport } from '../tutor/tutor'
import { outputConfig } from '../tutor/provider'
import type { AskInput, TracerLike } from '../../shared/islandController'
import { looksLikePython, toCodeTrace, type PythonRunner } from '../run/python'
import { TRACE_PROMPT } from './prompt'

/** Room for long traces; streaming keeps a long answer from hitting an HTTP timeout. */
const MAX_TOKENS = 64000

/** A trace that takes longer than this is given up on, so the island never waits forever.
 *  (Measured on bubble sort: medium and high ~16 s, max ~88 s.) */
export const TRACE_TIMEOUT_MS = 150_000

export const traceSchema = (() => {
  const schema = JSON.parse(JSON.stringify(z.toJSONSchema(TraceWire)).replaceAll('"oneOf"', '"anyOf"'))
  delete schema.$schema
  return schema as Record<string, unknown>
})()

const REPLY_TOOL = {
  name: 'reply',
  description: 'Send your reply to the student. Call this exactly once, with every field filled.',
  input_schema: traceSchema
}

const TOOL_MODE_RULES =
  '\n\n# How to answer\nAlways answer by calling the `reply` tool exactly once, with every field filled. Write nothing outside the tool call.'

/** The streaming slice of an Anthropic or AnthropicBedrockMantle client. */
interface StreamingClient {
  beta: {
    messages: {
      stream(
        params: Record<string, unknown>,
        options?: { fallbackState?: BetaFallbackState; signal?: AbortSignal }
      ): { finalMessage(): Promise<BetaMessage> }
    }
  }
}

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

interface Turn {
  text: string
  images?: ImageInput[]
  toolError?: string
}

/** One conversation with one model: the wire replies, Bedrock tool mode and fallbacks included. */
class Conversation {
  /** Append-only. */
  readonly messages: BetaMessageParam[] = []
  private readonly fallbackState = new BetaFallbackState()
  private pendingToolUseId: string | null = null
  private client: StreamingClient
  private useServerFallbacks: boolean

  constructor(
    readonly transport: TutorTransport,
    private readonly log: (line: string) => void
  ) {
    this.client = transport.client as unknown as StreamingClient
    this.useServerFallbacks = transport.serverFallbacks
  }

  async request(turn: Turn, effort: Effort, retries = 1): Promise<TraceWireT> {
    this.messages.push(this.userMessage(turn))
    const started = Date.now()
    let response: BetaMessage
    try {
      response = await this.send(effort)
    } catch (err) {
      this.messages.pop() // keep the conversation alternating user/assistant
      if (err instanceof TutorError) throw err
      if (err instanceof Anthropic.APIUserAbortError) {
        throw new TutorError(`That took longer than ${TRACE_TIMEOUT_MS / 1000} s, so I stopped. Try highlighting less code.`, 'api')
      }
      throw new TutorError(errorMessage(err), 'api')
    }

    this.pendingToolUseId = null
    this.messages.push({ role: 'assistant', content: response.content as unknown as BetaContentBlockParam[] })
    const u = response.usage
    this.log(`ask ${this.transport.model}: ${effort} ${Date.now() - started}ms in=${u.input_tokens} cached=${u.cache_read_input_tokens ?? 0} out=${u.output_tokens}`)

    if (response.stop_reason === 'refusal') throw new TutorError("Clueless can't help with this one.", 'refusal')
    if (response.stop_reason === 'max_tokens') throw new TutorError('The answer was too long and got cut off. Try a shorter highlight.', 'max_tokens')

    if (this.transport.mode === 'structured') {
      const text = response.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('')
      let json: unknown
      try {
        json = JSON.parse(text)
      } catch {
        throw new TutorError('Clueless got a garbled reply. Try again.', 'bad_output')
      }
      const parsed = TraceWire.safeParse(json)
      if (!parsed.success) throw new TutorError('Clueless got an unexpected reply. Try again.', 'bad_output')
      return parsed.data
    }

    // Bedrock: the reply is the `reply` tool's input. One retry if it's missing or malformed.
    const call = response.content.find((b) => b.type === 'tool_use' && b.name === REPLY_TOOL.name)
    if (call && call.type === 'tool_use') {
      this.pendingToolUseId = call.id
      const parsed = TraceWire.safeParse(call.input)
      if (parsed.success) return parsed.data
      if (retries > 0) {
        const problems = parsed.error.issues.slice(0, 6).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
        this.log(`ask: reply didn't match the schema (${problems}), asking again`)
        return this.request({ text: '', toolError: `That reply didn't match the schema (${problems}). Call reply again with every field filled.` }, effort, retries - 1)
      }
    } else if (retries > 0) {
      return this.request({ text: '[FORMAT] Answer by calling the reply tool.' }, effort, retries - 1)
    }
    throw new TutorError('Clueless got an unexpected reply. Try again.', 'bad_output')
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

  private async send(effort: Effort): Promise<BetaMessage> {
    const structured = this.transport.mode === 'structured'
    const params: Record<string, unknown> = {
      model: this.transport.model,
      max_tokens: MAX_TOKENS,
      system: [{ type: 'text', text: structured ? TRACE_PROMPT : TRACE_PROMPT + TOOL_MODE_RULES, cache_control: { type: 'ephemeral' } }],
      messages: this.messages,
      output_config: outputConfig(this.transport.model, effort, structured ? traceSchema : undefined)
    }
    if (!params.output_config) delete params.output_config
    if (!structured) {
      params.tools = [REPLY_TOOL]
      params.tool_choice = { type: 'auto' } // forced tool use isn't allowed on Opus 5.5; the prompt asks for it
    }
    return this.stream(params)
  }

  private async stream(params: Record<string, unknown>): Promise<BetaMessage> {
    const options = { fallbackState: this.fallbackState, signal: AbortSignal.timeout(TRACE_TIMEOUT_MS) }
    try {
      if (this.useServerFallbacks) {
        // If a safety classifier declines, the API re-runs the request on a fallback model.
        return await this.client.beta.messages
          .stream({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }, options)
          .finalMessage()
      }
      return await this.client.beta.messages.stream(params, options).finalMessage()
    } catch (err) {
      if (!(err instanceof Anthropic.BadRequestError) || !/fallback|beta|credit/i.test(err.message)) throw err
      if (this.useServerFallbacks) {
        this.log('ask: server-side fallbacks not available, continuing without them')
        this.useServerFallbacks = false
      } else if (this.transport.plainClient && this.client !== (this.transport.plainClient as unknown)) {
        this.log('ask: refusal-fallback middleware not available here, continuing without it')
        this.client = this.transport.plainClient as unknown as StreamingClient
      } else {
        throw err
      }
      return this.stream(params)
    }
  }
}

export interface TracerModels {
  /** Writes traces for languages the app can't run. */
  tutor: TutorTransport
  /** Explains highlights, sets up Python runs, answers follow-ups. */
  fast: TutorTransport
}

export class Tracer implements TracerLike {
  private conv: Conversation | null = null
  private code = ''

  constructor(
    private readonly models: TracerModels,
    /** Runs Python highlights; null = Claude writes every trace. */
    private readonly runner: PythonRunner | null,
    private readonly log: (line: string) => void = () => {},
    /** Force one effort level for Claude-written traces (tests, `npm run trace --effort`); undefined = pick by code size. */
    private readonly effortOverride: Effort | undefined = envEffort()
  ) {}

  /** The conversation so far (for tests and scripts). */
  get messages(): BetaMessageParam[] {
    return this.conv?.messages ?? []
  }

  async ask(input: AskInput): Promise<TraceReply> {
    this.code = normalizeSnippet(input.snippet)
    const highlight = `The student highlighted this:\n${numberLines(this.code)}`
    const images = input.image ? [input.image] : []

    if (input.animate && this.runner && looksLikePython(this.code)) {
      this.conv = new Conversation(this.models.fast, this.log)
      const wire = await this.conv.request({ text: `[ANIMATE ON] [RUN]\n${highlight}`, images }, 'low')
      const ran = await this.runPlan(wire)
      if (ran) return ran
      this.log('ask: the run did not work, Claude writes the trace instead')
      return this.writtenTrace(highlight, images)
    }
    if (input.animate) return this.writtenTrace(highlight, images)

    this.conv = new Conversation(this.models.fast, this.log)
    return fromTraceWire(await this.conv.request({ text: `[ANIMATE OFF]\n${highlight}`, images }, 'medium'), this.code)
  }

  async followUp(text: string, animate: boolean, image: ImageInput | null = null): Promise<TraceReply> {
    const conv = this.conv
    if (!conv) throw new TutorError('Ask about a highlight first.', 'api')
    const images = image ? [image] : []
    if (animate && this.runner && looksLikePython(this.code)) {
      const wire = await conv.request({ text: `[ANIMATE ON] [RUN] [FOLLOW-UP] ${text}`, images }, 'low')
      const wantsRun = Boolean(wire.run.setup.trim() || wire.run.call.trim())
      return (wantsRun && (await this.runPlan(wire))) || { message: wire.message.trim(), trace: null, lesson: null }
    }
    const effort = animate && conv.transport === this.models.tutor ? this.effortFor(this.code) : 'low'
    return fromTraceWire(await conv.request({ text: `${animate ? '[ANIMATE ON]' : '[ANIMATE OFF]'} [FOLLOW-UP] ${text}`, images }, effort), this.code)
  }

  /** The tutor model writes the steps itself (any language, or when a run fails). */
  private async writtenTrace(highlight: string, images: ImageInput[]): Promise<TraceReply> {
    this.conv = new Conversation(this.models.tutor, this.log)
    return fromTraceWire(await this.conv.request({ text: `[ANIMATE ON]\n${highlight}`, images }, this.effortFor(this.code)), this.code)
  }

  /** Run the code with the model's inputs. One retry with the error if it won't start; null if it still won't. */
  private async runPlan(wire: TraceWireT, retries = 1): Promise<TraceReply | null> {
    if (!this.runner || !this.conv || (wire.language && wire.language.toLowerCase() !== 'python')) return null
    let why: string
    try {
      const run = await this.runner.trace(this.code, wire.run)
      const trace = run.setupError ? null : toCodeTrace(run, this.code)
      if (trace) {
        const notes = [run.stopped && `stopped at the ${run.stopped} limit`, run.error].filter(Boolean).join(', ')
        this.log(`run: ${trace.steps.length} steps${notes ? ` (${notes})` : ''}`)
        return { message: wire.message.trim(), trace, lesson: null }
      }
      why = run.setupError || run.error || 'nothing in the highlighted code ran'
    } catch (err) {
      this.log(`run: ${(err as Error).message}`)
      return null
    }
    this.log(`run: failed (${why})`)
    if (retries <= 0) return null
    return this.runPlan(await this.conv.request({ text: `[RUN FAILED] ${why}` }, 'low'), retries - 1)
  }

  private effortFor(code: string): Effort {
    return this.effortOverride ?? traceEffort(code)
  }
}

const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

/** CLUELESS_TRACE_EFFORT=max (in .env) forces one effort level for every animation. */
function envEffort(env: Record<string, string | undefined> = process.env): Effort | undefined {
  const value = env.CLUELESS_TRACE_EFFORT?.trim().toLowerCase()
  return EFFORTS.find((e) => e === value)
}

/** Picked from the size of the highlight. Measured on bubble sort: medium and high both took ~16 s and
 *  traced it correctly; max took ~88 s for a few extra "loop finished" steps. So max is opt-in only. */
export function traceEffort(code: string): Effort {
  const lines = code.split(String.fromCharCode(10)).filter((l) => l.trim()).length
  return lines <= 8 ? 'medium' : 'high'
}
