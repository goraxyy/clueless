import { describe, expect, it, vi } from 'vitest'
import type { SessionView, TutorReplyT, TutorTurn } from '../shared/contracts'
import { MemoryStore } from './memory/store'
import { SessionController } from './session'
import type { SendInput, StartInput, TutorLike } from './tutor/tutor'

const turn = (over: Partial<TutorTurn> = {}): TutorTurn => ({
  kind: 'question',
  message: 'What do you get?',
  hintLevel: 0,
  verdict: 'none',
  plan: [{ id: 1, text: 'Integrate by parts', status: 'current' }],
  gap: null,
  expects: 'math',
  choices: [],
  visual: null,
  check: null,
  ...over
})

class FakeTutor implements TutorLike {
  sent: SendInput[] = []
  replies: TutorReplyT[] = []
  async start(_: StartInput): Promise<TutorReplyT> {
    return {
      problem: { subject: 'math', title: '∫ x² eˣ dx', summary: 'Integrate', language: null, hiddenSolution: 'SECRET' },
      turn: turn({ check: { kind: 'antiderivative', reference: 'x^2*e^x', variable: 'x', unit: null } }),
      recap: null
    }
  }
  async send(input: SendInput): Promise<TutorReplyT> {
    this.sent.push(input)
    return this.replies.shift() ?? { problem: null, turn: turn(), recap: null }
  }
}

const sudokuVisual = {
  caption: 'boxes',
  frames: [{ type: 'sets' as const, name: 'boxes', bins: [{ label: 'boxes[0]', items: ['5'] }], flash: -1 }],
  narration: ['The first box gets a 5.']
}

function setup() {
  const tutor = new FakeTutor()
  const views: (SessionView | null)[] = []
  const memory = new MemoryStore(null)
  const stuck = { start: vi.fn(), stop: vi.fn(), snooze: vi.fn(), noteActivity: vi.fn(), noteWrongStreak: vi.fn() }
  const controller = new SessionController({
    makeTutor: () => tutor,
    memory,
    captureScreen: async () => ({ data: 'AAAA', mediaType: 'image/jpeg' }),
    emit: (v) => views.push(v),
    stuck
  })
  return { tutor, views, memory, stuck, controller, last: () => views[views.length - 1]! }
}

describe('SessionController', () => {
  it('never sends the hidden solution or the check reference to the UI', async () => {
    const { controller, views } = setup()
    await controller.startProblem({ text: 'integrate x^2 e^x' })
    const json = JSON.stringify(views)
    expect(json).not.toContain('SECRET')
    expect(json).not.toContain('x^2*e^x')
  })

  it('still opens a usable session when Claude never names the problem', async () => {
    const { tutor, controller, last } = setup()
    tutor.start = async () => ({ problem: null, turn: turn(), recap: null })
    await controller.startProblem({ text: 'something' })
    expect(last().problem).toMatchObject({ subject: 'other', title: 'Your problem' })
    await controller.action('hint')
    expect(tutor.sent.at(-1)?.tag).toBe('HINT')
  })

  it('runs the math checker on the answer and tells the tutor the result', async () => {
    const { controller, tutor, last } = setup()
    await controller.startProblem({ text: 'integrate' })
    tutor.replies.push({ problem: null, turn: turn({ kind: 'feedback', verdict: 'incorrect' }), recap: null })
    await controller.send('x^2 e^x - 2x e^x - 2e^x + C', 'math')
    expect(tutor.sent[0].notes?.join()).toContain('does NOT equal the integrand')
    const student = last()!.thread.find((t) => t.role === 'student')
    expect(student && student.role === 'student' && student.check?.status).toBe('mismatch')
    expect(last()!.wrongStreak).toBe(1)
  })

  it('unlocks Reveal only after 3 answers', async () => {
    const { controller, tutor, last } = setup()
    await controller.startProblem({ text: 'p' })
    for (let i = 0; i < 3; i++) {
      tutor.replies.push({ problem: null, turn: turn({ verdict: 'incorrect' }), recap: null })
      await controller.action('reveal') // ignored while locked
      expect(tutor.sent.some((s) => s.tag === 'REVEAL')).toBe(false)
      await controller.send(`try ${i}`, 'text')
    }
    expect(last()!.revealAllowed).toBe(true)
    await controller.action('reveal')
    expect(tutor.sent.at(-1)?.tag).toBe('REVEAL')
  })

  it('records the gaps and the session when the recap comes', async () => {
    const { controller, tutor, memory, last } = setup()
    await controller.startProblem({ text: 'p' })
    tutor.replies.push({
      problem: null,
      turn: turn({ kind: 'recall_card', gap: { type: 'recall_slip', topic: 'integration by parts formula' } }),
      recap: null
    })
    await controller.send('what is the formula again', 'recall')
    tutor.replies.push({
      problem: null,
      turn: turn({ kind: 'solved' }),
      recap: {
        explainBack: 'Why u = x²?',
        gaps: [{ type: 'recall_slip', topic: 'integration by parts formula' }],
        similarProblem: '∫ x² cos x dx'
      }
    })
    await controller.action('finish')
    expect(last()!.recap?.gaps).toHaveLength(1)
    expect(memory.view().gaps[0].topic).toBe('integration by parts formula')
    expect(memory.view().sessions).toBe(1)
  })

  it('Animate asks for the idea right now; the reply is marked to play in its own window', async () => {
    const { controller, tutor, last } = setup()
    await controller.startProblem({ text: 'p' })
    tutor.replies.push({ problem: null, turn: turn({ visual: sudokuVisual }), recap: null })
    await controller.action('animate')
    expect(tutor.sent.at(-1)?.tag).toBe('ANIMATE')
    let item = last()!.thread.at(-1)!
    expect(item.role === 'tutor' && item.turn.animation).toEqual({ requested: true })

    tutor.replies.push({ problem: null, turn: turn({ message: "I can't animate this.", visual: null }), recap: null })
    await controller.action('animate')
    item = last()!.thread.at(-1)!
    expect(item.role === 'tutor' && item.turn.animation).toBeNull()
  })

  it('sends the screen with a typed message, marked [SCREEN]', async () => {
    const { controller, tutor } = setup()
    await controller.startProblem({ text: 'p' })
    await controller.send('what does the problem on my screen ask?', 'text', { data: 'NOW', mediaType: 'image/jpeg' })
    const sent = tutor.sent.at(-1)!
    expect(sent.image?.data).toBe('NOW')
    expect(sent.notes).toContain('[SCREEN]')
  })

  it('writes the recap by itself once the whole problem is solved', async () => {
    const { controller, tutor, last } = setup()
    await controller.startProblem({ text: 'p' })
    tutor.replies.push({ problem: null, turn: turn({ kind: 'solved', plan: [{ id: 1, text: 'Integrate by parts', status: 'done' }] }), recap: null })
    tutor.replies.push({
      problem: null,
      turn: turn({ kind: 'solved' }),
      recap: { explainBack: 'Why u = x²?', gaps: [], similarProblem: null }
    })
    await controller.send('x^2 e^x - 2x e^x + 2e^x', 'math')
    expect(tutor.sent.map((s) => s.tag)).toEqual(['STUDENT', 'RECAP'])
    expect(last()!.recap?.explainBack).toBe('Why u = x²?')
  })

  it('does not recap when only a step is solved', async () => {
    const { controller, tutor } = setup()
    await controller.startProblem({ text: 'p' })
    tutor.replies.push({ problem: null, turn: turn({ kind: 'solved', plan: [{ id: 1, text: 'a', status: 'done' }, { id: 2, text: 'b', status: 'current' }] }), recap: null })
    await controller.send('done', 'text')
    expect(tutor.sent.map((s) => s.tag)).toEqual(['STUDENT'])
  })

  it('keeps the error and lets the student retry', async () => {
    const { controller, tutor, last } = setup()
    await controller.startProblem({ text: 'p' })
    const original = tutor.send.bind(tutor)
    tutor.send = async () => {
      throw new Error('Claude is rate-limiting us.')
    }
    await controller.action('hint')
    expect(last()!.error).toBe('Claude is rate-limiting us.')
    tutor.send = original
    await controller.action('retry')
    expect(last()!.error).toBeNull()
    expect(tutor.sent.at(-1)?.tag).toBe('HINT')
  })

  describe('plan steps', () => {
    const plan = [
      { id: 1, text: 'Write the formula', status: 'done' as const },
      { id: 2, text: 'Pick u and dv', status: 'current' as const },
      { id: 3, text: 'SECRET STRATEGY', status: 'locked' as const }
    ]
    const started = async () => {
      const s = setup()
      s.tutor.start = async () => ({
        problem: { subject: 'math', title: 'P', summary: '', language: null, hiddenSolution: '' },
        turn: turn({ plan }),
        recap: null
      })
      await s.controller.startProblem({ text: 'p' })
      return s
    }

    it("never sends a locked step's text to the UI", async () => {
      const { views, last } = await started()
      expect(JSON.stringify(views)).not.toContain('SECRET STRATEGY')
      expect(last().plan.map((p) => p.text)).toEqual(['Write the formula', 'Pick u and dv', ''])
    })

    it('tells the tutor which step was clicked, with its full text', async () => {
      const { controller, tutor, last } = await started()
      await controller.step(2, 'stuck')
      expect(tutor.sent.at(-1)).toMatchObject({ tag: 'STEP STUCK', text: 'step 2: Pick u and dv' })
      expect(last().thread.some((t) => t.role === 'student' && t.text === 'Stuck on step 2')).toBe(true)
    })

    it('ignores clicks that do not match the step state', async () => {
      const { controller, tutor } = await started()
      await controller.step(2, 'revisit') // step 2 is current, not done
      await controller.step(1, 'claim') // step 1 is done, not locked
      await controller.step(9, 'stuck') // no such step
      expect(tutor.sent).toHaveLength(0)
      await controller.step(3, 'claim')
      expect(tutor.sent.at(-1)).toMatchObject({ tag: 'STEP CLAIM', text: 'step 3: SECRET STRATEGY' })
    })
  })
})
