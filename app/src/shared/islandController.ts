// The island's state machine: highlight -> Ask or Animate -> thinking -> the answer in the panel.
// Animate also plays the answer step by step: in the visual island (its own window, with the
// picture and the controls) and highlighted on the student's code. It paces the animation: one
// step at a time at the chosen speed, or, with voice on, the next step once the visual island has
// finished reading the current one aloud.
// No Electron or Node imports, so the tests run it with a fake tracer and timers.
import { SPEEDS, stepCount, type CodeSpot, type IslandView } from './contracts'
import type { TraceReply } from './trace'

export interface ScreenImage {
  data: string // base64, no data: prefix
  mediaType: 'image/jpeg' | 'image/png'
}

export interface AskInput {
  snippet: string // the highlighted text, as copied
  image: ScreenImage | null // the whole screen, for context
  animate: boolean
}

/** One conversation with Claude about one highlight. */
export interface TracerLike {
  ask(input: AskInput): Promise<TraceReply>
  followUp(text: string, animate: boolean): Promise<TraceReply>
}

/** What a capture finds: the screen for Claude, and where the highlight sits on it. */
export interface IslandCapture {
  image: ScreenImage | null
  spot: CodeSpot | null
}

export interface IslandDeps {
  /** A fresh conversation for a new highlight, or null when no Claude credentials are set up. */
  makeTracer(): TracerLike | null
  /** A screenshot of the screen the student is working on (Clueless's own windows hidden). */
  capture(snippet: string): Promise<IslandCapture>
  emit(view: IslandView): void
  /** Run `fn` after `ms`; returns a cancel function. */
  schedule(fn: () => void, ms: number): () => void
  now(): number
}

/** Before step 1 (voice off): time to read the answer and spot the highlight on the code. */
export const INTRO_MS = 1800
/** One code step at 1x, voice off. */
export const STEP_MS = 2000
/** Voice off: a lesson step stays long enough to read what it says (per word, at 1x). */
export const READ_MS_PER_WORD = 330
/** Voice on: a step stays at least this long at 1x, even if its line is short. */
export const MIN_STEP_MS = 700
/** Voice on: never wait longer than this for a step's narration at 1x (the voice may fail). */
export const MAX_STEP_MS = 12_000
/** Voice on: the intro reads the whole answer first. */
export const MAX_INTRO_MS = 30_000

export const NO_KEY_MESSAGE =
  'Add your Claude key first: put ANTHROPIC_API_KEY (or the AWS Bedrock lines) in app/.env, then try again.'

export const SCROLLED_NOTICE = 'The page moved, so the highlight on your code is off. Scroll back and press Replay to see it again.'

/** What stays the same from one question to the next. */
type Prefs = Pick<IslandView, 'askOnHighlight' | 'speed' | 'voice'>

export class IslandController {
  private view: IslandView
  private tracer: TracerLike | null = null
  private run = 0 // bumps on every new request / close, so stale replies are dropped
  private nonce = 0
  private cancelTimer: (() => void) | null = null
  private narrated = false
  private stepStarted = 0

  constructor(private readonly deps: IslandDeps) {
    this.view = idleView({ askOnHighlight: true, speed: 1, voice: true })
  }

  get current(): IslandView {
    return structuredClone(this.view)
  }

  setAskOnHighlight(on: boolean): void {
    this.view.askOnHighlight = on
    this.emit()
  }

  /** The visual island's speed button. The current step is re-timed from now. */
  setSpeed(speed: number): void {
    if (!SPEEDS.includes(speed as (typeof SPEEDS)[number]) || speed === this.view.speed) return
    this.view.speed = speed
    if (this.view.playback?.playing) this.scheduleNext()
    this.emit()
  }

  /** The visual island's voice button: read each step aloud (it reports back with setNarrated). */
  setVoice(on: boolean): void {
    if (this.view.voice === on) return
    this.view.voice = on
    this.emit()
  }

  /** The visual island reads steps aloud and reports when each one is done. */
  setNarrated(on: boolean): void {
    if (this.narrated === on) return
    this.narrated = on
    if (this.view.playback?.playing) this.scheduleNext() // re-time the current step
  }

  /** The student clicked Ask (explain it) or Animate (explain it with an animation and voice) on a highlight. */
  async ask(snippet: string, animate: boolean): Promise<void> {
    if (!snippet.trim()) return
    const run = this.restart()
    const tracer = this.deps.makeTracer()
    this.tracer = tracer
    this.view = { ...idleView(this.prefs()), animate, phase: 'thinking', snippet, busySince: this.deps.now() }
    this.emit()
    if (!tracer) return this.fail(run, NO_KEY_MESSAGE)
    await this.attempt(run, animate, async () => {
      const { image, spot } = await this.deps.capture(snippet)
      if (run !== this.run) return null
      this.view.spot = spot
      return tracer.ask({ snippet, image, animate })
    })
  }

  /** A typed follow-up about the same highlight. */
  async followUp(text: string): Promise<void> {
    const tracer = this.tracer
    if (!tracer || this.view.phase !== 'answer' || !text.trim()) return
    const run = this.restart()
    const animate = this.view.animate
    this.view.messages.push({ role: 'student', text })
    this.view.phase = 'thinking'
    this.view.error = null
    this.view.notice = null
    this.view.playback = null
    this.view.busySince = this.deps.now()
    this.emit()
    await this.attempt(run, animate, () => tracer.followUp(text, animate))
  }

  /** ✕ on the Ask card, a new session, Hide: nothing asked any more. Anything in flight is dropped. */
  close(): void {
    this.restart()
    this.tracer = null
    this.view = idleView(this.prefs())
    this.emit()
  }

  // ---------- the animation ----------

  play(): void {
    const p = this.view.playback
    if (!p) return this.replay()
    if (p.playing) return
    if (p.index >= this.lastIndex()) return this.replay()
    p.playing = true
    this.scheduleNext()
    this.emit()
  }

  pause(): void {
    const p = this.view.playback
    if (!p?.playing) return
    this.cancel()
    p.playing = false
    this.emit()
  }

  /** Step back or forward by hand (pauses). */
  step(delta: number): void {
    const p = this.view.playback
    if (!p) return
    this.cancel()
    p.playing = false
    p.index = Math.max(0, Math.min(this.lastIndex(), p.index + Math.sign(delta)))
    this.emit()
  }

  replay(): void {
    if (!stepCount(this.view) || this.view.phase !== 'answer') return
    this.view.notice = null
    this.view.spotLost = false
    this.startPlayback()
  }

  /** Take the animation off the screen; the text stays. */
  stopPlayback(emit = true): void {
    if (!this.view.playback) return
    this.cancel()
    this.view.playback = null
    if (emit) this.emit()
  }

  /** The visual island finished reading step `index` aloud. */
  stepDone(nonce: number, index: number): void {
    const p = this.view.playback
    if (!this.narrated || !p?.playing || p.nonce !== nonce || p.index !== index) return
    const left = Math.max(0, MIN_STEP_MS / this.view.speed - (this.deps.now() - this.stepStarted))
    this.after(left, () => this.advance())
  }

  /** The student scrolled: the highlight would no longer line up with the code. The visual
   *  island doesn't depend on where the code is, so it plays on. */
  scrolled(): void {
    if (!this.view.playback || !this.view.spot || this.view.spotLost) return
    this.view.spotLost = true
    this.view.notice = SCROLLED_NOTICE
    this.emit()
  }

  // ---------- internals ----------

  private startPlayback(): void {
    this.cancel()
    this.view.playback = { nonce: ++this.nonce, index: -1, playing: true }
    this.scheduleNext()
    this.emit()
  }

  /** Time the current step at the chosen speed: long enough to take it in, or (voice on) until
   *  its narration ends, with a safety limit. */
  private scheduleNext(): void {
    const p = this.view.playback
    if (!p) return
    this.stepStarted = this.deps.now()
    const said = p.index >= 0 ? this.view.lesson?.steps[p.index]?.say : undefined
    const reading = said ? said.split(/\s+/).length * READ_MS_PER_WORD : 0
    const ms = this.narrated
      ? p.index < 0
        ? MAX_INTRO_MS
        : Math.max(MAX_STEP_MS, reading * 2)
      : p.index < 0
        ? INTRO_MS
        : Math.max(STEP_MS, reading)
    this.after(ms / this.view.speed, () => this.advance())
  }

  private advance(): void {
    const p = this.view.playback
    if (!p?.playing) return
    if (p.index < this.lastIndex()) p.index++
    if (p.index < this.lastIndex()) this.scheduleNext()
    else this.finish()
    this.emit()
  }

  /** On the last step: stop there. It stays up (to step back through it) until Stop. */
  private finish(): void {
    const p = this.view.playback
    if (p) p.playing = false
  }

  private lastIndex(): number {
    return stepCount(this.view) - 1
  }

  private prefs(): Prefs {
    const { askOnHighlight, speed, voice } = this.view
    return { askOnHighlight, speed, voice }
  }

  private async attempt(run: number, animate: boolean, call: () => Promise<TraceReply | null>): Promise<void> {
    let reply: TraceReply | null
    try {
      reply = await call()
    } catch (err) {
      if (run === this.run) this.fail(run, err instanceof Error ? err.message : String(err))
      return
    }
    if (!reply || run !== this.run) return
    const view = this.view
    view.busySince = null
    view.messages.push({ role: 'clueless', text: reply.message || "I couldn't find anything to explain there." })
    view.trace = reply.trace
    view.lesson = reply.lesson
    view.spotLost = false
    view.phase = 'answer'
    if (animate && stepCount(view)) this.startPlayback()
    else this.emit()
  }

  private fail(run: number, message: string): void {
    if (run !== this.run) return
    this.view.busySince = null
    this.view.error = message
    this.view.phase = 'answer'
    this.emit()
  }

  private after(ms: number, fn: () => void): void {
    this.cancelTimer?.()
    const cancel = this.deps.schedule(() => {
      if (this.cancelTimer === cancel) this.cancelTimer = null
      fn()
    }, ms)
    this.cancelTimer = cancel
  }

  private cancel(): void {
    this.cancelTimer?.()
    this.cancelTimer = null
  }

  private restart(): number {
    this.cancel()
    return ++this.run
  }

  private emit(): void {
    this.deps.emit(structuredClone(this.view))
  }
}

function idleView(prefs: Prefs): IslandView {
  return {
    ...prefs,
    animate: false,
    phase: 'idle',
    snippet: null,
    messages: [],
    trace: null,
    lesson: null,
    spot: null,
    spotLost: false,
    playback: null,
    busySince: null,
    error: null,
    notice: null
  }
}
