// Spoken replies. The UI only talks to `SpeechService`, so the engine can change (e.g. to
// ElevenLabs) without touching the tutor or the screens. V1 uses the built-in speechSynthesis.
import type { TtsRequest, TtsResult } from '../../../shared/contracts'
import { speechChunks } from '../../../shared/speechText'

export type SpeechState = 'idle' | 'speaking' | 'paused'

export interface SpeechSnapshot {
  state: SpeechState
  error: string | null
}

export interface SpeechService {
  readonly available: boolean
  /** Say `text` (already plain words, see toSpeech). Stops anything that was playing.
   *  `onDone` runs when it has been said to the end (not when it's stopped or replaced). */
  speak(text: string, onDone?: () => void): void
  pause(): void
  resume(): void
  stop(): void
  /** How fast to talk: 1 = normal, 2 = twice as fast. Applies to what's playing and what comes next. */
  setRate(rate: number): void
  snapshot(): SpeechSnapshot
  subscribe(cb: (s: SpeechSnapshot) => void): () => void
}

/** The parts of the Web Speech API we use, so tests can pass a fake. */
export interface SynthLike {
  readonly speaking: boolean
  readonly pending: boolean
  readonly paused: boolean
  speak(u: SpeechSynthesisUtterance): void
  cancel(): void
  pause(): void
  resume(): void
  getVoices(): SpeechSynthesisVoice[]
  addEventListener(type: 'voiceschanged', cb: () => void): void
  removeEventListener(type: 'voiceschanged', cb: () => void): void
}

type UtteranceCtor = new (text: string) => SpeechSynthesisUtterance

const VOICE_WAIT_MS = 1500 // voices load late on first use; after this, speak with the default
const POLL_MS = 400 // backup for engines that sometimes never fire `end`

export function createBrowserSpeech(
  synth: SynthLike | undefined = typeof speechSynthesis === 'undefined' ? undefined : speechSynthesis,
  Utterance: UtteranceCtor | undefined = typeof SpeechSynthesisUtterance === 'undefined' ? undefined : SpeechSynthesisUtterance,
  lang = typeof navigator === 'undefined' ? 'en-US' : navigator.language
): SpeechService {
  let snap: SpeechSnapshot = { state: 'idle', error: null }
  const listeners = new Set<(s: SpeechSnapshot) => void>()
  let generation = 0 // bumps on every speak/stop; callbacks from older speech are ignored
  let poll: ReturnType<typeof setInterval> | null = null
  let voice: SpeechSynthesisVoice | null = null
  let rate = 1

  const set = (next: Partial<SpeechSnapshot>): void => {
    snap = { ...snap, ...next }
    listeners.forEach((cb) => cb(snap))
  }
  const stopPoll = (): void => {
    if (poll) clearInterval(poll)
    poll = null
  }
  const available = Boolean(synth && Utterance)

  const voicesReady = (): Promise<void> =>
    new Promise((resolve) => {
      if (!synth || synth.getVoices().length > 0) return resolve()
      const done = (): void => {
        synth.removeEventListener('voiceschanged', done)
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(done, VOICE_WAIT_MS)
      synth.addEventListener('voiceschanged', done)
    })

  const stop = (): void => {
    generation++
    stopPoll()
    try {
      synth?.cancel()
    } catch {
      // nothing playing
    }
    if (snap.state !== 'idle') set({ state: 'idle' })
  }

  const speak = (text: string, onDone?: () => void): void => {
    stop()
    if (!synth || !Utterance) {
      set({ error: "Spoken replies aren't available on this computer." })
      onDone?.()
      return
    }
    const chunks = speechChunks(text)
    if (chunks.length === 0) return onDone?.()
    const gen = generation
    set({ state: 'speaking', error: null })

    void voicesReady().then(() => {
      if (gen !== generation) return
      voice ??= pickVoice(synth.getVoices(), lang)

      const sayChunk = (i: number): void => {
        if (gen !== generation) return
        if (i >= chunks.length) {
          stopPoll()
          set({ state: 'idle' })
          onDone?.()
          return
        }
        const u = new Utterance(chunks[i])
        if (voice) u.voice = voice
        u.lang = voice?.lang ?? lang
        u.rate = rate
        let ended = false
        const next = (): void => {
          if (ended) return
          ended = true
          sayChunk(i + 1)
        }
        u.onend = next
        u.onerror = (e) => {
          if (gen !== generation || ended) return
          ended = true
          // `interrupted` / `canceled` are our own stop() or a newer reply: not a failure.
          if (e.error === 'interrupted' || e.error === 'canceled') return
          stopPoll()
          set({ state: 'idle', error: "Couldn't play the reply aloud. The text is still on screen." })
          onDone?.()
        }
        try {
          synth.speak(u)
        } catch {
          stopPoll()
          set({ state: 'idle', error: "Couldn't play the reply aloud. The text is still on screen." })
          return
        }
        // Some engines drop `end` now and then: if nothing is playing or queued, move on.
        stopPoll()
        let quiet = 0
        poll = setInterval(() => {
          if (gen !== generation) return stopPoll()
          if (snap.state === 'paused' || synth.speaking || synth.pending) {
            quiet = 0
            return
          }
          if (++quiet >= 3) next()
        }, POLL_MS)
      }
      sayChunk(0)
    })
  }

  return {
    available,
    speak,
    stop,
    pause: () => {
      if (snap.state !== 'speaking' || !synth) return
      synth.pause()
      set({ state: 'paused' })
    },
    resume: () => {
      if (snap.state !== 'paused' || !synth) return
      synth.resume()
      set({ state: 'speaking' })
    },
    setRate: (r) => {
      rate = r // the built-in voice can't change speed mid-sentence: the next sentence picks it up
    },
    snapshot: () => snap,
    subscribe: (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    }
  }
}

/** A voice in the student's language, preferring the nicer "natural/neural" ones and local voices. */
export function pickVoice(voices: SpeechSynthesisVoice[], lang: string): SpeechSynthesisVoice | null {
  if (voices.length === 0) return null
  const base = lang.toLowerCase().split('-')[0]
  const score = (v: SpeechSynthesisVoice): number => {
    const vl = v.lang.toLowerCase().replace('_', '-')
    let s = 0
    if (vl === lang.toLowerCase()) s += 4
    else if (vl.startsWith(base)) s += 3
    else if (vl.startsWith('en')) s += 1
    if (/natural|neural|premium|enhanced/i.test(v.name)) s += 2
    if (v.localService) s += 1 // works offline, starts faster
    if (v.default) s += 0.5
    return s
  }
  return [...voices].sort((a, b) => score(b) - score(a))[0]
}

/**
 * ElevenLabs voice (fetched by the main process, which holds the key), played with an <audio>.
 * Long replies go in sentence groups: the next one downloads while the current one plays.
 * No key, or any failure: the rest of the reply continues in the built-in `fallback` voice.
 */
export function createCloudSpeech(
  tts: (req: TtsRequest) => Promise<TtsResult>,
  fallback: SpeechService,
  makeAudio: () => HTMLAudioElement = () => new Audio()
): SpeechService {
  let snap: SpeechSnapshot = { state: 'idle', error: null }
  const listeners = new Set<(s: SpeechSnapshot) => void>()
  let generation = 0
  let audio: HTMLAudioElement | null = null
  let url: string | null = null
  let onFallback = false
  let notice: string | null = null // why we switched to the built-in voice
  let rate = 1

  const set = (next: Partial<SpeechSnapshot>): void => {
    snap = { ...snap, ...next }
    listeners.forEach((cb) => cb(snap))
  }
  fallback.subscribe((s) => {
    if (onFallback) set({ state: s.state, error: s.error ?? notice })
  })

  const clearAudio = (): void => {
    if (audio) {
      audio.onended = null
      audio.onerror = null
      audio.pause()
      audio.removeAttribute('src')
    }
    if (url) URL.revokeObjectURL(url)
    url = null
  }

  const stop = (): void => {
    generation++
    clearAudio()
    if (onFallback) {
      onFallback = false
      fallback.stop()
    }
    if (snap.state !== 'idle') set({ state: 'idle' })
  }

  const speak = (text: string, onDone?: () => void): void => {
    stop()
    const chunks = speechChunks(text, 400)
    if (chunks.length === 0) return onDone?.()
    const gen = generation
    notice = null
    set({ state: 'speaking', error: null })

    const requests = new Map<number, Promise<TtsResult>>()
    const fetchChunk = (i: number): Promise<TtsResult> => {
      let p = requests.get(i)
      if (!p) {
        p = tts({ text: chunks[i], previousText: chunks[i - 1], nextText: chunks[i + 1] }).catch(
          (err): TtsResult => ({ ok: false, reason: 'error', message: String(err) })
        )
        requests.set(i, p)
      }
      return p
    }

    const switchToFallback = (i: number, why: TtsResult): void => {
      if (gen !== generation) return
      clearAudio()
      notice = !why.ok && why.reason === 'error' ? `Used the built-in voice: ${why.message}` : null
      onFallback = true
      fallback.speak(chunks.slice(i).join(' '), onDone)
    }

    const play = async (i: number): Promise<void> => {
      if (gen !== generation) return
      if (i >= chunks.length) {
        clearAudio()
        set({ state: 'idle' })
        onDone?.()
        return
      }
      const res = await fetchChunk(i)
      if (gen !== generation) return
      if (!res.ok) return switchToFallback(i, res)
      if (i + 1 < chunks.length) void fetchChunk(i + 1) // download the next piece while this one plays

      clearAudio()
      url = URL.createObjectURL(new Blob([res.audio], { type: res.mime }))
      const a = (audio ??= makeAudio())
      a.src = url
      a.defaultPlaybackRate = rate // a new src resets the speed to this
      a.playbackRate = rate
      a.onended = () => void play(i + 1)
      a.onerror = () => switchToFallback(i, { ok: false, reason: 'error', message: "couldn't play the audio." })
      if (snap.state === 'paused') return // paused while it was downloading: resume() starts it
      try {
        await a.play()
      } catch {
        // pause()/stop() during start-up rejects play(): that's not a failure
        if (gen === generation && snap.state === 'speaking' && a.paused) {
          switchToFallback(i, { ok: false, reason: 'error', message: "couldn't play the audio." })
        }
      }
    }
    void play(0)
  }

  return {
    available: true,
    speak,
    stop,
    pause: () => {
      if (onFallback) return fallback.pause()
      if (snap.state !== 'speaking') return
      audio?.pause()
      set({ state: 'paused' })
    },
    resume: () => {
      if (onFallback) return fallback.resume()
      if (snap.state !== 'paused') return
      set({ state: 'speaking' })
      if (audio?.src) void audio.play().catch(() => {})
    },
    setRate: (r) => {
      rate = r
      if (audio) audio.playbackRate = r
      fallback.setRate(r)
    },
    snapshot: () => snap,
    subscribe: (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    }
  }
}
