// The `voice` server function (supabase/functions/_shared/voice.ts) with a fake database, Deepgram and ElevenLabs.
import { describe, expect, it } from 'vitest'
import type { UsageEvent } from '../../../../supabase/functions/_shared/handler.ts'
import type { UsageState } from '../../../../supabase/functions/_shared/policy.ts'
import { handleVoice, type VoiceDeps } from '../../../../supabase/functions/_shared/voice.ts'

const state = (over: Partial<UsageState> = {}): UsageState => ({
  activated: true, banned: false, plan: 'beta',
  problems_used: 0, problems_limit: 20, asks_used: 0, asks_limit: 60,
  listens_used: 4, listens_limit: 300, speech_characters_used: 100, speech_characters_limit: 20000,
  dollars_used: 0, dollars_limit: 2, requests_last_minute: 0, requests_per_minute: 30,
  resets_at: '2026-11-09T05:00:00+00:00', ...over
})

function fake(opts: { state?: UsageState; env?: Record<string, string> } = {}) {
  const recorded: UsageEvent[] = []
  const outside: { url: string; headers: Headers; body: Record<string, unknown> }[] = []
  const deps: VoiceDeps = {
    userFor: async (t) => (t === 'good' ? 'student-1' : null),
    usage: async () => opts.state ?? state(),
    record: async (e) => void recorded.push(e),
    env: (n) => ({ DEEPGRAM_API_KEY: 'dg-server-key', ...opts.env })[n],
    fetch: (async (url: string, init: RequestInit) => {
      outside.push({ url, headers: new Headers(init.headers), body: JSON.parse(String(init.body)) })
      return url.includes('deepgram')
        ? Response.json({ access_token: 'jwt-abc', expires_in: 30 })
        : new Response(new Uint8Array([9, 9]), { headers: { 'content-type': 'audio/mpeg' } })
    }) as typeof fetch
  }
  return { deps, recorded, outside }
}

const post = (path: string, body: unknown = {}, token = 'good') =>
  new Request(`http://localhost/functions/v1/voice/${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) })
const errorOf = async (res: Response) => ((await res.json()) as { error: { type: string; message: string } }).error

describe('voice server', () => {
  it('hands out a 30-second Deepgram token, keeping the key on the server, and counts it', async () => {
    const f = fake()
    const res = await handleVoice(post('stt-token'), f.deps)
    expect(await res.json()).toEqual({ token: 'jwt-abc', expiresIn: 30 })
    expect(f.outside[0]).toMatchObject({ url: 'https://api.deepgram.com/v1/auth/grant', body: { ttl_seconds: 30 } })
    expect(f.outside[0].headers.get('authorization')).toBe('Token dg-server-key')
    expect(f.recorded).toMatchObject([{ job: 'listen', unit: null, cost_usd: 0 }])
  })

  it('needs a sign-in, and stops at the weekly voice cap', async () => {
    const f = fake({ state: state({ listens_used: 300 }) })
    expect((await handleVoice(post('stt-token', {}, 'bad'), f.deps)).status).toBe(401)
    const capped = await handleVoice(post('stt-token'), f.deps)
    expect(capped.status).toBe(429)
    expect((await errorOf(capped)).message).toBe("You've used this week's 300 voice messages. Type instead until Monday.")
    expect(f.outside).toHaveLength(0)
  })

  it("says voice off (the computer's voice reads it) unless ElevenLabs is switched on", async () => {
    const f = fake()
    const res = await handleVoice(post('tts', { text: 'Hi' }), f.deps)
    expect(res.status).toBe(404)
    expect((await errorOf(res)).type).toBe('clueless_voice_off')
    expect(f.outside).toHaveLength(0)
  })

  it('reads aloud with ElevenLabs when it is on, and counts the characters and their cost', async () => {
    const f = fake({ env: { CLUELESS_ELEVENLABS: 'on', ELEVENLABS_API_KEY: 'el-key', CLUELESS_ELEVENLABS_VOICE: 'voice123' } })
    const res = await handleVoice(post('tts', { text: 'Which part is u?', previousText: 'Nice.' }), f.deps)
    expect(res.headers.get('content-type')).toBe('audio/mpeg')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([9, 9]))
    expect(f.outside[0].url).toContain('/v1/text-to-speech/voice123')
    expect(f.outside[0].headers.get('xi-api-key')).toBe('el-key')
    expect(f.outside[0].body).toMatchObject({ text: 'Which part is u?', model_id: 'eleven_flash_v2_5', previous_text: 'Nice.' })
    expect(f.recorded).toMatchObject([{ job: 'speak', characters: 16 }])
    expect(f.recorded[0].cost_usd).toBeCloseTo(16 * 0.00011)

    // Past this week's read-aloud allowance: the computer's voice takes over.
    const full = fake({ state: state({ speech_characters_used: 19995 }), env: { CLUELESS_ELEVENLABS: 'on', ELEVENLABS_API_KEY: 'k', CLUELESS_ELEVENLABS_VOICE: 'v' } })
    expect((await handleVoice(post('tts', { text: 'Which part is u?' }), full.deps)).status).toBe(404)
  })
})
