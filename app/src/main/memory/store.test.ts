import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MemoryStore } from './store'

const tmpFile = () => join(mkdtempSync(join(tmpdir(), 'clueless-')), 'memory.json')

describe('MemoryStore', () => {
  it('counts repeat gaps by topic, ignoring case and spacing', () => {
    const m = new MemoryStore(null)
    m.recordGap('coding', { type: 'recall_slip', topic: 'Python list of sets' })
    const rec = m.recordGap('coding', { type: 'recall_slip', topic: 'python  list of sets' })
    expect(rec.timesSeen).toBe(2)
    expect(m.historySummary()).toBe('Python list of sets (recall_slip, 2x)')
  })

  it('saves to disk and loads back', () => {
    const file = tmpFile()
    const a = new MemoryStore(file)
    a.recordGap('physics', { type: 'concept_gap', topic: 'components of gravity on a ramp' })
    const b = new MemoryStore(file)
    expect(b.view().gaps[0].topic).toBe('components of gravity on a ramp')
  })

  it('loads files from before flashcards were removed', () => {
    const file = tmpFile()
    writeFileSync(file, JSON.stringify({ version: 1, gaps: [], cards: [{ id: 'c1' }], sessions: [] }))
    expect(new MemoryStore(file).view()).toEqual({ gaps: [], sessions: 0 })
  })
})

describe('MemoryStore: history and flashcards', () => {
  const session = (id: string, title: string) => ({
    id,
    startedAt: '2026-11-20T10:00:00.000Z',
    endedAt: '2026-11-20T10:10:00.000Z',
    subject: 'math' as const,
    title,
    attempts: 2,
    hintsUsed: 1,
    solved: true,
    revealed: false,
    gaps: [],
    turns: [
      { role: 'student' as const, text: 'x = 3?' },
      { role: 'tutor' as const, text: 'Check the sign.', kind: 'hint' as const }
    ]
  })

  it('lists past problems newest first, shows one, deletes one, and tells the window', () => {
    let changes = 0
    const m = new MemoryStore(null, () => changes++)
    m.addSession(session('a', 'First'))
    m.addSession(session('b', 'Second'))
    expect(m.sessions().map((s) => s.title)).toEqual(['Second', 'First'])
    expect(m.session('a')).toMatchObject({ title: 'First', turns: 2, thread: [{ role: 'student', text: 'x = 3?' }, { role: 'tutor', kind: 'hint' }] })
    m.deleteSession('a')
    expect(m.sessions()).toHaveLength(1)
    expect(m.session('a')).toBeNull()
    expect(changes).toBe(3)
  })

  it('saves cards once, drops empty ones, and keeps them across launches', () => {
    const file = tmpFile()
    const m = new MemoryStore(file)
    const card = m.addCard({ subject: 'math', topic: 'Integration by parts', front: 'When do you use it?', back: 'A product of two functions.', source: 'tutor' })
    expect(card).toMatchObject({ box: 1, topic: 'Integration by parts', subject: 'math' })
    expect(m.addCard({ topic: 'x', front: 'When do you use it?', back: 'A product of two functions.' })?.id).toBe(card!.id)
    // Another reply from the same problem (same front) is a card of its own.
    expect(m.addCard({ topic: 'x', front: 'When do you use it?', back: 'Pick u to get simpler.' })?.id).not.toBe(card!.id)
    expect(m.addCard({ topic: 'x', front: '  ', back: 'b' })).toBeNull()
    expect(new MemoryStore(file).cards()).toHaveLength(2)
  })

  it('reviews with boxes: right moves it up and later, wrong sends it back to box 1 soon', () => {
    const m = new MemoryStore(null)
    const now = new Date('2026-11-24T12:00:00.000Z')
    const c = m.addCard({ topic: 't', front: 'q', back: 'a' }, now)!
    m.reviewCard(c.id, true, now)
    expect(m.cards()[0]).toMatchObject({ box: 2, due: '2026-11-27T12:00:00.000Z', reviews: 1 })
    m.reviewCard(c.id, false, now)
    expect(m.cards()[0]).toMatchObject({ box: 1, due: '2026-11-24T12:10:00.000Z' })
    m.updateCard(c.id, { front: 'better question', back: '' })
    expect(m.cards()[0]).toMatchObject({ front: 'better question', back: 'a' })
    m.deleteCard(c.id)
    expect(m.cards()).toHaveLength(0)
  })

  it("an old file's cards list (the removed feature) is ignored", () => {
    const file = tmpFile()
    writeFileSync(file, JSON.stringify({ version: 1, gaps: [], sessions: [], cards: [{ id: 'x', fsrs: {} }] }))
    expect(new MemoryStore(file).cards()).toEqual([])
  })
})
