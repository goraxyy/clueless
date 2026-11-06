// Voice through Clueless's server (the `voice` function), for students who have no keys: a Deepgram
// token for each recording, and replies read aloud when the server has ElevenLabs switched on.
// When it's off (the beta's default) the UI uses the computer's own voice, quietly.
// No Electron imports, so it's unit-testable.
import type { TtsResult } from '../../shared/contracts'
import type { AccountServer } from '../account/project'

const TIMEOUT_MS = 8000
/** After "voice off" or a used-up allowance, don't ask again for a while. */
const OFF_FOR_MS = 10 * 60_000

type Fetch = typeof fetch

export class ServerVoice {
  private offUntil = 0

  constructor(
    private readonly server: AccountServer,
    private readonly accessToken: () => Promise<string | null>,
    private readonly http: Fetch = fetch,
    private readonly log: (line: string) => void = () => {}
  ) {}

  /** A token for one recording, or what to tell the student. */
  async listenToken(): Promise<{ token: string } | { error: string }> {
    const res = await this.post('stt-token')
    if ('error' in res) return { error: res.error }
    const body = (await res.response.json().catch(() => null)) as { token?: string } | null
    return body?.token ? { token: body.token } : { error: "Talking to Clueless didn't work this time. Try again." }
  }

  async speak(req: unknown): Promise<TtsResult> {
    const quiet = { ok: false as const, reason: 'no-key' as const, message: "Reading aloud uses your computer's voice." }
    if (Date.now() < this.offUntil) return quiet
    const r = (req ?? {}) as Record<string, unknown>
    if (typeof r.text !== 'string' || !r.text.trim()) return { ok: false, reason: 'error', message: 'Nothing to say.' }
    const res = await this.post('tts', { text: r.text, previousText: r.previousText, nextText: r.nextText })
    if ('error' in res) {
      // Off, used up, signed out or offline: the computer's voice reads it instead, no warning.
      if (res.status === 404 || res.status === 429) this.offUntil = Date.now() + OFF_FOR_MS
      return quiet
    }
    return { ok: true, audio: await res.response.arrayBuffer(), mime: res.response.headers.get('content-type') ?? 'audio/mpeg' }
  }

  private async post(path: string, body?: unknown): Promise<{ response: Response } | { error: string; status: number }> {
    const token = await this.accessToken()
    if (!token) return { error: 'Sign in to Clueless first.', status: 401 }
    let response: Response
    try {
      response = await this.http(`${this.server.url}/functions/v1/voice/${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, apikey: this.server.publishableKey, 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
        signal: AbortSignal.timeout(TIMEOUT_MS)
      })
    } catch (err) {
      this.log(`voice: ${(err as Error).message}`)
      return { error: "Couldn't reach Clueless. Check your internet connection.", status: 0 }
    }
    if (response.ok) return { response }
    const failed = (await response.json().catch(() => null)) as { error?: { message?: string } } | null
    return { error: failed?.error?.message ?? "Talking to Clueless didn't work this time. Try again.", status: response.status }
  }
}
