import Anthropic from '@anthropic-ai/sdk'
import { describe, expect, it } from 'vitest'
import { createTransport, hostedFetch, providerInfo, type Hosted } from './provider'
import { errorMessage } from './tutor'

const hosted: Hosted = { baseURL: 'https://x.supabase.co/functions/v1/api', token: async () => 'jwt-1' }

describe('the Clueless server as a provider', () => {
  it('is used only when there are no keys in the env', () => {
    expect(providerInfo({}, hosted)).toMatchObject({ provider: 'clueless', model: 'claude-sonnet-5-5', fastModel: 'claude-haiku-5-5' })
    expect(providerInfo({ ANTHROPIC_API_KEY: 'k' }, hosted)?.provider).toBe('anthropic')
    expect(providerInfo({}, null)).toBeNull()
    expect(createTransport({}, 'fast', hosted)).toMatchObject({ provider: 'clueless', model: 'claude-haiku-5-5', mode: 'structured', serverFallbacks: false })
    expect(createTransport({}, 'tutor', hosted)).toMatchObject({ mode: 'structured', serverFallbacks: true })
  })

  it('sends each request with the current token and no API key', async () => {
    const seen: Headers[] = []
    let n = 0
    const tokens = { ...hosted, token: async () => `jwt-${++n}` }
    const http = (async (_url: string | URL | Request, init?: RequestInit) => {
      seen.push(new Headers(init?.headers))
      return new Response('{}', { status: 200 })
    }) as typeof fetch
    const f = hostedFetch(tokens, http)
    await f('https://x/v1/messages', { headers: { 'x-api-key': 'leak', authorization: 'Bearer per-request' } })
    await f('https://x/v1/messages', {})
    expect(seen.map((h) => h.get('authorization'))).toEqual(['Bearer jwt-1', 'Bearer jwt-2'])
    expect(seen[0].get('x-api-key')).toBeNull()
  })

  it('signed out: a 401 that says to sign in, without a network call', async () => {
    let called = false
    const http = (async () => {
      called = true
      return new Response('{}')
    }) as typeof fetch
    const res = await hostedFetch({ ...hosted, token: async () => null }, http)('https://x/v1/messages', {})
    expect(res.status).toBe(401)
    expect(called).toBe(false)
  })

  it('the SDK talks to the server path, and its errors read well', async () => {
    const urls: string[] = []
    const limit = { type: 'error', error: { type: 'billing_error', message: "You've used this month's free Clueless." } }
    const http = (async (url: string | URL | Request) => {
      urls.push(String(url))
      return new Response(JSON.stringify(limit), { status: 402, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    const client = new Anthropic({ apiKey: null, authToken: 'per-request', baseURL: hosted.baseURL, fetch: hostedFetch(hosted, http), maxRetries: 0 })
    const err = await client.beta.messages.create({ model: 'claude-haiku-5-5', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }).catch((e) => e)
    expect(urls[0]).toBe('https://x.supabase.co/functions/v1/api/v1/messages?beta=true')
    expect(errorMessage(err)).toBe("You've used this month's free Clueless.")
  })
})

describe('errorMessage and the Clueless server', () => {
  it("shows the server's own messages, and leaves Claude's alone", () => {
    const err = (status: number, message: string) =>
      Anthropic.APIError.generate(status, { type: 'error', error: { type: 'api_error', message } }, undefined, new Headers())
    expect(errorMessage(err(502, "Clueless can't reach Claude right now. Try again later."))).toBe("Clueless can't reach Claude right now. Try again later.")
    expect(errorMessage(err(401, 'Sign in to Clueless again.'))).toBe('Sign in to Clueless again.')
    expect(errorMessage(err(401, 'invalid x-api-key'))).toMatch(/rejected the credentials/)
  })
})
