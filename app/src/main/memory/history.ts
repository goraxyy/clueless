// History: every problem session, saved on this laptop as it goes and synced to the student's
// account when there is one (memory/sync.ts). Text only: screenshots are never saved.
// A JSON file instead of SQLite: no native modules, so it installs the same way on macOS and
// Windows. One file per account, so two students sharing a laptop never see each other's history.
//
// Gaps aren't stored on their own: they're counted from the sessions, so deleting a session also
// removes what it taught us.
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type {
  Gap,
  GapRecord,
  HistoryItem,
  InputKind,
  MemoryView,
  PlanStep,
  RecapView,
  SavedSession,
  Subject,
  ThreadItem,
  TurnKind
} from '../../shared/contracts'

/** What Clueless knows about a problem but the student must not see. */
export interface Secret {
  solution: string
  plan: PlanStep[] // with the text of the steps the student hasn't reached
}

interface HistoryFile {
  version: 2
  sessions: SavedSession[]
  /** Changed here and not uploaded yet. */
  unsynced: string[]
  /** Deleted here, not yet deleted on the server. */
  deleted: string[]
  /** With an account: kept only until uploaded. Without one: kept, so Continue works. */
  secrets: Record<string, Secret>
}

export function topicKey(topic: string): string {
  return topic.toLowerCase().replace(/\s+/g, ' ').trim()
}

const empty = (): HistoryFile => ({ version: 2, sessions: [], unsynced: [], deleted: [], secrets: {} })

export class HistoryStore {
  private data: HistoryFile = empty()

  constructor(
    private readonly file: string | null,
    /** Called after every change (the sync uploads it). */
    private readonly onChange: () => void = () => {}
  ) {
    if (!file) return
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as HistoryFile
      if (raw.version === 2) this.data = { ...empty(), ...raw }
    } catch {
      // No file yet (first run) or unreadable: start fresh.
    }
  }

  // ---------- the session controller ----------

  /** Save a session as it is now. Called after every turn, so nothing is lost if the app quits. */
  save(given: SavedSession): void {
    const session = structuredClone(given) // the caller keeps changing its own copy
    const at = this.data.sessions.findIndex((s) => s.id === session.id)
    if (at >= 0) this.data.sessions[at] = session
    else this.data.sessions.push(session)
    this.data.deleted = this.data.deleted.filter((id) => id !== session.id)
    this.markUnsynced(session.id)
    this.write()
  }

  saveSecret(id: string, secret: Secret): void {
    // Continuing a session doesn't bring the solution back: keep the one saved before.
    const before = this.data.secrets[id]
    this.data.secrets[id] = {
      solution: secret.solution || before?.solution || '',
      plan: secret.plan.length ? secret.plan : (before?.plan ?? [])
    }
    this.markUnsynced(id)
    this.write()
  }

  secret(id: string): Secret | null {
    return this.data.secrets[id] ?? null
  }

  /** A copy: changing it never changes history. */
  get(id: string): SavedSession | null {
    const found = this.data.sessions.find((s) => s.id === id)
    return found ? structuredClone(found) : null
  }

  /** One line for the tutor: the student's repeat gaps, so it can ask them to guess first. */
  historySummary(limit = 8): string | undefined {
    const repeats = this.gaps()
      .filter((g) => g.timesSeen >= 2)
      .slice(0, limit)
    if (repeats.length === 0) return undefined
    return repeats.map((g) => `${g.topic} (${g.type}, ${g.timesSeen}x)`).join('; ')
  }

  // ---------- the history screen ----------

  /** Newest first. */
  list(): HistoryItem[] {
    return [...this.data.sessions]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((s) => ({
        id: s.id,
        title: s.title,
        subject: s.subject,
        summary: s.summary,
        startedAt: s.startedAt,
        updatedAt: s.updatedAt,
        solved: s.solved,
        downloaded: s.thread !== null
      }))
  }

  remove(id: string): void {
    if (!this.data.sessions.some((s) => s.id === id)) return
    this.data.sessions = this.data.sessions.filter((s) => s.id !== id)
    delete this.data.secrets[id]
    this.data.unsynced = this.data.unsynced.filter((u) => u !== id)
    if (!this.data.deleted.includes(id)) this.data.deleted.push(id)
    this.write()
  }

  removeAll(): void {
    for (const s of [...this.data.sessions]) this.remove(s.id)
  }

  /** What the student keeps getting stuck on, most often first. */
  gaps(): GapRecord[] {
    const byKey = new Map<string, GapRecord>()
    for (const s of this.data.sessions) {
      for (const gap of s.gaps) {
        const key = `${s.subject}:${gap.type}:${topicKey(gap.topic)}`
        const rec = byKey.get(key)
        if (rec) {
          rec.timesSeen++
          if (s.startedAt < rec.firstSeen) rec.firstSeen = s.startedAt
          if (s.updatedAt > rec.lastSeen) rec.lastSeen = s.updatedAt
        } else {
          byKey.set(key, { id: key, subject: s.subject, type: gap.type, topic: gap.topic.trim(), timesSeen: 1, firstSeen: s.startedAt, lastSeen: s.updatedAt })
        }
      }
    }
    return [...byKey.values()].sort((a, b) => b.timesSeen - a.timesSeen || b.lastSeen.localeCompare(a.lastSeen))
  }

  view(): MemoryView {
    return { gaps: this.gaps(), sessions: this.data.sessions.length }
  }

  // ---------- the sync ----------

  /** What still has to go up to the server. */
  pending(): { sessions: SavedSession[]; secrets: [string, Secret][]; deleted: string[] } {
    const unsynced = new Set(this.data.unsynced)
    return {
      sessions: this.data.sessions.filter((s) => unsynced.has(s.id) && s.thread !== null),
      secrets: Object.entries(this.data.secrets).filter(([id]) => unsynced.has(id)),
      deleted: [...this.data.deleted]
    }
  }

  get hasPending(): boolean {
    return this.data.unsynced.length > 0 || this.data.deleted.length > 0
  }

  /** These made it to the server. With an account, uploaded secrets leave the laptop. */
  markSynced(done: { sessions: string[]; deleted: string[] }, dropSecrets: boolean): void {
    const up = new Set(done.sessions)
    this.data.unsynced = this.data.unsynced.filter((id) => !up.has(id))
    if (dropSecrets) for (const id of up) delete this.data.secrets[id]
    this.data.deleted = this.data.deleted.filter((id) => !done.deleted.includes(id))
    this.write()
  }

  /**
   * The server's list of sessions (without their conversations). New and newer ones come in;
   * ones deleted on another computer go; anything changed here and not uploaded yet stays.
   */
  mergeRemote(remote: SavedSession[]): void {
    const unsynced = new Set(this.data.unsynced)
    const deleted = new Set(this.data.deleted)
    const local = new Map(this.data.sessions.map((s) => [s.id, s]))
    const next: SavedSession[] = []
    for (const r of remote) {
      if (deleted.has(r.id)) continue
      const mine = local.get(r.id)
      local.delete(r.id)
      if (mine && (unsynced.has(r.id) || mine.updatedAt >= r.updatedAt)) next.push(mine)
      else next.push(r) // newer elsewhere: its conversation downloads when opened
    }
    for (const mine of local.values()) if (unsynced.has(mine.id)) next.push(mine) // not uploaded yet
    this.data.sessions = next
    this.write()
  }

  /** A session's conversation, downloaded when the student opens it. */
  setDownloaded(full: SavedSession): void {
    const at = this.data.sessions.findIndex((s) => s.id === full.id)
    if (at < 0 || this.data.unsynced.includes(full.id)) return
    this.data.sessions[at] = full
    this.write()
  }

  /**
   * Bring in the sessions from the old single-file memory (clueless-memory.json) once. With an
   * account they're marked as moved, so they go to the first account only. Returns how many.
   */
  importLegacy(legacyFile: string, markMovedTo: string | null): number {
    let raw: LegacyFile
    try {
      raw = JSON.parse(readFileSync(legacyFile, 'utf8'))
    } catch {
      return 0
    }
    if (raw.version !== 1 || raw.movedTo || !Array.isArray(raw.sessions)) return 0
    let count = 0
    for (const old of raw.sessions) {
      if (this.get(old.id)) continue
      this.data.sessions.push(fromLegacy(old))
      this.markUnsynced(old.id)
      count++
    }
    this.write()
    if (markMovedTo) writeAtomic(legacyFile, JSON.stringify({ ...raw, movedTo: markMovedTo }, null, 2))
    return count
  }

  private markUnsynced(id: string): void {
    if (!this.data.unsynced.includes(id)) this.data.unsynced.push(id)
  }

  private write(): void {
    if (this.file) writeAtomic(this.file, JSON.stringify(this.data))
    this.onChange()
  }
}

function writeAtomic(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, text)
  renameSync(tmp, file) // a crash mid-write never corrupts the file
}

export const legacyExists = (file: string): boolean => existsSync(file)

// ---------- the old memory file ----------

interface LegacySession {
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
  turns: { role: 'tutor' | 'student'; text: string; kind?: TurnKind; hintLevel?: number; as?: InputKind }[]
}

interface LegacyFile {
  version: number
  movedTo?: string
  sessions?: LegacySession[]
}

function fromLegacy(old: LegacySession): SavedSession {
  const at = Date.parse(old.startedAt) || Date.now()
  const thread: ThreadItem[] = old.turns.map((t, i) =>
    t.role === 'tutor'
      ? {
          id: randomUUID(),
          role: 'tutor',
          at: at + i,
          turn: {
            kind: t.kind ?? 'question',
            message: t.text,
            hintLevel: t.hintLevel ?? 0,
            verdict: 'none',
            plan: [],
            gap: null,
            expects: 'none',
            choices: [],
            visual: null,
            checkKind: null,
            animation: null
          }
        }
      : { id: randomUUID(), role: 'student', at: at + i, text: t.text, as: t.as ?? 'text', check: null }
  )
  return {
    id: old.id,
    startedAt: old.startedAt,
    updatedAt: old.endedAt || old.startedAt,
    subject: old.subject,
    title: old.title,
    summary: '',
    solved: old.solved,
    revealed: old.revealed,
    attempts: old.attempts,
    hintsUsed: old.hintsUsed,
    gaps: old.gaps ?? [],
    plan: [],
    thread,
    recap: null as RecapView | null
  }
}
