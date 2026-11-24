// Memory: gaps, past sessions and flashcards, kept in one JSON file on the laptop.
// A JSON file instead of SQLite: no native modules, so it installs the same way on macOS
// and Windows. The data is small.
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type {
  Flashcard,
  FlashcardInput,
  Gap,
  GapRecord,
  InputKind,
  MemoryView,
  SessionDetail,
  SessionSummary,
  Subject,
  TurnKind
} from '../../shared/contracts'

export interface SessionRecord {
  id: string
  startedAt: string
  endedAt: string
  subject: Subject
  title: string
  attempts: number
  hintsUsed: number
  solved: boolean
  revealed: boolean
  gaps: Gap[]
  /** The help log: what was said, for the student (or a teacher) to look back on. */
  turns: { role: 'tutor' | 'student'; text: string; kind?: TurnKind; hintLevel?: number; as?: InputKind }[]
}

interface MemoryData {
  version: 1
  gaps: GapRecord[]
  sessions: SessionRecord[]
  /** Saved under its own key: an older "cards" list (a removed feature) had another shape. */
  flashcards: Flashcard[]
}

const SUBJECTS: readonly Subject[] = ['coding', 'math', 'physics', 'other']
/** Days until a card is shown again, by box (after a right answer moves it into that box). */
const BOX_DAYS = [0, 1, 3, 7, 16, 35]
const MAX_CARD_TEXT = 8000

export function topicKey(topic: string): string {
  return topic.toLowerCase().replace(/\s+/g, ' ').trim()
}

export class MemoryStore {
  private data: MemoryData = { version: 1, gaps: [], sessions: [], flashcards: [] }

  constructor(
    private readonly file: string | null,
    /** Called after history or flashcards change (the main window refreshes). */
    private readonly onChange: () => void = () => {}
  ) {
    this.load()
  }

  private load(): void {
    if (!this.file) return
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as MemoryData & { cards?: unknown }
      if (raw.version !== 1) return
      // Files from the old flashcards feature still have a "cards" list in another shape: drop it.
      this.data = { version: 1, gaps: raw.gaps ?? [], sessions: raw.sessions ?? [], flashcards: raw.flashcards ?? [] }
    } catch {
      // No file yet (first run) or unreadable: start fresh.
    }
  }

  private save(): void {
    if (!this.file) return
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.data, null, 2))
    renameSync(tmp, this.file) // atomic: a crash mid-write never corrupts the file
  }

  recordGap(subject: Subject, gap: Gap, now = new Date()): GapRecord {
    const key = topicKey(gap.topic)
    let rec = this.data.gaps.find((g) => g.subject === subject && g.type === gap.type && topicKey(g.topic) === key)
    if (rec) {
      rec.timesSeen++
      rec.lastSeen = now.toISOString()
    } else {
      rec = {
        id: randomUUID(),
        subject,
        type: gap.type,
        topic: gap.topic.trim(),
        timesSeen: 1,
        firstSeen: now.toISOString(),
        lastSeen: now.toISOString()
      }
      this.data.gaps.push(rec)
    }
    this.save()
    return rec
  }

  /** One line for the tutor: the student's repeat gaps, so it can ask them to guess first. */
  historySummary(limit = 8): string | undefined {
    const repeats = [...this.data.gaps]
      .filter((g) => g.timesSeen >= 2)
      .sort((a, b) => b.timesSeen - a.timesSeen)
      .slice(0, limit)
    if (repeats.length === 0) return undefined
    return repeats.map((g) => `${g.topic} (${g.type}, ${g.timesSeen}x)`).join('; ')
  }

  addSession(rec: SessionRecord): void {
    this.data.sessions.push(rec)
    this.save()
    this.onChange()
  }

  /** Past problems, newest first. */
  sessions(): SessionSummary[] {
    return [...this.data.sessions].reverse().map(summary)
  }

  session(id: string): SessionDetail | null {
    const rec = this.data.sessions.find((s) => s.id === id)
    if (!rec) return null
    return {
      ...summary(rec),
      attempts: rec.attempts,
      revealed: rec.revealed,
      gaps: rec.gaps,
      thread: rec.turns.map((t) => ({ role: t.role, text: t.text, kind: t.kind }))
    }
  }

  deleteSession(id: string): void {
    const before = this.data.sessions.length
    this.data.sessions = this.data.sessions.filter((s) => s.id !== id)
    if (this.data.sessions.length === before) return
    this.save()
    this.onChange()
  }

  // ---------- flashcards ----------

  cards(): Flashcard[] {
    return [...this.data.flashcards]
  }

  /** Save a card. The same card (front and back) twice is kept once. Returns null for an empty card. */
  addCard(input: FlashcardInput, now = new Date()): Flashcard | null {
    const front = clip(input.front)
    const back = clip(input.back)
    if (!front || !back) return null
    const existing = this.data.flashcards.find((c) => c.front === front && c.back === back)
    if (existing) return existing
    const card: Flashcard = {
      id: randomUUID(),
      subject: input.subject && SUBJECTS.includes(input.subject) ? input.subject : 'other',
      topic: clip(input.topic, 120) || 'General',
      front,
      back,
      source: input.source ?? 'manual',
      createdAt: now.toISOString(),
      box: 1,
      due: now.toISOString(), // new cards are due right away
      reviews: 0
    }
    this.data.flashcards.push(card)
    this.save()
    this.onChange()
    return card
  }

  updateCard(id: string, patch: { topic?: unknown; front?: unknown; back?: unknown }): void {
    const card = this.data.flashcards.find((c) => c.id === id)
    if (!card) return
    if (typeof patch.topic === 'string' && clip(patch.topic, 120)) card.topic = clip(patch.topic, 120)
    if (typeof patch.front === 'string' && clip(patch.front)) card.front = clip(patch.front)
    if (typeof patch.back === 'string' && clip(patch.back)) card.back = clip(patch.back)
    this.save()
    this.onChange()
  }

  deleteCard(id: string): void {
    const before = this.data.flashcards.length
    this.data.flashcards = this.data.flashcards.filter((c) => c.id !== id)
    if (this.data.flashcards.length === before) return
    this.save()
    this.onChange()
  }

  /** Knew it: up a box, shown again in BOX_DAYS days. Didn't: back to box 1, again in 10 minutes. */
  reviewCard(id: string, knew: boolean, now = new Date()): void {
    const card = this.data.flashcards.find((c) => c.id === id)
    if (!card) return
    card.reviews++
    if (knew) {
      card.box = Math.min(5, card.box + 1)
      card.due = new Date(now.getTime() + BOX_DAYS[card.box] * 86_400_000).toISOString()
    } else {
      card.box = 1
      card.due = new Date(now.getTime() + 10 * 60_000).toISOString()
    }
    this.save()
    this.onChange()
  }

  view(): MemoryView {
    return {
      gaps: [...this.data.gaps].sort((a, b) => b.timesSeen - a.timesSeen || b.lastSeen.localeCompare(a.lastSeen)),
      sessions: this.data.sessions.length
    }
  }
}

function summary(rec: SessionRecord): SessionSummary {
  return {
    id: rec.id,
    startedAt: rec.startedAt,
    endedAt: rec.endedAt,
    subject: rec.subject,
    title: rec.title,
    solved: rec.solved,
    hintsUsed: rec.hintsUsed,
    turns: rec.turns.length
  }
}

function clip(text: string, max = MAX_CARD_TEXT): string {
  return typeof text === 'string' ? text.trim().slice(0, max) : ''
}
