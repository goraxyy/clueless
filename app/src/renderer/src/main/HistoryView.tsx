// Past problems: the list, and one at a time with its whole conversation. Read-only (the tutor's
// state isn't kept), but any reply can be saved as a flashcard.
import { useEffect, useState } from 'react'
import type { SessionDetail, SessionSummary } from '../../../shared/contracts'
import { api } from '../api'
import { CardIcon, CheckIcon, TrashIcon } from '../components/icons'
import { Markdown } from '../components/Markdown'
import { cx, IconButton } from '../components/ui'
import { Card, formatDate, Page } from './MainApp'

export function HistoryView() {
  const [list, setList] = useState<SessionSummary[] | null>(null)
  const [open, setOpen] = useState<SessionDetail | null>(null)
  const [query, setQuery] = useState('')

  useEffect(() => {
    const load = (): void => void api.listHistory().then(setList)
    load()
    return api.onMemoryChanged(load)
  }, [])

  if (open) return <SessionPage session={open} onBack={() => setOpen(null)} />

  const shown = (list ?? []).filter((s) => !query.trim() || s.title.toLowerCase().includes(query.trim().toLowerCase()))
  return (
    <Page
      title="History"
      actions={
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search problems"
          className="no-drag h-8 w-56 rounded-lg border border-zinc-900/10 bg-white px-2.5 text-[13px] outline-none focus:border-claude-500 dark:border-white/15 dark:bg-white/5"
        />
      }
    >
      {list && list.length === 0 && (
        <p className="mt-10 text-center text-sm text-zinc-500">
          Problems you work through show up here, with the whole conversation.
        </p>
      )}
      <div className="space-y-1.5">
        {shown.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => void api.getHistory(s.id).then(setOpen)}
            className="flex w-full items-center gap-3 rounded-xl border border-zinc-900/10 bg-white px-4 py-3 text-left hover:border-claude-400 dark:border-white/10 dark:bg-white/5 dark:hover:border-claude-500"
          >
            <SubjectTag subject={s.subject} />
            <span className="min-w-0 flex-1 truncate text-[14px] font-medium">{s.title}</span>
            {s.solved && (
              <span className="flex items-center gap-1 text-[12px] text-emerald-600 dark:text-emerald-400">
                <CheckIcon size={13} /> Solved
              </span>
            )}
            <span className="w-16 text-right text-[12px] text-zinc-400">{s.hintsUsed} hints</span>
            <span className="w-20 text-right text-[12px] text-zinc-400">{formatDate(s.startedAt)}</span>
          </button>
        ))}
      </div>
    </Page>
  )
}

function SessionPage({ session, onBack }: { session: SessionDetail; onBack: () => void }) {
  const [saved, setSaved] = useState<Set<number>>(new Set())

  const save = async (index: number, text: string): Promise<void> => {
    const card = await api.addCard({ subject: session.subject, topic: session.title, front: session.title, back: text, source: 'tutor' })
    if (card) setSaved(new Set(saved).add(index))
  }

  return (
    <Page
      title={session.title}
      actions={
        <>
          <button type="button" onClick={onBack} className="no-drag text-[13px] text-zinc-500 hover:text-zinc-900 dark:hover:text-white">
            ← All problems
          </button>
          <IconButton
            title="Delete this problem from History"
            onClick={() => void api.deleteHistory(session.id).then(onBack)}
            className="hover:text-rose-600"
          >
            <TrashIcon size={15} />
          </IconButton>
        </>
      }
    >
      <div className="mb-4 flex flex-wrap items-center gap-2 text-[12.5px] text-zinc-500">
        <SubjectTag subject={session.subject} />
        <span>{formatDate(session.startedAt)}</span>
        <span>· {session.attempts} tries</span>
        <span>· {session.hintsUsed} hints</span>
        {session.solved && <span className="text-emerald-600 dark:text-emerald-400">· Solved</span>}
        {session.revealed && <span>· Answer shown</span>}
        {session.gaps.map((g, i) => (
          <span key={i} className="rounded-full bg-zinc-200/70 px-2 py-px dark:bg-white/10">
            {g.topic}
          </span>
        ))}
      </div>
      <div className="mx-auto max-w-3xl space-y-3">
        {session.thread.map((t, i) =>
          t.role === 'student' ? (
            <div key={i} className="flex justify-end">
              <div className="selectable max-w-[80%] whitespace-pre-wrap rounded-2xl bg-claude-500 px-3.5 py-2 text-[13.5px] text-white">{t.text}</div>
            </div>
          ) : (
            <Card key={i} className="group relative pr-10">
              <Markdown text={t.text} />
              <IconButton
                title={saved.has(i) ? 'Saved to your flashcards' : 'Save as a flashcard'}
                onClick={() => void save(i, t.text)}
                className={cx('!absolute right-2 top-2', saved.has(i) ? 'text-claude-500' : 'opacity-0 group-hover:opacity-100')}
              >
                <CardIcon size={14} />
              </IconButton>
            </Card>
          )
        )}
      </div>
    </Page>
  )
}

export function SubjectTag({ subject }: { subject: string }) {
  return (
    <span className="rounded bg-claude-100 px-1.5 py-px text-[10.5px] font-semibold uppercase tracking-wide text-claude-900 dark:bg-claude-500/15 dark:text-claude-400">
      {subject}
    </span>
  )
}
