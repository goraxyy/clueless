import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VoiceStateEvent, VoiceTranscript } from '../../shared/contracts'
import { TIMEOUTS, VoiceManager, type SocketLike } from './deepgram'

class FakeSocket implements SocketLike {
  readyState = 0
  binaryType = 'blob'
  sent: unknown[] = []
  closed = false
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  onclose: ((ev: { code?: number }) => void) | null = null
  constructor(
    readonly url: string,
    readonly protocols: string[]
  ) {}
  send(data: unknown): void {
    this.sent.push(data)
  }
  close(): void {
    this.closed = true
    this.readyState = 3
  }
  open(): void {
    this.readyState = 1
    this.onopen?.({})
  }
  results(transcript: string, flags: { is_final?: boolean; speech_final?: boolean; from_finalize?: boolean } = {}): void {
    this.onmessage?.({
      data: JSON.stringify({ type: 'Results', channel: { alternatives: [{ transcript }] }, ...flags })
    })
  }
  controls(): string[] {
    return this.sent.filter((d): d is string => typeof d === 'string').map((d) => JSON.parse(d).type)
  }
}

function setup(key: string | null = 'dg-key') {
  const sockets: FakeSocket[] = []
  const transcripts: VoiceTranscript[] = []
  const states: VoiceStateEvent[] = []
  const voice = new VoiceManager({
    apiKey: () => key ?? undefined,
    events: { transcript: (t) => transcripts.push(t), state: (e) => states.push(e) },
    makeSocket: (url, protocols) => {
      const s = new FakeSocket(url, protocols)
      sockets.push(s)
      return s
    }
  })
  const finals = () => transcripts.filter((t) => t.final)
  return { voice, sockets, transcripts, states, finals }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('VoiceManager / Utterance', () => {
  it('keeps the key in the subprotocol, buffers audio until open, and streams live text', () => {
    const { voice, sockets, transcripts, states } = setup()
    voice.start('u1')
    const s = sockets[0]
    expect(s.protocols).toEqual(['token', 'dg-key'])
    expect(s.url).not.toContain('dg-key')
    voice.audio('u1', new Uint8Array([1, 2, 3]).buffer)
    expect(s.sent).toHaveLength(0)
    s.open()
    expect(s.sent).toHaveLength(1) // the queued chunk
    expect(states).toEqual([{ id: 'u1', state: 'listening' }])
    s.results('I think we')
    expect(transcripts.at(-1)).toEqual({ id: 'u1', text: 'I think we', interim: 'I think we', final: false })
  })

  it('a short pause does not split the sentence; the end of speech sends one final transcript', () => {
    const { voice, sockets, finals, states } = setup()
    voice.start('u1')
    const s = sockets[0]
    s.open()
    s.results('I think we should use a hashmap', { is_final: true })
    s.results('because we need', {})
    expect(finals()).toHaveLength(0)
    s.results('because we need to track frequencies', { is_final: true, speech_final: true })
    expect(finals()).toEqual([
      { id: 'u1', text: 'I think we should use a hashmap because we need to track frequencies', interim: '', final: true }
    ])
    expect(states.at(-1)).toEqual({ id: 'u1', state: 'closed', reason: 'done' })
    expect(s.closed).toBe(true)
    expect(s.controls()).toContain('CloseStream')
    // Anything after the end (UtteranceEnd, a late stop) never sends a second final.
    s.onmessage?.({ data: JSON.stringify({ type: 'UtteranceEnd' }) })
    voice.stop('u1')
    expect(finals()).toHaveLength(1)
  })

  it('UtteranceEnd also ends it', () => {
    const { voice, sockets, finals } = setup()
    voice.start('u1')
    sockets[0].open()
    sockets[0].results('use two pointers', { is_final: true })
    sockets[0].onmessage?.({ data: JSON.stringify({ type: 'UtteranceEnd' }) })
    expect(finals().map((t) => t.text)).toEqual(['use two pointers'])
  })

  it('manual stop finalizes and sends the words Deepgram flushes', () => {
    const { voice, sockets, finals } = setup()
    voice.start('u1')
    const s = sockets[0]
    s.open()
    s.results('maybe a set', {})
    voice.stop('u1')
    expect(s.controls()).toContain('Finalize')
    s.results('maybe a set of seen numbers', { is_final: true, from_finalize: true })
    expect(finals().map((t) => t.text)).toEqual(['maybe a set of seen numbers'])
  })

  it('manual stop keeps the interim words if Deepgram never answers', () => {
    const { voice, sockets, finals } = setup()
    voice.start('u1')
    sockets[0].open()
    sockets[0].results('x equals two', {})
    voice.stop('u1')
    vi.advanceTimersByTime(TIMEOUTS.finalize)
    expect(finals().map((t) => t.text)).toEqual(['x equals two'])
  })

  it('stop while still connecting waits for the connection, then finalizes', () => {
    const { voice, sockets, finals } = setup()
    voice.start('u1')
    voice.audio('u1', new Uint8Array([9]))
    voice.stop('u1')
    const s = sockets[0]
    s.open()
    expect(s.controls()).toContain('Finalize')
    s.results('hello', { is_final: true, from_finalize: true })
    expect(finals().map((t) => t.text)).toEqual(['hello'])
  })

  it('silence: no transcript, closes with no-speech', () => {
    const { voice, sockets, finals, states } = setup()
    voice.start('u1')
    sockets[0].open()
    vi.advanceTimersByTime(TIMEOUTS.noSpeech)
    expect(finals()).toHaveLength(0)
    expect(states.at(-1)).toEqual({ id: 'u1', state: 'closed', reason: 'no-speech' })
  })

  it('stop with only noise sends nothing', () => {
    const { voice, sockets, finals, states } = setup()
    voice.start('u1')
    sockets[0].open()
    voice.stop('u1')
    sockets[0].results('', { is_final: true, from_finalize: true })
    expect(finals()).toHaveLength(0)
    expect(states.at(-1)).toMatchObject({ state: 'closed', reason: 'no-speech' })
  })

  it('cancel drops the transcript', () => {
    const { voice, sockets, finals, states } = setup()
    voice.start('u1')
    sockets[0].open()
    sockets[0].results('never mind', { is_final: true })
    voice.cancel('u1')
    expect(finals()).toHaveLength(0)
    expect(states.at(-1)).toEqual({ id: 'u1', state: 'closed', reason: 'cancelled' })
    expect(sockets[0].closed).toBe(true)
  })

  it('connection timeout and a dropped connection become errors', () => {
    const a = setup()
    a.voice.start('u1')
    vi.advanceTimersByTime(TIMEOUTS.connect)
    expect(a.states.at(-1)).toMatchObject({ id: 'u1', state: 'error' })

    const b = setup()
    b.voice.start('u2')
    b.sockets[0].open()
    b.sockets[0].onclose?.({ code: 1006 })
    expect(b.states.at(-1)).toMatchObject({ id: 'u2', state: 'error' })
  })

  it('a dropped connection keeps words already final', () => {
    const { voice, sockets, finals } = setup()
    voice.start('u1')
    sockets[0].open()
    sockets[0].results('the answer is', { is_final: true })
    sockets[0].onclose?.({ code: 1006 })
    expect(finals().map((t) => t.text)).toEqual(['the answer is'])
  })

  it('a new start replaces the old one, and stale ids are ignored', () => {
    const { voice, sockets, finals, states } = setup()
    voice.start('u1')
    sockets[0].open()
    voice.start('u2')
    expect(states).toContainEqual({ id: 'u1', state: 'closed', reason: 'cancelled' })
    expect(sockets[0].closed).toBe(true)
    sockets[1].open()
    voice.audio('u1', new Uint8Array([1]))
    voice.stop('u1')
    expect(sockets[1].sent).toHaveLength(0)
    expect(finals()).toHaveLength(0)
  })

  it('validates ids and chunks, and reports a missing key', () => {
    const { voice, sockets } = setup()
    voice.start('bad id with spaces')
    voice.start(42)
    expect(sockets).toHaveLength(0)
    voice.start('u1')
    sockets[0].open()
    voice.audio('u1', 'not bytes')
    voice.audio('u1', new Uint8Array(600 * 1024))
    expect(sockets[0].sent).toHaveLength(0)

    const noKey = setup(null)
    noKey.voice.start('u1')
    expect(noKey.sockets).toHaveLength(0)
    expect(noKey.states[0]).toMatchObject({ state: 'error' })
  })
})

describe('with a Clueless account (no key on the laptop)', () => {
  function tokenSetup(answer: () => Promise<{ token: string } | { error: string }>) {
    const sockets: { url: string; protocols: string[]; headers?: Record<string, string>; s: FakeSocket }[] = []
    const transcripts: VoiceTranscript[] = []
    const states: VoiceStateEvent[] = []
    const voice = new VoiceManager({
      apiKey: () => undefined,
      token: answer,
      events: { transcript: (t) => transcripts.push(t), state: (e) => states.push(e) },
      makeSocket: (url, protocols, headers) => {
        const s = new FakeSocket(url, protocols)
        sockets.push({ url, protocols, headers, s })
        return s
      }
    })
    return { voice, sockets, transcripts, states }
  }

  it("records straight away, then connects with the server's token as a header", async () => {
    let give: (v: { token: string }) => void = () => {}
    const { voice, sockets, states } = tokenSetup(() => new Promise((r) => (give = r)))
    voice.start('u1')
    voice.audio('u1', new Uint8Array([1, 2]).buffer) // said before the token arrived
    expect(sockets).toHaveLength(0)
    give({ token: 'jwt-123' })
    await Promise.resolve()
    expect(sockets[0].protocols).toEqual([])
    expect(sockets[0].headers).toEqual({ Authorization: 'Bearer jwt-123' })
    sockets[0].s.open()
    expect(sockets[0].s.sent).toHaveLength(1) // the early audio wasn't lost
    expect(states.at(-1)).toEqual({ id: 'u1', state: 'listening' })
  })

  it('a stop pressed before the token arrives still sends what was said', async () => {
    let give: (v: { token: string }) => void = () => {}
    const { voice, sockets, finals } = (() => {
      const t = tokenSetup(() => new Promise((r) => (give = r)))
      return { ...t, finals: () => t.transcripts.filter((x) => x.final) }
    })()
    voice.start('u1')
    voice.audio('u1', new Uint8Array([1]).buffer)
    voice.stop('u1')
    give({ token: 'jwt' })
    await Promise.resolve()
    const s = sockets[0].s
    s.open()
    expect(s.controls()).toContain('Finalize')
    s.results('two times x', { is_final: true, from_finalize: true })
    expect(finals().map((t) => t.text)).toEqual(['two times x'])
  })

  it("shows the server's reason when it says no", async () => {
    const { voice, sockets, states } = tokenSetup(async () => ({ error: "You've used this week's 300 voice messages. Type instead until Monday." }))
    voice.start('u1')
    await Promise.resolve()
    await Promise.resolve()
    expect(sockets).toHaveLength(0)
    expect(states.at(-1)).toEqual({ id: 'u1', state: 'error', message: "You've used this week's 300 voice messages. Type instead until Monday." })
  })
})
