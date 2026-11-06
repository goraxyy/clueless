// The `voice` function: talking to Clueless and hearing it, with no keys on the student's laptop.
//   POST .../voice/stt-token  a Deepgram token good for 30 seconds: the app opens its speech stream
//                             with it, and the stream then stays open as long as the student talks
//   POST .../voice/tts        a reply read aloud by ElevenLabs, only when it's switched on
//                             (CLUELESS_ELEVENLABS=on, ELEVENLABS_API_KEY, CLUELESS_ELEVENLABS_VOICE);
//                             otherwise "voice off", and the app uses the computer's own voice
// Both check the sign-in and the weekly caps like the `ai` function. Pure TypeScript (Deno and Node).
import { errorResponse, studentOf, type Deps, type UsageEvent } from './handler.ts'
import { refusalFor } from './policy.ts'

export type VoiceDeps = Pick<Deps, 'userFor' | 'usage' | 'record' | 'fetch' | 'env' | 'log'>

const MAX_SPEECH_CHARS = 2500
/** ElevenLabs Flash on the Creator plan: half a credit a character, $22 for 100k credits. */
const DOLLARS_PER_CHARACTER = 0.00011
const VOICE_OFF = () => errorResponse(404, 'clueless_voice_off', "Reading aloud uses your computer's voice.")

export async function handleVoice(req: Request, deps: VoiceDeps): Promise<Response> {
  const log = deps.log ?? (() => {})
  if (req.method !== 'POST') return errorResponse(405, 'clueless_bad_request', 'Use POST.')
  const path = new URL(req.url).pathname
  const kind = path.endsWith('/stt-token') ? 'listen' : path.endsWith('/tts') ? 'speak' : null
  if (!kind) return errorResponse(404, 'clueless_bad_request', 'Unknown path.')

  const userId = await studentOf(req, deps.userFor)
  if (!userId) return errorResponse(401, 'clueless_signed_out', 'Sign in to Clueless again.')

  // Reading aloud is off: say so before anything else, so the app stops asking.
  const elevenKey = deps.env('ELEVENLABS_API_KEY')
  const elevenVoice = deps.env('CLUELESS_ELEVENLABS_VOICE')
  if (kind === 'speak' && (deps.env('CLUELESS_ELEVENLABS') !== 'on' || !elevenKey || !elevenVoice)) return VOICE_OFF()

  let text = ''
  let context: { previous_text?: string; next_text?: string } = {}
  if (kind === 'speak') {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
    text = typeof body?.text === 'string' ? body.text.trim() : ''
    if (!text || text.length > MAX_SPEECH_CHARS) return errorResponse(400, 'clueless_bad_request', 'Nothing to read aloud.')
    if (typeof body?.previousText === 'string') context.previous_text = body.previousText.slice(-500)
    if (typeof body?.nextText === 'string') context.next_text = body.nextText.slice(0, 500)
  }

  let state
  try {
    state = await deps.usage(userId)
  } catch (err) {
    log(`usage_check failed: ${(err as Error).message}`)
    return errorResponse(503, 'clueless_server', 'Clueless is having trouble right now. Try again in a minute.')
  }
  const refusal = refusalFor(state, null)
  if (refusal) return errorResponse(refusal.status, refusal.type, refusal.message)
  if (kind === 'listen' && state && (state.listens_used ?? 0) >= (state.listens_limit ?? Infinity)) {
    return errorResponse(429, 'clueless_weekly_limit', `You've used this week's ${state.listens_limit} voice messages. Type instead until Monday.`)
  }
  if (kind === 'speak' && state && (state.speech_characters_used ?? 0) + text.length > (state.speech_characters_limit ?? Infinity)) {
    return VOICE_OFF() // this week's read-aloud allowance is used up: the computer's voice takes over quietly
  }

  const event = (status: number, model: string, characters: number): UsageEvent => ({
    user_id: userId,
    job: kind,
    unit: null,
    model,
    status,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    characters,
    cost_usd: characters * DOLLARS_PER_CHARACTER
  })
  const record = (e: UsageEvent): Promise<void> => deps.record(e).catch((err) => log(`recording usage failed: ${(err as Error).message}`))

  if (kind === 'listen') {
    const key = deps.env('DEEPGRAM_API_KEY')
    if (!key) return errorResponse(503, 'clueless_voice_off', "Talking to Clueless isn't available right now. Type instead.")
    let res: Response
    try {
      res = await deps.fetch('https://api.deepgram.com/v1/auth/grant', {
        method: 'POST',
        headers: { authorization: `Token ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ttl_seconds: 30 })
      })
    } catch (err) {
      log(`Deepgram unreachable: ${(err as Error).message}`)
      return errorResponse(502, 'clueless_server', "Can't reach the speech service right now. Type instead.")
    }
    const grant = (await res.json().catch(() => null)) as { access_token?: string; expires_in?: number } | null
    if (!res.ok || !grant?.access_token) {
      log(`Deepgram grant returned ${res.status}`)
      return errorResponse(502, 'clueless_server', "Can't reach the speech service right now. Type instead.")
    }
    await record(event(200, 'deepgram', 0))
    return Response.json({ token: grant.access_token, expiresIn: grant.expires_in ?? 30 })
  }

  let res: Response
  try {
    res = await deps.fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(elevenVoice!)}?output_format=mp3_44100_64`, {
      method: 'POST',
      headers: { 'xi-api-key': elevenKey!, 'content-type': 'application/json', accept: 'audio/mpeg' },
      body: JSON.stringify({ text, model_id: 'eleven_flash_v2_5', ...context })
    })
  } catch (err) {
    log(`ElevenLabs unreachable: ${(err as Error).message}`)
    return VOICE_OFF()
  }
  if (!res.ok) {
    log(`ElevenLabs returned ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`)
    return VOICE_OFF()
  }
  await record(event(200, 'eleven_flash_v2_5', text.length))
  return new Response(res.body, { headers: { 'content-type': res.headers.get('content-type') ?? 'audio/mpeg' } })
}
