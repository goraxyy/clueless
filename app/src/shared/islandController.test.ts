import { describe, expect, it } from 'vitest'
import type { IslandView } from './contracts'
import {
  INTRO_MS,
  IslandController,
  MIN_STEP_MS,
  NO_KEY_MESSAGE,
  READ_MS_PER_WORD,
  SCROLLED_NOTICE,
  STEP_MS,
  type AskInput,
  type TracerLike
} from './islandController'
import type { CodeTrace, Lesson, TraceReply } from './trace'

const TRACE: CodeTrace = {
  language: 'python',
  code: 'n = 5',
  entities: [{ id: 'n', name: 'n', kind: 'value', indexOf: null }],
  steps: [
    {
      line: 1,
      endLine: 1,
      focus: '',
      kind: 'declare',
      result: '',
      reads: [],
      updates: [{ entity: 'n', value: { scalar: '5', items: [], entries: [], rows: [] } }]
    },
    { line: 1, endLine: 1, focus: '', kind: 'other', result: '', reads: ['n'], updates: [] }
  ]
}

const LESSON: Lesson = {
  text: 'Find the area under y = x^2 from 0 to 1.',
  steps: [
    {
      line: 1,
      endLine: 1,
      say: 'The area is the sum of many thin strips under the curve, each one a little taller than the last.',
      scene: { type: 'numberline', min: 0, max: 1, marks: [{ x: 0.5, label: 'strip' }] }
    },
    { line: null, endLine: null, say: 'Add them up.', scene: { type: 'numberline', min: 0, max: 1, marks: [] } }
  ]
}

const SPOT = { displayId: 1, left: 100, width: 300, top: 200, lineHeight: 20, lines: 1 }

const reply = (message: string, trace: CodeTrace | null = null, lesson: Lesson | null = null): TraceReply => ({ message, trace, lesson })

class FakeTracer implements TracerLike {
  asked: AskInput[] = []
  followUps: string[] = []
  replies: TraceReply[] = []
  pending: ((r: TraceReply) => void) | null = null
  hold = false
  async ask(input: AskInput): Promise<TraceReply> {
    this.asked.push(input)
    return this.next()
  }
  async followUp(text: string): Promise<TraceReply> {
    this.followUps.push(text)
    return this.next()
  }
  private next(): Promise<TraceReply> {
    if (this.hold) return new Promise((r) => (this.pending = r))
    return Promise.resolve(this.replies.shift() ?? reply('Plain text.'))
  }
}

function setup(opts: { tracer?: FakeTracer | null } = {}) {
  const tracer = opts.tracer === undefined ? new FakeTracer() : opts.tracer
  const views: IslandView[] = []
  const timers: { fn: () => void; ms: number; cancelled: boolean }[] = []
  let now = 1000
  const controller = new IslandController({
    makeTracer: () => tracer,
    capture: async () => ({ image: { data: 'SCREEN', mediaType: 'image/jpeg' }, spot: SPOT }),
    emit: (v) => views.push(v),
    schedule: (fn, ms) => {
      const t = { fn, ms, cancelled: false }
      timers.push(t)
      return () => (t.cancelled = true)
    },
    now: () => now
  })
  const pending = () => timers.filter((t) => !t.cancelled)
  const fire = (): number => {
    const t = pending()[0]
    if (!t) throw new Error('no timer pending')
    t.cancelled = true
    now += t.ms
    t.fn()
    return t.ms
  }
  return { tracer, views, pending, controller, fire, last: () => views[views.length - 1], wait: (ms: number) => (now += ms) }
}

describe('IslandController', () => {
  it('Animate: thinking -> the answer and the animation, step by step; it stays on the last step until Stop', async () => {
    const { controller, tracer, views, fire, pending, last } = setup()
    tracer!.replies.push(reply('Watch `n`.', TRACE))
    await controller.ask('n = 5', true)
    expect(views[0]).toMatchObject({ phase: 'thinking', animate: true })
    expect(tracer!.asked[0]).toEqual({ snippet: 'n = 5', image: { data: 'SCREEN', mediaType: 'image/jpeg' }, animate: true })
    expect(last()).toMatchObject({ phase: 'answer', spot: SPOT, playback: { index: -1, playing: true } })
    expect(last().messages).toEqual([{ role: 'clueless', text: 'Watch `n`.' }])
    expect(fire()).toBe(INTRO_MS)
    expect(last().playback).toMatchObject({ index: 0, playing: true })
    expect(fire()).toBe(STEP_MS)
    expect(last().playback).toMatchObject({ index: 1, playing: false }) // finished on the last step
    expect(pending()).toHaveLength(0) // and it stays there
    controller.step(-1)
    expect(last().playback).toMatchObject({ index: 0, playing: false }) // go back through it
    controller.stopPlayback()
    expect(last()).toMatchObject({ phase: 'answer', playback: null }) // the text stays
    controller.replay()
    expect(last().playback).toMatchObject({ index: -1, playing: true })
    controller.close()
    expect(last()).toMatchObject({ phase: 'idle', playback: null, messages: [] })
  })

  it('pause, step by hand, and play on', async () => {
    const { controller, tracer, pending, fire, last } = setup()
    tracer!.replies.push(reply('Watch.', TRACE))
    await controller.ask('n = 5', true)
    fire() // intro over
    controller.pause()
    expect(last().playback).toMatchObject({ index: 0, playing: false })
    expect(pending()).toHaveLength(0)
    controller.step(+1)
    expect(last().playback?.index).toBe(1)
    controller.step(+1)
    expect(last().playback?.index).toBe(1) // stays on the last step
    controller.step(-1)
    controller.play()
    expect(last().playback).toMatchObject({ index: 0, playing: true })
    fire()
    expect(last().playback).toMatchObject({ index: 1, playing: false })
  })

  it('the speed button changes how long each step stays, from now', async () => {
    const { controller, tracer, pending, fire, last } = setup()
    tracer!.replies.push(reply('Watch.', TRACE))
    await controller.ask('n = 5', true)
    controller.setSpeed(2)
    expect(last().speed).toBe(2)
    expect(pending()).toHaveLength(1) // the current step was re-timed, not doubled up
    expect(fire()).toBe(INTRO_MS / 2)
    controller.setSpeed(0.5)
    expect(fire()).toBe(STEP_MS * 2)
    controller.setSpeed(3) // not one of the speeds: ignored
    expect(last().speed).toBe(0.5)
  })

  it('with voice on, a step lasts until the visual island has read it aloud (but never less than a moment)', async () => {
    const { controller, tracer, pending, fire, wait, last } = setup()
    controller.setNarrated(true)
    tracer!.replies.push(reply('Watch.', TRACE))
    await controller.ask('n = 5', true)
    const nonce = last().playback!.nonce
    controller.stepDone(nonce, -1) // the intro was read
    expect(fire()).toBe(MIN_STEP_MS) // no time had passed: wait the minimum
    expect(last().playback?.index).toBe(0)
    controller.stepDone(nonce + 1, 0) // an old run's narration: ignored
    expect(pending().at(-1)?.ms).toBeGreaterThan(MIN_STEP_MS) // still the long safety timer
    wait(1500)
    controller.stepDone(nonce, 0)
    expect(fire()).toBe(0) // read for longer than the minimum: go on right away
    expect(last().playback).toMatchObject({ index: 1, playing: false })
  })

  it('a concept lesson plays like a trace, each step long enough to read what it says', async () => {
    const { controller, tracer, fire, last } = setup()
    tracer!.replies.push(reply('Watch the strips add up.', null, LESSON))
    await controller.ask(LESSON.text, true)
    expect(last()).toMatchObject({ lesson: LESSON, trace: null, playback: { index: -1, playing: true } })
    fire() // intro
    expect(fire()).toBe(LESSON.steps[0].say.split(' ').length * READ_MS_PER_WORD) // a long line stays longer
    expect(last().playback).toMatchObject({ index: 1, playing: false })
  })

  it('a scroll hides the highlight on the code but the island plays on; Replay brings the highlight back', async () => {
    const { controller, tracer, pending, last } = setup()
    tracer!.replies.push(reply('Watch.', TRACE))
    await controller.ask('n = 5', true)
    controller.scrolled()
    expect(last()).toMatchObject({ spotLost: true, notice: SCROLLED_NOTICE, playback: { playing: true } })
    expect(pending()).toHaveLength(1)
    controller.replay()
    expect(last()).toMatchObject({ spotLost: false, notice: null, playback: { index: -1 } })
  })

  it('Ask: text only, and follow-ups continue the conversation', async () => {
    const { controller, tracer, pending, last } = setup()
    tracer!.replies.push(reply('It sets n.', TRACE))
    await controller.ask('n = 5', false)
    expect(last()).toMatchObject({ phase: 'answer', playback: null, animate: false })
    expect(tracer!.asked[0].animate).toBe(false)
    expect(pending()).toHaveLength(0)
    await controller.followUp('why 5?')
    expect(tracer!.followUps).toEqual(['why 5?'])
    expect(last().messages.map((m) => m.role)).toEqual(['clueless', 'student', 'clueless'])
  })

  it('animates even when the highlight could not be found on screen (the island needs no position)', async () => {
    const { controller, tracer, last } = setup()
    tracer!.replies.push(reply('Watch.', TRACE))
    await controller.ask('n = 5', true)
    expect(last().playback).not.toBeNull()
  })

  it('drops a reply that arrives after the card was closed', async () => {
    const { controller, tracer, last } = setup()
    tracer!.hold = true
    const asking = controller.ask('n = 5', true)
    await Promise.resolve()
    await Promise.resolve()
    controller.close()
    tracer!.pending?.(reply('late', TRACE))
    await asking
    expect(last().phase).toBe('idle')
    expect(last().messages).toEqual([])
  })

  it('explains what to do when there is no Claude key', async () => {
    const { controller, last } = setup({ tracer: null })
    await controller.ask('n = 5', false)
    expect(last()).toMatchObject({ phase: 'answer', error: NO_KEY_MESSAGE })
  })

  it('keeps the switch, the speed and the voice setting across questions', async () => {
    const { controller, last } = setup()
    controller.setAskOnHighlight(false)
    controller.setSpeed(1.5)
    controller.setVoice(false)
    await controller.ask('n = 5', true)
    controller.close()
    expect(last()).toMatchObject({ askOnHighlight: false, speed: 1.5, voice: false, animate: false })
  })
})

describe('the tutor\'s Animate in the visual island', () => {
  it('plays a lesson without touching the Ask conversation, and replays it', () => {
    const views: IslandView[] = []
    const controller = new IslandController({
      makeTracer: () => null,
      capture: async () => ({ image: null, spot: null }),
      emit: (v) => views.push(v),
      schedule: () => () => {},
      now: () => 0
    })
    const scene = { type: 'numberline' as const, min: 0, max: 1, marks: [] }
    controller.playLesson({ text: '', intro: 'Watch the line.', steps: [{ line: null, endLine: null, say: 'Start.', scene }] })
    const v = views.at(-1)!
    expect(v).toMatchObject({ phase: 'idle', spot: null, trace: null, playback: { index: -1, playing: true } })
    expect(v.lesson?.intro).toBe('Watch the line.')
    controller.stopPlayback()
    controller.replay()
    expect(views.at(-1)?.playback).toMatchObject({ index: -1, playing: true })
  })
})

describe('follow-ups', () => {
  it('come with the screen as it is now', async () => {
    const seen: (string | undefined)[] = []
    const tracer: TracerLike = {
      ask: async () => ({ message: 'It sets n.', trace: null, lesson: null }),
      followUp: async (_text, _animate, image) => {
        seen.push(image?.data)
        return { message: 'The title says Valid Palindrome.', trace: null, lesson: null }
      }
    }
    const controller = new IslandController({
      makeTracer: () => tracer,
      capture: async () => ({ image: null, spot: null }),
      screen: async () => ({ data: 'NOW', mediaType: 'image/jpeg' }),
      emit: () => {},
      schedule: () => () => {},
      now: () => 0
    })
    await controller.ask('n = 5', false)
    await controller.followUp("what's the problem on my screen?")
    expect(seen).toEqual(['NOW'])
  })
})
