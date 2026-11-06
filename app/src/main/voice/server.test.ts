import { describe, expect, it } from 'vitest'
import { ServerVoice } from './server'

const server = { url: 'https://proj.supabase.co', publishableKey: 'sb_publishable_x' }

function fake(reply: (path: string, body: Record<string, unknown>) => Response) {
  const calls: { url: string; auth: string | null; body: Record<string, unknown> }[] = []
  const http = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body))
    calls.push({ url, auth: new Headers(init.headers).get('authorization'), body })
    return reply(url.split('/voice/')[1], body)
  }) as typeof fetch
  return { calls, voice: new ServerVoice(server, async () => 'student-token', http) }
}

describe('ServerVoice', () => {
  it('gets a recording token with the sign-in, not a key', async () => {
    const { calls, voice } = fake(() => Response.json({ token: 'jwt', expiresIn: 30 }))
    expect(await voice.listenToken()).toEqual({ token: 'jwt' })
    expect(calls[0]).toMatchObject({ url: 'https://proj.supabase.co/functions/v1/voice/stt-token', auth: 'Bearer student-token' })
  })

  it("passes the server's reason on, in words for the student", async () => {
    const { voice } = fake(() => Response.json({ type: 'error', error: { type: 'clueless_weekly_limit', message: 'Type instead until Monday.' } }, { status: 429 }))
    expect(await voice.listenToken()).toEqual({ error: 'Type instead until Monday.' })
    const signedOut = new ServerVoice(server, async () => null)
    expect(await signedOut.listenToken()).toEqual({ error: 'Sign in to Clueless first.' })
  })

  it("uses the computer's voice quietly while the server's voice is off, without asking again", async () => {
    const { calls, voice } = fake(() => Response.json({ type: 'error', error: { type: 'clueless_voice_off', message: 'off' } }, { status: 404 }))
    expect(await voice.speak({ text: 'Hello' })).toMatchObject({ ok: false, reason: 'no-key' })
    expect(await voice.speak({ text: 'Again' })).toMatchObject({ ok: false, reason: 'no-key' })
    expect(calls).toHaveLength(1)
  })

  it('plays the audio when the server reads it aloud', async () => {
    const { calls, voice } = fake(() => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'audio/mpeg' } }))
    const result = await voice.speak({ text: 'Which part is u?', previousText: 'Nice.' })
    expect(result).toMatchObject({ ok: true, mime: 'audio/mpeg' })
    expect(result.ok && result.audio.byteLength).toBe(3)
    expect(calls[0].body).toEqual({ text: 'Which part is u?', previousText: 'Nice.' })
  })
})
