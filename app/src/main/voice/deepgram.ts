// Speech to text with Deepgram's streaming API. One Utterance = one press of the mic: the UI streams
// MediaRecorder chunks (webm/opus, which Deepgram detects on its own), we send back live text, and
// when the student pauses we send the final transcript once and close the connection.
// The API key stays here in the main process. No Electron imports, so it's unit-testable.
import type { VoiceStateEvent, VoiceTranscript } from '../../shared/contracts'

/** The bits of a WebSocket we use (Node's built-in WebSocket fits). */
export interface SocketLike {
  readonly readyState: number
  binaryType: string
  onopen: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onerror: ((ev: unknown) => void) | null
  onclose: ((ev: { code?: number; reason?: string }) => void) | null
  send(data: string | ArrayBuffer | ArrayBufferView): void
  close(code?: number): void
}

export type SocketFactory = (url: string, protocols: string[]) => SocketLike

export interface VoiceEvents {
  transcript(t: VoiceTranscript): void
  state(e: VoiceStateEvent): void
}

const OPEN = 1

// Pauses: Deepgram marks speech_final after 1 s of silence and sends UtteranceEnd after a 1.5 s gap
// between words. Either one ends the utterance, so a short breath mid-sentence doesn't.
export const DEEPGRAM_URL =
  'wss://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&interim_results=true' +
  '&endpointing=1000&utterance_end_ms=1500&vad_events=true'

export const TIMEOUTS = {
  connect: 8000, // no connection by then: give up
  noSpeech: 10000, // nothing said this long after connecting: stop listening
  maxLength: 90000, // one utterance can't run longer than this
  finalize: 2500 // after a manual stop, wait this long for Deepgram's last words
}

const MAX_QUEUED_BYTES = 2 * 1024 * 1024 // audio buffered while the connection opens

export class Utterance {
  private socket: SocketLike | null = null
  private queue: ArrayBufferView[] = []
  private queuedBytes = 0
  private committed: string[] = [] // is_final segments
  private interim = ''
  private stopping = false
  private finished = false
  private timers: ReturnType<typeof setTimeout>[] = []
  private noSpeechTimer: ReturnType<typeof setTimeout> | null = null
  private waiting = false // no credential yet: it's on its way from the Clueless server

  constructor(
    readonly id: string,
    private apiKey: string,
    private readonly events: VoiceEvents,
    private readonly makeSocket: SocketFactory,
    /** 'token': a Deepgram API key. 'bearer': a short-lived token from the Clueless server. */
    private readonly scheme: 'token' | 'bearer' = 'token'
  ) {}

  /** Record audio now and connect once the credential arrives (connectWith). */
  awaitCredential(): void {
    this.waiting = true
  }

  connectWith(token: string): void {
    if (this.finished) return
    this.waiting = false
    this.apiKey = token
    this.start()
  }

  /** The credential couldn't be had: end with an error. */
  failWith(message: string): void {
    this.fail(message)
  }

  get done(): boolean {
    return this.finished
  }

  start(): void {
    let socket: SocketLike
    try {
      // Browsers and Node can't set headers on a WebSocket; Deepgram accepts the key as a subprotocol.
      socket = this.makeSocket(DEEPGRAM_URL, [this.scheme, this.apiKey])
    } catch (err) {
      return this.fail(`Couldn't connect to Deepgram: ${errorText(err)}`)
    }
    this.socket = socket
    socket.binaryType = 'arraybuffer'
    this.later(TIMEOUTS.connect, () => {
      if (socket.readyState !== OPEN) this.fail("Couldn't reach Deepgram. Check your internet connection.")
    })
    this.later(TIMEOUTS.maxLength, () => this.stop())

    socket.onopen = () => {
      if (this.finished) return
      for (const chunk of this.queue) socket.send(chunk)
      this.queue = []
      this.queuedBytes = 0
      this.events.state({ id: this.id, state: 'listening' })
      this.noSpeechTimer = this.later(TIMEOUTS.noSpeech, () => {
        if (!this.text()) this.finish('no-speech')
      })
      if (this.stopping) this.finalizeSoon() // stop was pressed while connecting
    }
    socket.onmessage = (ev) => this.onMessage(ev.data)
    socket.onerror = () => {
      if (!this.finished && !this.stopping) this.failOrKeep('Lost the connection to Deepgram.')
    }
    socket.onclose = (ev) => {
      if (this.finished) return
      if (this.stopping) return this.finish('done')
      if (ev.code === 1008 || ev.code === 4001 || ev.code === 4008) {
        return this.fail('Deepgram rejected the key. Check DEEPGRAM_API_KEY in your .env file.')
      }
      this.failOrKeep('Lost the connection to Deepgram.')
    }
  }

  audio(chunk: ArrayBufferView): void {
    if (this.finished || chunk.byteLength === 0) return
    const socket = this.socket
    if (socket && socket.readyState === OPEN) {
      socket.send(chunk)
    } else if (this.queuedBytes + chunk.byteLength <= MAX_QUEUED_BYTES) {
      this.queue.push(chunk)
      this.queuedBytes += chunk.byteLength
    }
  }

  /** The student pressed stop: flush what Deepgram has, then send the final transcript. */
  stop(): void {
    if (this.finished || this.stopping) return
    this.stopping = true
    this.clearNoSpeech()
    if (!this.socket) return this.waiting ? undefined : this.finish('no-speech') // waiting: finalized on open
    // Still connecting: the queued audio goes out on open, then we finalize.
    if (this.socket.readyState === OPEN) this.finalizeSoon()
  }

  /** Drop the utterance: no transcript is sent. */
  cancel(): void {
    if (this.finished) return
    this.finished = true
    this.events.state({ id: this.id, state: 'closed', reason: 'cancelled' })
    this.teardown()
  }

  // ---------- internals ----------

  private onMessage(data: unknown): void {
    if (this.finished || typeof data !== 'string') return
    let msg: DeepgramMessage
    try {
      msg = JSON.parse(data) as DeepgramMessage
    } catch {
      return
    }
    if (msg.type === 'Results') {
      const said = (msg.channel?.alternatives?.[0]?.transcript ?? '').trim()
      if (msg.is_final) {
        if (said) this.committed.push(said)
        this.interim = ''
      } else {
        this.interim = said
      }
      if (said) this.clearNoSpeech()
      if (said || msg.is_final) this.events.transcript({ id: this.id, text: this.text(), interim: this.interim, final: false })
      // The student paused long enough: the utterance is over.
      if (msg.speech_final && this.committed.length > 0 && !this.stopping) this.finish('done')
      // Deepgram's answer to our Finalize: everything said has been transcribed.
      else if (msg.from_finalize && this.stopping) this.finish('done')
    } else if (msg.type === 'UtteranceEnd') {
      if (this.committed.length > 0 && !this.stopping) this.finish('done')
    }
  }

  private text(): string {
    return [...this.committed, this.interim].filter(Boolean).join(' ').trim()
  }

  /** Send the final transcript (once), then close. */
  private finish(reason: 'done' | 'no-speech'): void {
    if (this.finished) return
    this.finished = true
    const text = this.text()
    if (reason === 'done' && text) {
      this.events.transcript({ id: this.id, text, interim: '', final: true })
      this.events.state({ id: this.id, state: 'closed', reason: 'done' })
    } else {
      this.events.state({ id: this.id, state: 'closed', reason: 'no-speech' })
    }
    this.teardown()
  }

  /** The connection broke. Keep what was already heard instead of throwing it away. */
  private failOrKeep(message: string): void {
    if (this.committed.length > 0) this.finish('done')
    else this.fail(message)
  }

  private fail(message: string): void {
    if (this.finished) return
    this.finished = true
    this.events.state({ id: this.id, state: 'error', message })
    this.teardown()
  }

  /** Ask Deepgram to flush its last words; don't wait for them forever. */
  private finalizeSoon(): void {
    try {
      this.socket?.send(JSON.stringify({ type: 'Finalize' }))
    } catch {
      // the close handler deals with a broken socket
    }
    this.later(TIMEOUTS.finalize, () => this.finish('done'))
  }

  private teardown(): void {
    for (const t of this.timers) clearTimeout(t)
    this.timers = []
    this.noSpeechTimer = null
    this.queue = []
    const socket = this.socket
    this.socket = null
    if (!socket) return
    socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null
    try {
      if (socket.readyState === OPEN) socket.send(JSON.stringify({ type: 'CloseStream' }))
      socket.close(1000)
    } catch {
      // already closed
    }
  }

  private clearNoSpeech(): void {
    if (this.noSpeechTimer) clearTimeout(this.noSpeechTimer)
    this.noSpeechTimer = null
  }

  private later(ms: number, fn: () => void): ReturnType<typeof setTimeout> {
    const t = setTimeout(fn, ms)
    this.timers.push(t)
    return t
  }
}

interface DeepgramMessage {
  type?: string
  is_final?: boolean
  speech_final?: boolean
  from_finalize?: boolean
  channel?: { alternatives?: { transcript?: string }[] }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ---------- the one active utterance ----------

const ID = /^[A-Za-z0-9-]{1,64}$/
export const MAX_CHUNK_BYTES = 512 * 1024

/** Keeps at most one utterance open and checks everything the UI sends. */
export class VoiceManager {
  private current: Utterance | null = null

  constructor(
    private readonly deps: {
      apiKey: () => string | undefined
      /** Signed in to Clueless: a short-lived Deepgram token from the server (used when there's no key). */
      serverToken?: () => Promise<{ token: string } | { error: string }> | null
      events: VoiceEvents
      makeSocket: SocketFactory
    }
  ) {}

  start(id: unknown): void {
    if (typeof id !== 'string' || !ID.test(id)) return
    this.cancelAll() // a new press replaces whatever was open
    const key = this.deps.apiKey()
    const fromServer = key ? null : this.deps.serverToken?.()
    if (fromServer) {
      const utterance = new Utterance(id, '', this.deps.events, this.deps.makeSocket, 'bearer')
      utterance.awaitCredential()
      this.current = utterance
      fromServer.then(
        (got) => ('token' in got ? utterance.connectWith(got.token) : utterance.failWith(got.error)),
        () => utterance.failWith("Couldn't reach Clueless. Check your internet connection.")
      )
      return
    }
    if (!key) {
      this.deps.events.state({
        id,
        state: 'error',
        message: 'Voice needs a Deepgram key. Add DEEPGRAM_API_KEY to your .env file.'
      })
      return
    }
    const utterance = new Utterance(id, key, this.deps.events, this.deps.makeSocket)
    this.current = utterance
    utterance.start()
  }

  audio(id: unknown, chunk: unknown): void {
    const u = this.match(id)
    const bytes = toBytes(chunk)
    if (u && bytes && bytes.byteLength <= MAX_CHUNK_BYTES) u.audio(bytes)
  }

  stop(id: unknown): void {
    this.match(id)?.stop()
  }

  cancel(id: unknown): void {
    this.match(id)?.cancel()
  }

  /** Window closed, app quitting, or a new recording: close everything. */
  cancelAll(): void {
    this.current?.cancel()
    this.current = null
  }

  private match(id: unknown): Utterance | null {
    const u = this.current
    return u && !u.done && u.id === id ? u : null
  }
}

function toBytes(chunk: unknown): ArrayBufferView | null {
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk)
  if (ArrayBuffer.isView(chunk)) return chunk
  return null
}
