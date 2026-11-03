// Keeps this laptop's history (HistoryStore) and the student's account in step. Changes go up
// shortly after they happen; the list comes down when the app starts and when history is opened;
// a session's conversation comes down when the student opens it. Offline, everything waits in the
// local file and goes up later.
import type { SupabaseClient } from '@supabase/supabase-js'
import type { HistoryView, SavedSession } from '../../shared/contracts'
import type { HistoryStore } from './history'

/** The list's columns: everything but the conversation. */
const LIST = 'id, started_at, updated_at, subject, title, summary, solved, revealed, attempts, hints_used, gaps'
const UPLOAD_CHUNK = 20
const RETRY_MS = 60_000

interface Row {
  id: string
  started_at: string
  updated_at: string
  subject: SavedSession['subject']
  title: string
  summary: string
  solved: boolean
  revealed: boolean
  attempts: number
  hints_used: number
  gaps: SavedSession['gaps']
  plan?: SavedSession['plan']
  thread?: SavedSession['thread']
  recap?: SavedSession['recap']
}

export function toRow(s: SavedSession): Row {
  return {
    id: s.id,
    started_at: s.startedAt,
    updated_at: s.updatedAt,
    subject: s.subject,
    title: s.title,
    summary: s.summary,
    solved: s.solved,
    revealed: s.revealed,
    attempts: s.attempts,
    hints_used: s.hintsUsed,
    gaps: s.gaps,
    plan: s.plan,
    thread: s.thread ?? [],
    recap: s.recap
  }
}

export function fromRow(r: Row): SavedSession {
  return {
    id: r.id,
    startedAt: new Date(r.started_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
    subject: r.subject,
    title: r.title,
    summary: r.summary,
    solved: r.solved,
    revealed: r.revealed,
    attempts: r.attempts,
    hintsUsed: r.hints_used,
    gaps: r.gaps ?? [],
    plan: r.plan ?? [],
    thread: r.thread === undefined ? null : r.thread,
    recap: r.recap ?? null
  }
}

/** A database refusal (a SQL error code) won't go away by retrying; a network error will. */
const permanent = (error: { code?: string } | null): boolean => Boolean(error?.code && /^[0-9A-Z]{5}$/.test(error.code))

export class HistorySync {
  private state: 'synced' | 'pending' | 'offline' = 'synced'
  private timer: NodeJS.Timeout | null = null
  private running: Promise<void> | null = null
  private stopped = false

  constructor(
    private readonly store: HistoryStore,
    private readonly supabase: SupabaseClient,
    private readonly onChange: () => void,
    private readonly log: (line: string) => void = () => {}
  ) {}

  get status(): HistoryView['sync'] {
    if (this.state === 'offline') return 'offline'
    return this.store.hasPending ? 'pending' : 'synced'
  }

  /** Upload soon: changes come in bursts (a reply, then its secret). */
  soon(ms = 1500): void {
    if (this.stopped) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.run(false), ms)
  }

  /** Upload what's waiting, then fetch the list. One run at a time. */
  sync(): Promise<void> {
    return this.run(true)
  }

  private run(pull: boolean): Promise<void> {
    if (this.running) return this.running.then(() => (pull ? this.run(true) : undefined))
    this.running = (async () => {
      try {
        const ok = await this.flush()
        if (ok && pull) await this.pull()
      } finally {
        this.running = null
        this.onChange()
        if (!this.stopped && this.store.hasPending) this.soon(this.state === 'offline' ? RETRY_MS : 5000)
      }
    })()
    return this.running
  }

  /** False when offline. */
  private async flush(): Promise<boolean> {
    const { sessions, secrets, deleted } = this.store.pending()
    if (!sessions.length && !secrets.length && !deleted.length) return true

    const rowsDone = new Set<string>()
    for (let i = 0; i < sessions.length; i += UPLOAD_CHUNK) {
      const chunk = sessions.slice(i, i + UPLOAD_CHUNK)
      const { error } = await this.supabase.from('sessions').upsert(chunk.map(toRow), { onConflict: 'id' })
      if (error && !permanent(error)) return this.offline(error.message)
      if (error) {
        // One bad row (too big, say) shouldn't hold the rest back forever: try them one by one.
        for (const s of chunk) {
          const one = await this.supabase.from('sessions').upsert(toRow(s), { onConflict: 'id' })
          if (one.error && !permanent(one.error)) return this.offline(one.error.message)
          if (one.error) this.log(`history: session ${s.id} refused (${one.error.message}); keeping it on this laptop only`)
          rowsDone.add(s.id)
        }
      } else {
        for (const s of chunk) rowsDone.add(s.id)
      }
    }

    const secretsDone = new Set<string>()
    for (const [id, secret] of secrets) {
      const { error } = await this.supabase.rpc('save_secrets', { session: id, solution: secret.solution, full_plan: secret.plan })
      if (error && !permanent(error)) return this.offline(error.message)
      if (error && rowsDone.has(id)) this.log(`history: secrets for ${id} refused (${error.message})`)
      if (!error || rowsDone.has(id)) secretsDone.add(id)
    }

    let deletedDone: string[] = []
    if (deleted.length) {
      const { error } = await this.supabase.from('sessions').delete().in('id', deleted)
      if (error && !permanent(error)) return this.offline(error.message)
      deletedDone = deleted
    }

    // An id is done once its row (if it had one waiting) and its secret (if any) are both up.
    const pendingSecret = new Set(secrets.map(([id]) => id))
    const pendingRow = new Set(sessions.map((s) => s.id))
    const ids = [...new Set([...pendingRow, ...pendingSecret])].filter(
      (id) => (!pendingRow.has(id) || rowsDone.has(id)) && (!pendingSecret.has(id) || secretsDone.has(id))
    )
    this.store.markSynced({ sessions: ids, deleted: deletedDone }, true)
    this.state = 'synced'
    return true
  }

  private async pull(): Promise<void> {
    const { data, error } = await this.supabase.from('sessions').select(LIST).order('updated_at', { ascending: false }).limit(1000)
    if (error) {
      this.offline(error.message)
      return
    }
    this.store.mergeRemote((data as Row[]).map(fromRow))
  }

  /** A session with its conversation, downloading it if this laptop only has the summary. */
  async open(id: string): Promise<SavedSession | null> {
    const local = this.store.get(id)
    if (local?.thread) return local
    const { data, error } = await this.supabase.from('sessions').select(`${LIST}, plan, thread, recap`).eq('id', id).maybeSingle()
    if (error) {
      this.offline(error.message)
      return null
    }
    if (!data) return null
    const full = fromRow(data as Row)
    this.store.setDownloaded(full)
    return full
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
  }

  private offline(why: string): false {
    if (this.state !== 'offline') this.log(`history: can't sync (${why}); will retry`)
    this.state = 'offline'
    return false
  }
}
