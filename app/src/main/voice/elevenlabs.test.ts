import { describe, expect, it } from 'vitest'
import { chooseVoice, DEFAULT_MODEL, ElevenLabs } from './elevenlabs'

type Call = { url: string; init?: RequestInit }

function fakeFetch(routes: (call: Call) => Response) {
  const calls: Call[] = []
  const http = (async (url: string, init?: RequestInit) => {
    const call = { url: String(url), init }
    calls.push(call)
    return routes(call)
  }) as unknown as typeof fetch
  return { http, calls }
}

const voices = (names: string[]) =>
  new Response(JSON.stringify({ voices: names.map((name, i) => ({ voice_id: `id${i}`, name })) }), { status: 200 })
const mp3 = () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'audio/mpeg' } })

describe('ElevenLabs', () => {
  it('no key: tells the UI to use the built-in voice, without calling the API', async () => {
    const { http, calls } = fakeFetch(() => mp3())
    const el = new ElevenLabs(() => ({}), http)
    expect(await el.speak({ text: 'Hi' })).toMatchObject({ ok: false, reason: 'no-key' })
    expect(calls).toHaveLength(0)
  })

  it('finds the voice by name once, keeps the key in a header, and returns the audio', async () => {
    const { http, calls } = fakeFetch(({ url }) => (url.includes('/v2/voices') ? voices(['Talia - Warm Soft Guide']) : mp3()))
    const el = new ElevenLabs(() => ({ ELEVENLABS_API_KEY: 'k123456', ELEVENLABS_VOICE: 'Talia' }), http)
    const res = await el.speak({ text: 'What repeats?', previousText: 'Nice.', nextText: 'Look again.' })
    expect(res).toMatchObject({ ok: true, mime: 'audio/mpeg' })
    await el.speak({ text: 'Again' })
    expect(calls.filter((c) => c.url.includes('/v2/voices'))).toHaveLength(1) // cached
    const tts = calls.find((c) => c.url.includes('/v1/text-to-speech/id0'))!
    expect(tts.url).not.toContain('k123456')
    expect((tts.init?.headers as Record<string, string>)['xi-api-key']).toBe('k123456')
    const body = JSON.parse(String(tts.init?.body))
    expect(body).toMatchObject({ text: 'What repeats?', model_id: DEFAULT_MODEL, previous_text: 'Nice.', next_text: 'Look again.' })
  })

  it('falls back to the flash model when the plan lacks v4', async () => {
    const { http, calls } = fakeFetch(({ url, init }) => {
      if (url.includes('/v2/voices')) return voices(['Caleb'])
      const model = JSON.parse(String(init?.body)).model_id
      return model === DEFAULT_MODEL ? new Response('model not available for your tier', { status: 403 }) : mp3()
    })
    const el = new ElevenLabs(() => ({ ELEVENLABS_API_KEY: 'k' }), http)
    expect(await el.speak({ text: 'Hi' })).toMatchObject({ ok: true })
    const models = calls.filter((c) => c.url.includes('text-to-speech')).map((c) => JSON.parse(String(c.init?.body)).model_id)
    expect(models).toEqual([DEFAULT_MODEL, 'eleven_flash_v2_5'])
  })

  it('explains a bad key, empty credits and a missing voice', async () => {
    const badKey = new ElevenLabs(() => ({ ELEVENLABS_API_KEY: 'k' }), fakeFetch(() => new Response('', { status: 401 })).http)
    expect(await badKey.speak({ text: 'Hi' })).toMatchObject({ ok: false, message: expect.stringContaining('rejected the key') })

    const broke = new ElevenLabs(
      () => ({ ELEVENLABS_API_KEY: 'k', ELEVENLABS_VOICE: 'abcdefghij0123456789' }), // an ID: no lookup
      fakeFetch(() => new Response('{"detail":{"status":"quota_exceeded","message":"You have 0 credits left."}}', { status: 400 })).http
    )
    expect(await broke.speak({ text: 'Hi' })).toMatchObject({ ok: false, message: expect.stringContaining('run out') })
    // ElevenLabs sends "out of characters" as a 401 too: not a bad key.
    const spent = new ElevenLabs(
      () => ({ ELEVENLABS_API_KEY: 'k', ELEVENLABS_VOICE: 'abcdefghijklmnopqrst' }),
      fakeFetch(() => new Response('{"detail":{"status":"quota_exceeded","message":"This request exceeds your quota."}}', { status: 401 })).http
    )
    expect(await spent.speak({ text: 'Hi' })).toMatchObject({ ok: false, message: expect.stringContaining('run out') })

    const missing = new ElevenLabs(() => ({ ELEVENLABS_API_KEY: 'k', ELEVENLABS_VOICE: 'Nobody' }), fakeFetch(() => voices([])).http)
    expect(await missing.speak({ text: 'Hi' })).toMatchObject({ ok: false, message: expect.stringContaining('No ElevenLabs voice called "Nobody"') })
  })

  it('rejects bad requests and network failures cleanly', async () => {
    const el = new ElevenLabs(() => ({ ELEVENLABS_API_KEY: 'k', ELEVENLABS_VOICE: 'abcdefghij0123456789' }), (async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch)
    expect(await el.speak(null)).toMatchObject({ ok: false })
    expect(await el.speak({ text: '   ' })).toMatchObject({ ok: false })
    expect(await el.speak({ text: 'Hi' })).toMatchObject({ ok: false, message: expect.stringContaining("Couldn't reach") })
  })
})

describe('ElevenLabs free plan', () => {
  it('a Voice Library voice on the free plan switches to the best built-in voice', async () => {
    const paid = '{"detail":{"code":"paid_plan_required","message":"Free users cannot use library voices via the API."}}'
    const { http, calls } = fakeFetch(({ url }) => {
      if (url.includes('voice_type=default')) return voices(['Bella - Bright', 'Jessica - Playful, Bright, Warm'])
      if (url.includes('/v2/voices')) return voices(['Serafina - Sensual Temptress'])
      return url.includes('/text-to-speech/id0') && calls.filter((c) => c.url.includes('/text-to-speech/')).length === 1
        ? new Response(paid, { status: 402 })
        : mp3()
    })
    const el = new ElevenLabs(() => ({ ELEVENLABS_API_KEY: 'k', ELEVENLABS_VOICE: 'Serafina' }), http)
    expect(await el.speak({ text: 'Hi' })).toMatchObject({ ok: true })
    // Jessica (id1) is preferred over Bella among the built-in voices.
    expect(calls.filter((c) => c.url.includes('/text-to-speech/')).map((c) => c.url.split('/text-to-speech/')[1].split('?')[0])).toEqual(['id0', 'id1'])
    // Next time it goes straight to the free voice.
    await el.speak({ text: 'Again' })
    expect(calls.at(-1)?.url).toContain('/text-to-speech/id1')
  })

  it("shows ElevenLabs' own message for other errors", async () => {
    const el = new ElevenLabs(
      () => ({ ELEVENLABS_API_KEY: 'k', ELEVENLABS_VOICE: 'abcdefghij0123456789' }),
      fakeFetch(() => new Response('{"detail":{"message":"Text is too long."}}', { status: 400 })).http
    )
    expect(await el.speak({ text: 'Hi' })).toMatchObject({ ok: false, message: 'ElevenLabs: Text is too long.' })
  })
})

describe('chooseVoice', () => {
  it('matches a name, otherwise prefers warm teacher voices', () => {
    const list = [{ name: 'Baxter - Dry Calm Aussie' }, { name: 'Caleb - Trusted Guide' }, { name: 'Talia - Warm Soft Guide' }]
    expect(chooseVoice(list, 'baxter')?.name).toContain('Baxter')
    expect(chooseVoice(list, '')?.name).toContain('Talia')
    expect(chooseVoice([{ name: 'Someone' }], '')?.name).toBe('Someone')
    expect(chooseVoice([], '')).toBeNull()
  })
})
