// Where Claude runs:
// - clueless: through Clueless's server with the student's sign-in (no keys on the laptop),
// - anthropic: the Claude API with a developer's ANTHROPIC_API_KEY,
// - bedrock: Claude in Amazon Bedrock with a developer's AWS credentials.
// No Electron imports, so scripts/try-tutor.mts uses this too.
import Anthropic, { betaRefusalFallbackMiddleware } from '@anthropic-ai/sdk'
import { AnthropicBedrockMantle } from '@anthropic-ai/bedrock-sdk'
import { accountServer, type AccountServer } from '../account/project'
import type { ClaudeClient, TutorTransport } from './tutor'

export type Provider = 'clueless' | 'anthropic' | 'bedrock'

type Env = Record<string, string | undefined>

/** CLUELESS_PROVIDER wins; then a developer's own keys in .env; then the Clueless account server. */
export function detectProvider(env: Env = process.env): Provider | null {
  const forced = env.CLUELESS_PROVIDER?.trim().toLowerCase()
  if (forced === 'clueless' || forced === 'anthropic' || forced === 'bedrock') return forced
  if (env.ANTHROPIC_API_KEY) return 'anthropic'
  if (env.AWS_BEARER_TOKEN_BEDROCK || env.AWS_ACCESS_KEY_ID || env.AWS_PROFILE) return 'bedrock'
  if (accountServer(env)) return 'clueless'
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

export function providerInfo(env: Env = process.env): ProviderInfo | null {
  const provider = detectProvider(env)
  if (!provider) return null
  if (provider === 'clueless') {
    // The server picks the real models; these only shape the request (effort, fallbacks).
    return { provider, model: defaultModel(provider, 'tutor'), fastModel: defaultModel(provider, 'fast'), region: null }
  }
  return {
    provider,
    model: env.CLUELESS_MODEL?.trim() || defaultModel(provider, 'tutor'),
    fastModel: env.CLUELESS_FAST_MODEL?.trim() || defaultModel(provider, 'fast'),
    region: provider === 'bedrock' ? bedrockRegion(env) : null
  }
}

/** The student's current access token, or null when signed out. */
export type AccessToken = () => Promise<string | null>

/**
 * The Anthropic SDK pointed at Clueless's `ai` function. The student's access token replaces the API
 * key, and `x-clueless-job` tells the server which model to use. A signed-out student gets the
 * server's own "sign in" error without a request being made.
 */
export function cluelessClient(server: AccountServer, role: ModelRole, accessToken: AccessToken, fetchImpl: typeof fetch = fetch): Anthropic {
  return new Anthropic({
    apiKey: null, // never a key from the environment
    authToken: 'set-per-request', // replaced below; also stops the SDK looking for local credentials
    baseURL: `${server.url}/functions/v1/ai`,
    defaultHeaders: { 'x-clueless-job': role, apikey: server.publishableKey },
    fetch: async (url, init) => {
      const token = await accessToken()
      if (!token) {
        return new Response(JSON.stringify({ type: 'error', error: { type: 'clueless_signed_out', message: 'Sign in to Clueless first.' } }), {
          status: 401,
          headers: { 'content-type': 'application/json', 'x-should-retry': 'false' }
        })
      }
      const headers = new Headers(init?.headers)
      headers.set('authorization', `Bearer ${token}`)
      return fetchImpl(url, { ...init, headers })
    }
  })
}

/**
 * Build a transport for one job (`role`). Returns null when nothing is configured.
 * - Clueless server: the Claude API's structured outputs and fallbacks, through our server.
 * - Claude API: structured outputs + server-side refusal fallbacks.
 * - Bedrock: no structured outputs there, so Claude answers through a `reply` tool; refusal
 *   fallbacks run client-side through the SDK middleware (with a plain client kept as backup).
 */
export function createTransport(
  env: Env = process.env,
  role: ModelRole = 'tutor',
  /** Needed for the Clueless server: the signed-in student's token. */
  accessToken?: AccessToken
): (TutorTransport & ProviderInfo) | null {
  const found = providerInfo(env)
  if (!found) return null
  const info = { ...found, model: role === 'tutor' ? found.model : found.fastModel }

  if (info.provider === 'clueless') {
    const server = accountServer(env)
    if (!server || !accessToken) return null
    const client = cluelessClient(server, role, accessToken)
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
