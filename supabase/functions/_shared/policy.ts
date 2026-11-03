// What the `ai` function lets through to Claude, and what it costs. Pure TypeScript with only web
// APIs (crypto.subtle), so the same file runs in the Supabase Edge Function (Deno) and in the app's
// tests (Node).
//
// The app sends an ordinary Claude Messages request. The server then:
// - checks the system prompt and output schema are Clueless's own (by hash), so our key can't be
//   used as a general-purpose Claude proxy,
// - picks the model for the job and caps the reply length,
// - works out whether the request starts a new problem or Ask (what the weekly caps count).
import { SCHEMA_HASHES, SYSTEM_HASHES, type PromptKind } from './allowlist.ts'

/** The app's two kinds of Claude work. */
export type Job = 'tutor' | 'fast'

export interface JobConfig {
  model: string
  maxTokens: number
}

/** Claude API model IDs. Change them with the function's secrets, no app release needed. */
export function jobConfig(job: Job, env: (name: string) => string | undefined): JobConfig {
  return job === 'tutor'
    ? { model: env('CLUELESS_TUTOR_MODEL') || 'claude-sonnet-5-5', maxTokens: 64000 }
    : { model: env('CLUELESS_FAST_MODEL') || 'claude-haiku-5-5', maxTokens: 64000 }
}

export const SERVER_FALLBACK_BETA = 'server-side-fallback-2026-07-01'
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

/** Haiku 4.5 and older models reject the effort setting. */
export const supportsEffort = (model: string): boolean => !/haiku-4|claude-3/i.test(model)
/** Server-side refusal fallbacks aren't offered for Haiku. */
export const supportsFallbacks = (model: string): boolean => !/haiku/i.test(model)

export type Unit = 'problem' | 'ask'

export interface Shaped {
  body: Record<string, unknown>
  betas: string[]
  kind: PromptKind
  /** A request that starts a new problem or Ask counts against the weekly cap. */
  unit: Unit | null
  stream: boolean
  model: string
}

export async function sha256(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The system prompt's text, whether sent as a string or as text blocks. */
function systemText(system: unknown): string | null {
  if (typeof system === 'string') return system
  if (!Array.isArray(system) || !system.length) return null
  const parts: string[] = []
  for (const block of system) {
    if (!isObject(block) || block.type !== 'text' || typeof block.text !== 'string') return null
    parts.push(block.text)
  }
  return parts.join('')
}

/** Check and reshape the app's request. A string is the reason it was refused. */
export async function shapeRequest(raw: unknown, betasHeader: string | null, cfg: JobConfig): Promise<Shaped | string> {
  if (!isObject(raw)) return 'The request has no body.'

  const messages = raw.messages
  if (!Array.isArray(messages) || !messages.length) return 'The request has no messages.'
  for (const m of messages) {
    if (!isObject(m) || (m.role !== 'user' && m.role !== 'assistant') || m.content === undefined) return 'A message is malformed.'
  }
  if ((messages[0] as Record<string, unknown>).role !== 'user') return 'The first message must be the student\'s.'

  const text = systemText(raw.system)
  if (text === null) return 'The request has no system prompt.'
  const kind = SYSTEM_HASHES[await sha256(text)]
  if (!kind) return 'This request isn\'t one of Clueless\'s.'

  const body: Record<string, unknown> = { model: cfg.model, system: raw.system, messages }

  const maxTokens = typeof raw.max_tokens === 'number' && Number.isInteger(raw.max_tokens) && raw.max_tokens > 0 ? raw.max_tokens : 4096
  body.max_tokens = Math.min(maxTokens, cfg.maxTokens)

  if (raw.output_config !== undefined) {
    if (!isObject(raw.output_config)) return 'output_config is malformed.'
    const out: Record<string, unknown> = {}
    const { effort, format } = raw.output_config
    if (effort !== undefined) {
      if (typeof effort !== 'string' || !EFFORTS.includes(effort)) return 'Unknown effort.'
      if (supportsEffort(cfg.model)) out.effort = effort
    }
    if (format !== undefined) {
      if (!isObject(format) || format.type !== 'json_schema' || !isObject(format.schema)) return 'output_config.format is malformed.'
      if (SCHEMA_HASHES[await sha256(JSON.stringify(format.schema))] !== kind) return 'This output format isn\'t one of Clueless\'s.'
      out.format = format
    }
    if (Object.keys(out).length) body.output_config = out
  }

  if (raw.tools !== undefined) {
    if (!Array.isArray(raw.tools)) return 'tools is malformed.'
    for (const tool of raw.tools) {
      if (!isObject(tool) || !isObject(tool.input_schema)) return 'A tool is malformed.'
      if (SCHEMA_HASHES[await sha256(JSON.stringify(tool.input_schema))] !== kind) return 'This tool isn\'t one of Clueless\'s.'
    }
    body.tools = raw.tools
    if (raw.tool_choice !== undefined) {
      if (!isObject(raw.tool_choice) || raw.tool_choice.type !== 'auto') return 'Only automatic tool choice is allowed.'
      body.tool_choice = raw.tool_choice
    }
  }

  const stream = raw.stream === true
  if (stream) body.stream = true

  const betas: string[] = []
  const askedBetas = (betasHeader ?? '').split(',').map((b) => b.trim()).filter(Boolean)
  if (raw.fallbacks === 'default' && askedBetas.includes(SERVER_FALLBACK_BETA) && supportsFallbacks(cfg.model)) {
    body.fallbacks = 'default'
    betas.push(SERVER_FALLBACK_BETA)
  }

  const unit: Unit | null = messages.length === 1 ? (kind === 'tutor' ? 'problem' : 'ask') : null
  return { body, betas, kind, unit, stream, model: cfg.model }
}

// ---------- continuing a saved session ----------

/** Where the app's [CONTINUE] message wants the hidden solution: {{hidden:<session id>}}. */
const HIDDEN_MARKER = /\{\{hidden:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\}\}/

const textsOf = (content: unknown): string[] =>
  typeof content === 'string'
    ? [content]
    : Array.isArray(content)
      ? content.flatMap((b) => (isObject(b) && b.type === 'text' && typeof b.text === 'string' ? [b.text] : []))
      : []

/** The session a [CONTINUE] request picks up, if any. Only the first message can ask. */
export function hiddenMarker(messages: unknown[]): string | null {
  const first = messages[0]
  if (!isObject(first)) return null
  for (const text of textsOf(first.content)) {
    const found = HIDDEN_MARKER.exec(text)
    if (found) return found[1]
  }
  return null
}

/** The first message with the marker replaced. The app's copy keeps the marker, so the student never sees this. */
export function fillHidden(messages: unknown[], hidden: string): unknown[] {
  const [first, ...rest] = messages
  if (!isObject(first)) return messages
  const fill = (text: string): string => text.replace(new RegExp(HIDDEN_MARKER.source, 'g'), () => hidden)
  const content =
    typeof first.content === 'string'
      ? fill(first.content)
      : Array.isArray(first.content)
        ? first.content.map((b) => (isObject(b) && b.type === 'text' && typeof b.text === 'string' ? { ...b, text: fill(b.text) } : b))
        : first.content
  return [{ ...first, content }, ...rest]
}

/** What Clueless knew about a saved problem, as the [CONTINUE] message gives it to Claude. */
export function hiddenText(solution: string, plan: unknown): string {
  const steps = Array.isArray(plan)
    ? plan.flatMap((s, i) => (isObject(s) && typeof s.text === 'string' ? [`${i + 1}. (${String(s.status)}) ${s.text}`] : []))
    : []
  return [
    `[HIDDEN SOLUTION] ${solution.trim() || '(not saved: work it out again from the problem)'}`,
    `[FULL PLAN]${steps.length ? `\n${steps.join('\n')}` : ' (not saved)'}`
  ].join('\n')
}

// ---------- the weekly caps ----------

/** What usage_check() returns for one student. */
export interface UsageState {
  activated: boolean
  banned: boolean
  plan: string
  problems_used: number
  problems_limit: number
  asks_used: number
  asks_limit: number
  dollars_used: number
  dollars_limit: number
  requests_last_minute: number
  requests_per_minute: number
  resets_at: string
}

export interface Refusal {
  status: number
  type: string
  message: string
}

const resetDay = (iso: string): string => {
  const day = new Date(iso).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' })
  return day === 'Invalid Date' ? 'next week' : day
}

const count = (n: number, what: string): string => `${n} ${what}${n === 1 ? '' : 's'}`

/** Null when the request may go ahead. */
export function refusalFor(state: UsageState | null, unit: Unit | null): Refusal | null {
  if (!state || !state.activated) {
    return { status: 403, type: 'clueless_not_activated', message: 'Finish setting up your account: enter your invite code.' }
  }
  if (state.banned) return { status: 403, type: 'clueless_banned', message: "This account can't use Clueless right now." }
  if (state.requests_last_minute >= state.requests_per_minute) {
    return { status: 429, type: 'clueless_slow_down', message: 'Lots of requests at once. Wait a minute, then try again.' }
  }
  const resets = `It resets on ${resetDay(state.resets_at)}.`
  if (Number(state.dollars_used) >= Number(state.dollars_limit)) {
    return { status: 429, type: 'clueless_weekly_limit', message: `You've reached this week's free limit. ${resets}` }
  }
  if (unit === 'problem' && state.problems_used >= state.problems_limit) {
    return { status: 429, type: 'clueless_weekly_limit', message: `You've used this week's ${count(state.problems_limit, 'free problem')}. ${resets}` }
  }
  if (unit === 'ask' && state.asks_used >= state.asks_limit) {
    return { status: 429, type: 'clueless_weekly_limit', message: `You've used this week's ${count(state.asks_limit, 'free Ask')}. ${resets}` }
  }
  return null
}

// ---------- cost ----------

export interface Usage {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

/** $ per million tokens (input, output), Anthropic list prices. Cache writes cost 1.25×, reads 0.1×. */
const PRICES: [RegExp, number, number][] = [
  [/opus-5-5/, 4, 20],
  [/opus/, 5, 25],
  [/sonnet-4/, 3, 15],
  [/sonnet/, 2, 10],
  [/haiku-5-5/, 0.1, 0.5],
  [/haiku/, 1, 5]
]

export function costOf(model: string, u: Usage): number {
  const [, pin, pout] = PRICES.find(([re]) => re.test(model)) ?? [null, 5, 25]
  const input = u.input_tokens + 1.25 * u.cache_creation_input_tokens + 0.1 * u.cache_read_input_tokens
  return (input * pin + u.output_tokens * pout) / 1e6
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

export function usageFrom(raw: unknown): Usage {
  const u = isObject(raw) ? raw : {}
  return {
    input_tokens: num(u.input_tokens),
    output_tokens: num(u.output_tokens),
    cache_read_input_tokens: num(u.cache_read_input_tokens),
    cache_creation_input_tokens: num(u.cache_creation_input_tokens)
  }
}

/** Reads a streamed reply (server-sent events) as it passes through: the model and the token counts. */
export class StreamUsage {
  model: string | null = null
  usage: Usage = usageFrom(null)
  private buffer = ''
  private decoder = new TextDecoder()

  push(chunk: Uint8Array): void {
    this.buffer += this.decoder.decode(chunk, { stream: true })
    let end: number
    while ((end = this.buffer.indexOf('\n\n')) >= 0) {
      const event = this.buffer.slice(0, end)
      this.buffer = this.buffer.slice(end + 2)
      for (const line of event.split('\n')) {
        if (!line.startsWith('data:')) continue
        let data: unknown
        try {
          data = JSON.parse(line.slice(5).trim())
        } catch {
          continue
        }
        if (!isObject(data)) continue
        if (data.type === 'message_start' && isObject(data.message)) {
          if (typeof data.message.model === 'string') this.model = data.message.model
          const start = usageFrom(data.message.usage)
          this.usage = { ...this.usage, ...start, output_tokens: Math.max(this.usage.output_tokens, start.output_tokens) }
        } else if (data.type === 'message_delta' && isObject(data.usage)) {
          // message_delta carries the running output count (and may repeat the input counts)
          const delta = usageFrom(data.usage)
          this.usage = {
            input_tokens: delta.input_tokens || this.usage.input_tokens,
            output_tokens: Math.max(this.usage.output_tokens, delta.output_tokens),
            cache_read_input_tokens: delta.cache_read_input_tokens || this.usage.cache_read_input_tokens,
            cache_creation_input_tokens: delta.cache_creation_input_tokens || this.usage.cache_creation_input_tokens
          }
        }
      }
    }
  }
}
