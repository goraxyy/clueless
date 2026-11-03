// History: past problem sessions, like chats in an AI app. Grouped by when, searchable; open one to
// read it back, then Continue where you left off or delete it. With an account it's the same list
// on every computer.
import { useEffect, useMemo, useState } from 'react'
import type { HistoryItem, HistoryView, SavedSession } from '../../../shared/contracts'
import { toSpeech } from '../../../shared/speechText'
import { api } from '../api'
import { BackIcon, CheckIcon, TrashIcon } from '../components/icons'
import { Button, cx, IconButton } from '../components/ui'
import { speech } from '../voice/speaker'
import { StudentLine, TutorCard } from './Session'

const SYNC_NOTE: Record<HistoryView['sync'], string | null> = {
  local: 'Saved on this computer',
  synced: null,
  pending: 'Syncing…',
  offline: 'Offline: saved here, syncs later'
}

/** `onBack` returns to the session screen (also after Continue). */
export function HistoryScreen({ onBack }: { onBack: () => void }) {
  const [view, setView] = useState<HistoryView | null>(null)
  const [open, setOpen] = useState<string | null>(null)

  useEffect(() => {
    void api.getHistory().then(setView)
    return api.onHistory(setView)
  }, [])

  if (open) return <SessionReadBack id={open} onBack={() => setOpen(null)} onContinue={onBack} />
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2 border-b border-zinc-900/10 px-3 py-2 dark:border-white/10">
        <IconButton title="Back" onClick={onBack}>
          <BackIcon size={15} />
        </IconButton>
        <span className="text-xs font-medium text-zinc-700 dark:text-zinc-200">History</span>
        {view && SYNC_NOTE[view.sync] && <span className="ml-auto text-[11px] text-zinc-400">{SYNC_NOTE[view.sync]}</span>}
      </div>
      {view && <SessionList sessions={view.sessions} onOpen={setOpen} />}
    </div>
  )
}

/** Today, this week, older. */
function groupOf(iso: string, now = new Date()): string {
  const then = new Date(iso)
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  if (then.getTime() >= startOfToday) return 'Today'
  if (then.getTime() >= startOfToday - 6 * 86_400_000) return 'This week'
  return 'Older'
}

function when(iso: string): string {
  const d = new Date(iso)
  return groupOf(iso) === 'Today'
    ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function SessionList({ sessions, onOpen }: { sessions: HistoryItem[]; onOpen: (id: string) => void }) {
  const [query, setQuery] = useState('')
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? sessions.filter((s) => `${s.title} ${s.subject} ${s.summary}`.toLowerCase().includes(q)) : sessions
  }, [sessions, query])
  const groups = useMemo(() => {
    const out = new Map<string, HistoryItem[]>()
    for (const s of shown) out.set(groupOf(s.updatedAt), [...(out.get(groupOf(s.updatedAt)) ?? []), s])
    return [...out]
  }, [shown])

  if (sessions.length === 0) {
    return <div className="px-6 py-10 text-center text-sm text-zinc-500 dark:text-zinc-400">No sessions yet. Every problem you work on shows up here.</div>
  }
  return (
    <div className="flex min-h-0 flex-col">
      <div className="px-3 pt-2.5">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search your sessions"
          className="no-drag h-8 w-full rounded-lg border border-zinc-900/10 bg-white/60 px-2.5 text-[12.5px] text-zinc-900 outline-none placeholder:text-zinc-400 focus:border-claude-400/70 dark:border-white/15 dark:bg-white/[0.06] dark:text-zinc-50 dark:placeholder:text-zinc-500"
        />
      </div>
      <div className="max-h-[420px] overflow-y-auto px-2 pb-2 pt-1">
        {groups.length === 0 && <div className="py-6 text-center text-xs text-zinc-400">Nothing matches.</div>}
        {groups.map(([label, list]) => (
          <div key={label} className="mt-2">
            <div className="px-1.5 pb-1 text-[10.5px] font-semibold uppercase tracking-wide text-zinc-400">{label}</div>
            {list.map((s) => (
              <Row key={s.id} item={s} onOpen={() => onOpen(s.id)} />
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

function Row({ item, onOpen }: { item: HistoryItem; onOpen: () => void }) {
  return (
    <div className="group flex items-center gap-1 rounded-lg hover:bg-zinc-900/5 dark:hover:bg-white/5">
      <button type="button" onClick={onOpen} title={item.summary || item.title} className="no-drag flex min-w-0 flex-1 items-center gap-2 px-1.5 py-1.5 text-left">
        <span className="w-14 shrink-0 truncate rounded bg-claude-100 px-1 py-px text-center text-[9.5px] font-semibold uppercase tracking-wide text-claude-900 dark:bg-claude-500/15 dark:text-claude-400">
          {item.subject}
        </span>
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-zinc-800 dark:text-zinc-100">{item.title}</span>
        {item.solved && <CheckIcon size={13} className="shrink-0 text-emerald-500" aria-label="Solved" />}
        <span className="shrink-0 text-[11px] text-zinc-400">{when(item.updatedAt)}</span>
      </button>
      <IconButton
        title="Delete this session"
        onClick={() => void api.deleteHistory(item.id)}
        className="mr-1 h-6 w-6 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
      >
        <TrashIcon size={13} />
      </IconButton>
    </div>
  )
}

/** One past session, read-only: the whole conversation, then Continue or Delete. */
function SessionReadBack({ id, onBack, onContinue }: { id: string; onBack: () => void; onContinue: () => void }) {
  const [session, setSession] = useState<SavedSession | null | 'loading'>('loading')
  const [confirmDelete, setConfirmDelete] = useState(false)

  useEffect(() => {
    void api.openHistory(id).then(setSession)
  }, [id])

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-zinc-900/10 px-3 py-2 dark:border-white/10">
        <IconButton title="Back to history" onClick={onBack}>
          <BackIcon size={15} />
        </IconButton>
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-zinc-900 dark:text-zinc-50">
          {session && session !== 'loading' ? session.title : 'History'}
        </span>
        {session && session !== 'loading' && (
          <span className="shrink-0 text-[11px] text-zinc-400">{new Date(session.startedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
        )}
      </div>
      {session === 'loading' ? (
        <div className="py-10 text-center text-xs text-zinc-400">Opening…</div>
      ) : !session?.thread ? (
        <div className="px-6 py-10 text-center text-sm text-zinc-500 dark:text-zinc-400">Couldn't open this session. Check your internet connection.</div>
      ) : (
        <>
          <div className="max-h-[380px] space-y-2 overflow-y-auto px-3 py-2.5">
            {session.thread.map((item) =>
              item.role === 'tutor' ? (
                <TutorCard key={item.id} turn={item.turn} onReadAloud={() => speech.speak(toSpeech(item.turn.message))} />
              ) : item.role === 'student' ? (
                <StudentLine key={item.id} text={item.text} as={item.as} check={item.check} />
              ) : null
            )}
            {session.recap && (
              <div className="rounded-xl border border-claude-400/70 bg-claude-50/60 px-3 py-2 text-[12px] text-zinc-700 dark:border-claude-600/30 dark:bg-claude-600/5 dark:text-zinc-200">
                <span className="font-semibold">Recap:</span> {session.solved ? 'solved' : 'not solved yet'} · {session.attempts} answers ·{' '}
                {session.hintsUsed} hints
              </div>
            )}
          </div>
          <div className="flex items-center gap-2 border-t border-zinc-900/10 px-3 py-2 dark:border-white/10">
            <Button
              variant="primary"
              className="h-8 flex-1 text-[12.5px]"
              onClick={() => {
                api.continueHistory(session.id)
                onContinue()
              }}
            >
              Continue where I left off
            </Button>
            <Button
              variant="ghost"
              className={cx('h-8 text-[12.5px]', confirmDelete && 'text-rose-600 dark:text-rose-400')}
              onClick={() => {
                if (!confirmDelete) return setConfirmDelete(true)
                void api.deleteHistory(session.id).then(onBack)
              }}
            >
              {confirmDelete ? 'Delete for good?' : 'Delete'}
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
