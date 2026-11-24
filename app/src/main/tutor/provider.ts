// Where Claude runs: the Claude API (ANTHROPIC_API_KEY) or Claude in Amazon Bedrock (AWS credentials).
// No Electron imports, so scripts/try-tutor.mts uses this too.
import Anthropic, { betaRefusalFallbackMiddleware } from '@anthropic-ai/sdk'
import { AnthropicBedrockMantle } from '@anthropic-ai/bedrock-sdk'
import type { ClaudeClient, TutorTransport } from './tutor'

/** 'clueless': through the Clueless server, signed in (no key on this computer). */
export type Provider = 'anthropic' | 'bedrock' | 'clueless'

type Env = Record<string, string | undefined>

/** The Clueless server, when signed in. */
export interface Hosted {
  /** Base URL that takes Claude API paths (/v1/messages). */
  baseURL: string
  /** The current access token, or null once signed out. */
  token(): Promise<string | null>
}

/** CLUELESS_PROVIDER wins; otherwise an Anthropic key means the Claude API and AWS settings mean Bedrock. */
export function detectProvider(env: Env = process.env): Provider | null {
  const forced = env.CLUELESS_PROVIDER?.trim().toLowerCase()
  if (forced === 'anthropic' || forced === 'bedrock') return forced
  if (env.ANTHROPIC_API_KEY) return 'anthropic'
  if (env.AWS_BEARER_TOKEN_BEDROCK || env.AWS_ACCESS_KEY_ID || env.AWS_PROFILE) return 'bedrock'
  return null
}

/**
 * Which job a model does. "tutor": the problem conversation (hidden solution, hints), where being
 * right matters most. "fast": small jobs where speed matters most (Ask on a highlight, setting up a
 * code run, follow-ups).
 */
export type ModelRole = 'tutor' | 'fast'

const DEFAULT_MODELS: Record<ModelRole, string> = { tutor: 'claude-sonnet-5-5', fast: 'claude-haiku-5-5' }

export function defaultModel(provider: Provider, role: ModelRole = 'tutor'): string {
  // Bedrock model IDs carry an `anthropic.` prefix.
  return provider === 'bedrock' ? `anthropic.${DEFAULT_MODELS[role]}` : DEFAULT_MODELS[role]
}

/** Server-side refusal fallbacks aren't offered for Haiku. */
export function supportsServerFallbacks(model: string): boolean {
  return !/haiku/i.test(model)
}

/** Haiku 4.5 and older models reject the effort setting: they just get the default. */
export function supportsEffort(model: string): boolean {
  return !/haiku-4|claude-3/i.test(model)
}

/** The request's output_config: effort where the model takes it, plus a JSON schema in structured mode.
 *  undefined = leave it out. */
export function outputConfig(model: string, effort: string, schema?: Record<string, unknown>): Record<string, unknown> | undefined {
  const config: Record<string, unknown> = {}
  if (supportsEffort(model)) config.effort = effort
  if (schema) config.format = { type: 'json_schema', schema }
  return Object.keys(config).length ? config : undefined
}

export function bedrockRegion(env: Env = process.env): string {
  return env.AWS_REGION || env.AWS_DEFAULT_REGION || 'us-east-1'
}

export interface ProviderInfo {
  provider: Provider
  /** The tutor model (CLUELESS_MODEL). */
  model: string
  /** The model for small jobs (CLUELESS_FAST_MODEL). */
  fastModel: string
  region: string | null
}

/** Keys on this computer win (development); otherwise the Clueless server, when signed in. */
export function providerInfo(env: Env = process.env, hosted?: Hosted | null): ProviderInfo | null {
  const provider = detectProvider(env) ?? (hosted ? 'clueless' : null)
  if (!provider) return null
  return {
    provider,
    model: env.CLUELESS_MODEL?.trim() || defaultModel(provider, 'tutor'),
    fastModel: env.CLUELESS_FAST_MODEL?.trim() || defaultModel(provider, 'fast'),
    region: provider === 'bedrock' ? bedrockRegion(env) : null
  }
}

/**
 * Build a transport for one job (`role`). Returns null when nothing is configured.
 * - Claude API: structured outputs + server-side refusal fallbacks.
 * - Bedrock: no structured outputs there, so Claude answers through a `reply` tool; refusal
 *   fallbacks run client-side through the SDK middleware (with a plain client kept as backup).
 */
export function createTransport(
  env: Env = process.env,
  role: ModelRole = 'tutor',
  hosted?: Hosted | null
): (TutorTransport & ProviderInfo) | null {
  const found = providerInfo(env, hosted)
  if (!found) return null
  const info = { ...found, model: role === 'tutor' ? found.model : found.fastModel }

  if (info.provider === 'clueless' && hosted) {
    // The same Claude API, through our server: it adds the key and keeps to the user's plan.
    const client = new Anthropic({ apiKey: null, authToken: 'per-request', baseURL: hosted.baseURL, fetch: hostedFetch(hosted) })
    return { ...info, client: client as unknown as ClaudeClient, mode: 'structured', serverFallbacks: supportsServerFallbacks(info.model) }
  }

  if (info.provider === 'anthropic') {
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })
    return { ...info, client: client as unknown as ClaudeClient, mode: 'structured', serverFallbacks: supportsServerFallbacks(info.model) }
  }

  const options = { awsRegion: info.region ?? undefined, ...(env.AWS_PROFILE ? { awsProfile: env.AWS_PROFILE } : {}) }
  const plain = new AnthropicBedrockMantle(options)
  const fallbackModel = env.CLUELESS_FALLBACK_MODEL?.trim() || 'anthropic.claude-opus-4-8'
  const client =
    fallbackModel === info.model
      ? plain
      : new AnthropicBedrockMantle({ ...options, middleware: [betaRefusalFallbackMiddleware([{ model: fallbackModel }])] })
  return {
    ...info,
    client: client as unknown as ClaudeClient,
    plainClient: plain as unknown as ClaudeClient,
    mode: 'tool',
    serverFallbacks: false
  }
}

/**
 * fetch for the Clueless server: adds the current access token to every request, since a tutor
 * conversation can outlast one token (an hour). Signed out: a 401 the SDK won't retry.
 */
export function hostedFetch(hosted: Hosted, http: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const token = await hosted.token()
    if (!token) {
      const body = { type: 'error', error: { type: 'authentication_error', message: 'Sign in to Clueless first.' } }
      return new Response(JSON.stringify(body), { status: 401, headers: { 'content-type': 'application/json' } })
    }
    const headers = new Headers(init?.headers)
    headers.set('authorization', `Bearer ${token}`)
    headers.delete('x-api-key')
    return http(input, { ...init, headers })
  }
}
