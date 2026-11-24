// Flashcards: saved answers, grouped by topic. Review the ones that are due (show the answer, then
// "Knew it" or "Didn't"), or browse, edit and add your own.
import { useEffect, useMemo, useState } from 'react'
import type { Flashcard } from '../../../shared/contracts'
import { api } from '../api'
import { PlusIcon, TrashIcon } from '../components/icons'
import { Markdown } from '../components/Markdown'
import { Button, cx, IconButton } from '../components/ui'
import { SubjectTag } from './HistoryView'
import { Card, Page } from './MainApp'

const ALL = ':all:'

export function FlashcardsView() {
  const [cards, setCards] = useState<Flashcard[] | null>(null)
  const [topic, setTopic] = useState(ALL)
  const [reviewing, setReviewing] = useState(false)
  const [adding, setAdding] = useState(false)

  useEffect(() => {
    const load = (): void => void api.listCards().then(setCards)
    load()
    return api.onMemoryChanged(load)
  }, [])

  const topics = useMemo(() => {
    const map = new Map<string, Flashcard[]>()
    for (const c of cards ?? []) map.set(c.topic, [...(map.get(c.topic) ?? []), c])
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [cards])

  const inTopic = (cards ?? []).filter((c) => topic === ALL || c.topic === topic)
  const due = inTopic.filter((c) => Date.parse(c.due) <= Date.now())

  if (reviewing) return <Review cards={due} onDone={() => setReviewing(false)} />

  return (
    <Page
      title="Flashcards"
      actions={
        <>
          <Button onClick={() => setAdding(true)}>
            <PlusIcon size={14} /> New card
          </Button>
          <Button variant="primary" disabled={due.length === 0} onClick={() => setReviewing(true)}>
            Review {due.length > 0 ? `${due.length} due` : '(none due)'}
          </Button>
        </>
      }
    >
      {cards && cards.length === 0 && !adding && (
        <p className="mt-10 text-center text-sm text-zinc-500">
          Save a reply with the card button on it (in the panel, in Chat or in History), or make your own.
        </p>
      )}
      <div className="flex gap-6">
        {topics.length > 0 && (
          <div className="w-52 shrink-0 space-y-0.5">
            <TopicButton label="All topics" count={(cards ?? []).length} active={topic === ALL} onClick={() => setTopic(ALL)} />
            {topics.map(([t, list]) => (
              <TopicButton key={t} label={t} count={list.length} active={topic === t} onClick={() => setTopic(t)} />
            ))}
          </div>
        )}
        <div className="min-w-0 flex-1 space-y-2">
          {adding && <CardEditor topic={topic === ALL ? '' : topic} onClose={() => setAdding(false)} />}
          {inTopic.map((c) => (
            <CardRow key={c.id} card={c} />
          ))}
        </div>
      </div>
    </Page>
  )
}

function TopicButton({ label, count, active, onClick }: { label: string; count: number; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        'no-drag flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px]',
        active ? 'bg-white font-medium shadow-sm dark:bg-white/10' : 'text-zinc-600 hover:bg-zinc-900/5 dark:text-zinc-400 dark:hover:bg-white/5'
      )}
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="text-[11.5px] text-zinc-400">{count}</span>
    </button>
  )
}

function CardRow({ card }: { card: Flashcard }) {
  const [editing, setEditing] = useState(false)
  const [open, setOpen] = useState(false)
  if (editing) return <CardEditor card={card} onClose={() => setEditing(false)} />
  const dueNow = Date.parse(card.due) <= Date.now()
  return (
    <Card className="group">
      <div className="flex items-start gap-3">
        <button type="button" onClick={() => setOpen(!open)} className="no-drag min-w-0 flex-1 text-left">
          <div className="mb-1 flex items-center gap-2 text-[11.5px] text-zinc-400">
            <SubjectTag subject={card.subject} />
            <span>{card.topic}</span>
            <span>· box {card.box}</span>
            {dueNow && <span className="text-claude-600 dark:text-claude-400">· due</span>}
          </div>
          <div className="line-clamp-3 whitespace-pre-wrap text-[13.5px] font-medium">{card.front}</div>
        </button>
        <div className="flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          <Button variant="chip" onClick={() => setEditing(true)}>
            Edit
          </Button>
          <IconButton title="Delete card" onClick={() => void api.deleteCard(card.id)} className="hover:text-rose-600">
            <TrashIcon size={14} />
          </IconButton>
        </div>
      </div>
      {open && (
        <div className="mt-3 border-t border-zinc-900/10 pt-3 dark:border-white/10">
          <Markdown text={card.back} />
        </div>
      )}
    </Card>
  )
}

function CardEditor({ card, topic, onClose }: { card?: Flashcard; topic?: string; onClose: () => void }) {
  const [t, setT] = useState(card?.topic ?? topic ?? '')
  const [front, setFront] = useState(card?.front ?? '')
  const [back, setBack] = useState(card?.back ?? '')
  const ok = t.trim() && front.trim() && back.trim()

  const save = async (): Promise<void> => {
    if (!ok) return
    if (card) await api.updateCard(card.id, { topic: t, front, back })
    else await api.addCard({ topic: t, front, back, source: 'manual' })
    onClose()
  }

  const field =
    'selectable w-full rounded-lg border border-zinc-900/10 bg-white px-2.5 py-1.5 text-[13.5px] outline-none focus:border-claude-500 dark:border-white/15 dark:bg-black/20'
  return (
    <Card className="space-y-2 border-claude-300 dark:border-claude-600/40">
      <input value={t} onChange={(e) => setT(e.target.value)} placeholder="Topic, e.g. Integration by parts" className={field} />
      <textarea value={front} onChange={(e) => setFront(e.target.value)} rows={2} placeholder="Question" className={field} />
      <textarea value={back} onChange={(e) => setBack(e.target.value)} rows={4} placeholder="Answer (Markdown and $math$ work)" className={field} />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!ok} onClick={() => void save()}>
          Save
        </Button>
      </div>
    </Card>
  )
}

/** One due card at a time: think, show the answer, then say how it went. */
function Review({ cards, onDone }: { cards: Flashcard[]; onDone: () => void }) {
  const [queue] = useState(cards)
  const [index, setIndex] = useState(0)
  const [shown, setShown] = useState(false)
  const [right, setRight] = useState(0)
  const card = queue[index]

  const answer = (knew: boolean): void => {
    void api.reviewCard(card.id, knew)
    if (knew) setRight(right + 1)
    setShown(false)
    setIndex(index + 1)
  }

  if (!card) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 pb-16">
        <div className="text-2xl font-semibold">Done</div>
        <p className="text-sm text-zinc-500">
          {right} of {queue.length} right. Cards you missed come back in 10 minutes.
        </p>
        <Button variant="primary" onClick={onDone}>
          Back to flashcards
        </Button>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col items-center px-8 pb-10">
      <div className="mb-4 flex w-full max-w-2xl items-center text-[12.5px] text-zinc-500">
        <span>
          {index + 1} of {queue.length} · {card.topic}
        </span>
        <button type="button" onClick={onDone} className="no-drag ml-auto hover:text-zinc-900 dark:hover:text-white">
          Stop
        </button>
      </div>
      <Card className="w-full max-w-2xl flex-1 overflow-y-auto p-8">
        <div className="whitespace-pre-wrap text-[16px] font-medium">{card.front}</div>
        {shown && (
          <div className="mt-6 border-t border-zinc-900/10 pt-6 dark:border-white/10">
            <Markdown text={card.back} />
          </div>
        )}
      </Card>
      <div className="mt-5 flex gap-2">
        {shown ? (
          <>
            <Button onClick={() => answer(false)}>Didn't know</Button>
            <Button variant="primary" onClick={() => answer(true)}>
              Knew it
            </Button>
          </>
        ) : (
          <Button variant="primary" onClick={() => setShown(true)}>
            Show answer
          </Button>
        )}
      </div>
    </div>
  )
}
