import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SavedSession } from '../../shared/contracts'
import { continueMessage, localHidden, serverHidden } from './continue'
import { HistoryStore } from './history'

const session = (over: Partial<SavedSession> = {}): SavedSession => ({
  id: 'aaaaaaaa-0000-4000-8000-000000000001',
  startedAt: '2026-11-03T10:00:00.000Z',
  updatedAt: '2026-11-03T10:05:00.000Z',
  subject: 'math',
  title: 'Integrate x e^x',
  summary: 'By parts',
  solved: false,
  revealed: false,
  attempts: 1,
  hintsUsed: 1,
  gaps: [{ type: 'recall_slip', topic: 'Integration by parts formula' }],
  plan: [{ id: 1, text: 'Pick u and dv', status: 'current' }],
  thread: [
    { id: 't1', role: 'student', text: 'no idea', as: 'text', check: null, at: 1 },
    {
      id: 't2',
      role: 'tutor',
      at: 2,
      turn: { kind: 'hint', message: 'Which part gets simpler when differentiated?', hintLevel: 1, verdict: 'none', plan: [], gap: null, expects: 'text', choices: [], visual: null, checkKind: null, animation: null }
    }
  ],
  recap: null,
  ...over
})

const tmp = (): string => mkdtempSync(join(tmpdir(), 'clueless-history-'))

describe('HistoryStore', () => {
  it('keeps sessions across restarts and counts gaps from them', () => {
    const file = join(tmp(), 'history.json')
    const store = new HistoryStore(file)
    store.save(session())
    store.save(session({ id: 'b', gaps: [{ type: 'recall_slip', topic: ' integration  by parts FORMULA ' }], updatedAt: '2026-11-04T09:00:00.000Z' }))

    const again = new HistoryStore(file)
    expect(again.list().map((s) => s.id)).toEqual(['b', session().id]) // newest first
    expect(again.gaps()).toMatchObject([{ topic: 'Integration by parts formula', timesSeen: 2, lastSeen: '2026-11-04T09:00:00.000Z' }])
    expect(again.historySummary()).toBe('Integration by parts formula (recall_slip, 2x)')
    expect(again.view().sessions).toBe(2)
  })

  it('remembers what still has to go up, and what was deleted', () => {
    const store = new HistoryStore(null)
    store.save(session())
    store.saveSecret(session().id, { solution: '(x-1)e^x + C', plan: session().plan })
    expect(store.pending().sessions).toHaveLength(1)
    expect(store.pending().secrets).toHaveLength(1)

    store.markSynced({ sessions: [session().id], deleted: [] }, true)
    expect(store.hasPending).toBe(false)
    expect(store.secret(session().id)).toBeNull() // with an account, the secret leaves the laptop once uploaded

    store.remove(session().id)
    expect(store.list()).toEqual([])
    expect(store.gaps()).toEqual([]) // its gaps go with it
    expect(store.pending().deleted).toEqual([session().id])
  })

  it('keeps the saved solution when a continued session saves the plan without it', () => {
    const store = new HistoryStore(null)
    store.saveSecret('s', { solution: 'SECRET', plan: [{ id: 1, text: 'Pick u', status: 'current' }] })
    store.saveSecret('s', { solution: '', plan: [{ id: 1, text: 'Pick u', status: 'done' }] })
    expect(store.secret('s')).toEqual({ solution: 'SECRET', plan: [{ id: 1, text: 'Pick u', status: 'done' }] })
  })

  it("merges the server's list: newer comes in, deleted elsewhere goes, unsent changes stay", () => {
    const store = new HistoryStore(null)
    const synced = session({ id: 'synced' })
    const mine = session({ id: 'mine' })
    const gone = session({ id: 'gone' })
    for (const s of [synced, gone]) store.save(s)
    store.markSynced({ sessions: ['synced', 'gone'], deleted: [] }, true)
    store.save(mine) // not uploaded yet

    store.mergeRemote([
      { ...synced, updatedAt: '2026-11-05T00:00:00.000Z', title: 'Changed on the other laptop', thread: null },
      { ...session({ id: 'new' }), thread: null }
    ])
    const byId = new Map(store.list().map((s) => [s.id, s]))
    expect([...byId.keys()].sort()).toEqual(['mine', 'new', 'synced'])
    expect(byId.get('synced')).toMatchObject({ title: 'Changed on the other laptop', downloaded: false })
    expect(byId.get('new')?.downloaded).toBe(false)
    expect(byId.get('mine')?.downloaded).toBe(true)
  })

  it('moves the old memory file in once, to the first account only', () => {
    const dir = tmp()
    const legacy = join(dir, 'clueless-memory.json')
    writeFileSync(
      legacy,
      JSON.stringify({
        version: 1,
        gaps: [],
        sessions: [
          {
            id: 'old-1',
            startedAt: '2026-10-20T10:00:00.000Z',
            endedAt: '2026-10-20T10:30:00.000Z',
            subject: 'coding',
            title: 'Two sum',
            attempts: 2,
            hintsUsed: 3,
            solved: true,
            revealed: false,
            gaps: [{ type: 'strategy_gap', topic: 'hash maps' }],
            turns: [
              { role: 'student', text: 'help', as: 'text' },
              { role: 'tutor', text: 'Try a dictionary.', kind: 'hint', hintLevel: 2 }
            ]
          }
        ]
      })
    )
    const first = new HistoryStore(join(dir, 'history-a.json'))
    expect(first.importLegacy(legacy, 'account-a')).toBe(1)
    expect(first.get('old-1')).toMatchObject({ title: 'Two sum', solved: true, updatedAt: '2026-10-20T10:30:00.000Z' })
    expect(first.get('old-1')?.thread?.[1]).toMatchObject({ role: 'tutor', turn: { message: 'Try a dictionary.', kind: 'hint', hintLevel: 2 } })
    expect(first.pending().sessions).toHaveLength(1) // it goes up to the account
    expect(JSON.parse(readFileSync(legacy, 'utf8')).movedTo).toBe('account-a')

    const second = new HistoryStore(join(dir, 'history-b.json'))
    expect(second.importLegacy(legacy, 'account-b')).toBe(0)
  })
})

describe('the [CONTINUE] message', () => {
  it('carries the problem, the last turns and where the hidden solution goes', () => {
    const text = continueMessage(session(), serverHidden(session().id))
    expect(text).toContain('[CONTINUE]')
    expect(text).toContain('Problem: Integrate x e^x (math). By parts')
    expect(text).toContain(`{{hidden:${session().id}}}`)
    expect(text).toContain('Student: no idea')
    expect(text).toContain('Clueless: Which part gets simpler when differentiated?')
    expect(localHidden({ solution: 'S', plan: [{ id: 1, text: 'Pick u', status: 'done' }] })).toBe('[HIDDEN SOLUTION] S\n[FULL PLAN]\n1. (done) Pick u')
  })
})
