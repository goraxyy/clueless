// Spoken replies with ElevenLabs. Runs in the main process so the API key never reaches the UI.
// The voice is chosen by name from the student's ElevenLabs account (ELEVENLABS_VOICE), since
// ElevenLabs' old default voice IDs stop working at the end of 2026. No Electron imports (testable).
import type { TtsRequest, TtsResult } from '../../shared/contracts'

const API = 'https://api.elevenlabs.io'
// Expressive and real-time (~100 ms); the fallback model is the fastest one if v4 isn't on the plan.
export const DEFAULT_MODEL = 'eleven_v4_turbo'
const FALLBACK_MODEL = 'eleven_flash_v2_5'
const TIMEOUT_MS = 20000
export const MAX_TTS_CHARS = 2500

/** Warm, natural "teacher" voices, best first: ElevenLabs' new voice names, then the built-in
 *  ones every account (including free) can use until they're retired at the end of 2026. */
export const PREFERRED_VOICES = [
  'Talia', 'Caleb', 'Maisie', 'Eddie', 'Jade', 'Wyatt', 'Lawrence',
  'Jessica', 'Lily', 'Sarah', 'Matilda', 'Alice', 'Chris', 'Eric', 'Bella'
]

// Natural delivery: a little variation (lower stability) keeps it from sounding read out.
const VOICE_SETTINGS = { stability: 0.45, similarity_boost: 0.8, use_speaker_boost: true, speed: 1.0 }

type Env = Record<string, string | undefined>
type Fetch = typeof fetch

export class ElevenLabs {
  private voiceCache = new Map<string, Promise<string>>()
  private modelOk = new Map<string, boolean>()

  constructor(
    private readonly env: () => Env,
    private readonly http: Fetch = fetch,
    private readonly log: (line: string) => void = () => {}
  ) {}

  async speak(req: unknown): Promise<TtsResult> {
    const input = validate(req)
    if (!input) return { ok: false, reason: 'error', message: 'Nothing to say.' }
    const env = this.env()
    const key = env.ELEVENLABS_API_KEY?.trim()
    if (!key) return { ok: false, reason: 'no-key', message: 'No ELEVENLABS_API_KEY set.' }

    try {
      const voiceId = await this.voice(key, env.ELEVENLABS_VOICE?.trim() || '')
      const model = env.ELEVENLABS_MODEL?.trim() || DEFAULT_MODEL
      const started = Date.now()
      let res = await this.convert(key, voiceId, model, input)
      // The plan doesn't include the model: retry once with the fast default, and remember.
      if (!res.ok && (res.status === 400 || res.status === 403 || res.status === 422) && model !== FALLBACK_MODEL) {
        const detail = await res.text().catch(() => '')
        if (/model/i.test(detail)) {
          this.log(`elevenlabs: ${model} unavailable, using ${FALLBACK_MODEL}`)
          this.modelOk.set(model, false)
          res = await this.convert(key, voiceId, FALLBACK_MODEL, input)
        } else {
          return fail(res.status, detail)
        }
      }
      // A Voice Library voice on the free plan: use the best built-in voice instead, and say why.
      if (res.status === 402) {
        const detail = await res.text().catch(() => '')
        if (!/paid_plan_required|library voices/i.test(detail)) return fail(res.status, detail)
        const sub = await this.voice(key, FREE_VOICE)
        this.log(`elevenlabs: "${env.ELEVENLABS_VOICE}" needs a paid ElevenLabs plan, using a free voice instead`)
        this.voiceCache.set(`${key.slice(-6)}:${env.ELEVENLABS_VOICE?.trim() || ''}`, Promise.resolve(sub))
        res = await this.convert(key, sub, model, input)
      }
      if (!res.ok) return fail(res.status, await res.text().catch(() => ''))
      const audio = await res.arrayBuffer()
      this.log(`elevenlabs: ${input.text.length} chars in ${Date.now() - started}ms`)
      return { ok: true, audio, mime: res.headers.get('content-type') || 'audio/mpeg' }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.startsWith('voice:')) return { ok: false, reason: 'error', message: message.slice(6) }
      return { ok: false, reason: 'error', message: "Couldn't reach ElevenLabs. Check your internet connection." }
    }
  }

  private convert(key: string, voiceId: string, model: string, input: TtsRequest): Promise<Response> {
    const useModel = this.modelOk.get(model) === false ? FALLBACK_MODEL : model
    return this.http(`${API}/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify({
        text: input.text,
        model_id: useModel,
        voice_settings: VOICE_SETTINGS,
        // Neighbouring sentences keep the intonation flowing across pieces of one reply.
        ...(input.previousText ? { previous_text: input.previousText } : {}),
        ...(input.nextText ? { next_text: input.nextText } : {})
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
  }

  /** ELEVENLABS_VOICE can be a voice ID or a name ("Talia"); empty picks a warm default. */
  private voice(key: string, wanted: string): Promise<string> {
    const cacheKey = `${key.slice(-6)}:${wanted}`
    let found = this.voiceCache.get(cacheKey)
    if (!found) {
      found = this.findVoice(key, wanted)
      this.voiceCache.set(cacheKey, found)
      found.catch(() => this.voiceCache.delete(cacheKey)) // try again next time
    }
    return found
  }

  private async findVoice(key: string, wanted: string): Promise<string> {
    if (/^[A-Za-z0-9]{20}$/.test(wanted)) return wanted
    const params = new URLSearchParams({ page_size: '100' })
    if (wanted === FREE_VOICE) params.set('voice_type', 'default') // voices every plan can use
    else if (wanted) params.set('search', wanted)
    const res = await this.http(`${API}/v2/voices?${params}`, {
      headers: { 'xi-api-key': key },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
    if (res.status === 401) throw new Error('voice:ElevenLabs rejected the key. Check ELEVENLABS_API_KEY in your .env file.')
    if (!res.ok) throw new Error(`voice:ElevenLabs couldn't list voices (${res.status}).`)
    const body = (await res.json()) as { voices?: { voice_id: string; name: string }[] }
    const voices = body.voices ?? []
    const pick = chooseVoice(voices, wanted === FREE_VOICE ? '' : wanted)
    if (!pick) {
      throw new Error(
        wanted
          ? `voice:No ElevenLabs voice called "${wanted}" in your account. Add it from the Voice Library, or change ELEVENLABS_VOICE.`
          : 'voice:Your ElevenLabs account has no voices yet. Add one from the Voice Library.'
      )
    }
    this.log(`elevenlabs: voice "${pick.name}"`)
    return pick.voice_id
  }
}

export function chooseVoice<T extends { name: string }>(voices: T[], wanted: string): T | null {
  const starts = (v: T, name: string): boolean => v.name.toLowerCase().startsWith(name.toLowerCase())
  if (wanted) return voices.find((v) => starts(v, wanted)) ?? null
  for (const name of PREFERRED_VOICES) {
    const v = voices.find((x) => starts(x, name))
    if (v) return v
  }
  return voices[0] ?? null
}

function validate(req: unknown): TtsRequest | null {
  if (!req || typeof req !== 'object') return null
  const { text, previousText, nextText } = req as Record<string, unknown>
  if (typeof text !== 'string' || !text.trim()) return null
  const clip = (s: unknown): string | undefined => (typeof s === 'string' && s.trim() ? s.slice(0, 500) : undefined)
  return { text: text.slice(0, MAX_TTS_CHARS), previousText: clip(previousText), nextText: clip(nextText) }
}

/** Internal marker: "the best voice any plan can use". */
const FREE_VOICE = ':free-voice:'

function fail(status: number, detail: string): TtsResult {
  // ElevenLabs explains most errors itself: {"detail":{"message":"..."}}.
  let theirs = ''
  try {
    const d = (JSON.parse(detail) as { detail?: { message?: string } | string }).detail
    theirs = typeof d === 'string' ? d : (d?.message ?? '')
  } catch {
    // not JSON
  }
  // Out of characters comes back as a 401 too, so it's checked first.
  const message = /quota_exceeded|insufficient.*credits|credits.*(run out|exceeded)/i.test(detail)
    ? 'Your ElevenLabs characters for this month have run out.'
    : status === 401
      ? 'ElevenLabs rejected the key. Check ELEVENLABS_API_KEY in your .env file.'
      : status === 429
          ? 'ElevenLabs is busy (too many requests). Try again in a moment.'
          : theirs
            ? `ElevenLabs: ${theirs}`
            : `ElevenLabs error (${status}).`
  return { ok: false, reason: 'error', message }
}
