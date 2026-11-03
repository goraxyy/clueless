// The student's Clueless account: sign in (Google or an email link, finished in their browser), the
// beta invite code and 18+ confirmation, this week's free use, and the access token every Claude
// request carries. No Electron imports (the OS-encrypted storage and the browser are passed in),
// so the tests drive it against a fake server.
import { createClient, type SupabaseClient, type SupportedStorage } from '@supabase/supabase-js'
import type { AccountView, UsageView } from '../../shared/contracts'
import { listenForCallback, type Loopback } from './loopback'
import type { AccountServer } from './project'

export interface AccountDeps {
  server: AccountServer
  storage: SupportedStorage
  /** Opens a page in the student's browser. */
  openExternal(url: string): Promise<void>
  onChange(view: AccountView): void
  listen?(timeoutMs: number): Promise<Loopback>
  log?(line: string): void
  /** Refresh the access token in the background before it expires (off in tests). */
  autoRefresh?: boolean
}

const GOOGLE_WAIT_MS = 5 * 60_000
const EMAIL_WAIT_MS = 30 * 60_000
const OFFLINE = "Can't reach Clueless. Check your internet connection."

const signedOut = (error: string | null = null): AccountView => ({ state: 'signed-out', email: null, waitingFor: null, error, usage: null })

export class Account {
  readonly supabase: SupabaseClient
  private view: AccountView = signedOut()
  private user: string | null = null
  private pending: Loopback | null = null
  private readonly log: (line: string) => void

  constructor(private readonly deps: AccountDeps) {
    this.log = deps.log ?? (() => {})
    this.supabase = createClient(deps.server.url, deps.server.publishableKey, {
      auth: {
        flowType: 'pkce',
        storage: deps.storage,
        persistSession: true,
        autoRefreshToken: deps.autoRefresh ?? true,
        detectSessionInUrl: false
      }
    })
    // Signed out elsewhere, or the refresh token stopped working. (Don't call Supabase from inside
    // this callback: it can deadlock, so the refresh runs on the next tick.)
    this.supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') setTimeout(() => void this.refresh(), 0)
    })
  }

  get current(): AccountView {
    return this.view
  }

  /** The signed-in student's id (their history is kept under it), or null. */
  get userId(): string | null {
    return this.view.state === 'signed-out' ? null : this.user
  }

  /** Who's signed in, whether they're activated, and this week's use. */
  async refresh(): Promise<AccountView> {
    const { data } = await this.supabase.auth.getSession()
    const session = data.session
    this.user = session?.user.id ?? null
    if (!session) return this.set(this.pending ? { ...this.view, usage: null } : signedOut(this.view.error))

    const email = session.user.email ?? null
    const { data: usage, error } = await this.supabase.rpc('my_usage')
    if (error || !usage) {
      this.log(`account: my_usage failed: ${error?.message ?? 'no data'}`)
      // Keep what we knew; the server still enforces everything.
      const state = this.view.state === 'needs-invite' ? 'needs-invite' : 'ready'
      return this.set({ ...this.view, state, email, waitingFor: null, error: OFFLINE })
    }
    const state = (usage as { activated?: boolean }).activated ? 'ready' : 'needs-invite'
    return this.set({ state, email, waitingFor: null, error: null, usage: usageView(usage) })
  }

  /** Opens Google's sign-in in the browser; the account updates when the browser comes back. */
  async signInWithGoogle(): Promise<AccountView> {
    const loop = await this.startWaiting(GOOGLE_WAIT_MS)
    if (!loop) return this.view
    const { data, error } = await this.supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: loop.redirectTo, skipBrowserRedirect: true }
    })
    if (error || !data.url) {
      this.stopWaiting(loop)
      return this.set(signedOut(friendly(error?.message)))
    }
    await this.deps.openExternal(data.url)
    void this.finish(loop)
    return this.set({ ...signedOut(), state: 'waiting', waitingFor: 'google' })
  }

  /** Emails a sign-in link. Opening it on this computer finishes signing in. */
  async sendEmailLink(email: string): Promise<AccountView> {
    const address = email.trim()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) return this.set(signedOut('That email address doesn\'t look right.'))
    const loop = await this.startWaiting(EMAIL_WAIT_MS)
    if (!loop) return this.view
    const { error } = await this.supabase.auth.signInWithOtp({
      email: address,
      options: { emailRedirectTo: loop.redirectTo, shouldCreateUser: true }
    })
    if (error) {
      this.stopWaiting(loop)
      return this.set(signedOut(friendly(error.message)))
    }
    void this.finish(loop)
    return this.set({ ...signedOut(), state: 'waiting', waitingFor: 'email', email: address })
  }

  /** Stop waiting for the browser or the email link. */
  cancel(): AccountView {
    if (this.pending) this.stopWaiting(this.pending)
    return this.set(signedOut())
  }

  /** The beta invite code and the 18+ confirmation. */
  async activate(invite: string, adult: boolean): Promise<AccountView> {
    const { error } = await this.supabase.rpc('activate', { invite: invite.trim(), adult })
    // The database's own messages are written for students ("That invite code isn't valid...").
    if (error) return this.set({ ...this.view, error: error.code ? error.message : friendly(error.message) })
    return this.refresh()
  }

  async signOut(): Promise<AccountView> {
    await this.supabase.auth.signOut({ scope: 'local' })
    return this.set(signedOut())
  }

  /** A current access token for the `ai` function (refreshed if it expired), or null when signed out. */
  async accessToken(): Promise<string | null> {
    const { data } = await this.supabase.auth.getSession()
    return data.session?.access_token ?? null
  }

  /** Stops the background token refresh (tests, quitting). */
  stop(): void {
    void this.supabase.auth.stopAutoRefresh()
    if (this.pending) this.stopWaiting(this.pending)
  }

  private async startWaiting(timeoutMs: number): Promise<Loopback | null> {
    if (this.pending) this.stopWaiting(this.pending)
    try {
      this.pending = await (this.deps.listen ?? listenForCallback)(timeoutMs)
      return this.pending
    } catch (err) {
      this.set(signedOut((err as Error).message))
      return null
    }
  }

  private stopWaiting(loop: Loopback): void {
    if (this.pending === loop) this.pending = null
    loop.close()
  }

  /** The browser came back (or didn't): swap the code for a session. */
  private async finish(loop: Loopback): Promise<void> {
    const back = await loop.result
    if (this.pending !== loop) return // cancelled, or another sign-in started
    this.pending = null
    if (!back.code) {
      const error =
        back.error === 'cancelled' ? null : back.error === 'timeout' ? 'Signing in took too long. Try again.' : friendly(back.error)
      this.set(signedOut(error))
      return
    }
    const { error } = await this.supabase.auth.exchangeCodeForSession(back.code)
    if (error) {
      this.log(`account: exchangeCodeForSession failed: ${error.message}`)
      this.set(signedOut("Signing in didn't work. Try again."))
      return
    }
    await this.refresh()
  }

  private set(view: AccountView): AccountView {
    this.view = view
    this.deps.onChange(view)
    return view
  }
}

/** usage_check()'s numbers, as the app shows them. */
export function usageView(raw: unknown): UsageView {
  const u = (raw ?? {}) as Record<string, unknown>
  const n = (key: string): number => Number(u[key] ?? 0) || 0
  return {
    problemsLeft: Math.max(0, n('problems_limit') - n('problems_used')),
    problemsLimit: n('problems_limit'),
    asksLeft: Math.max(0, n('asks_limit') - n('asks_used')),
    asksLimit: n('asks_limit'),
    limitReached: n('dollars_used') >= n('dollars_limit'),
    resetsAt: typeof u.resets_at === 'string' ? new Date(u.resets_at).toISOString() : ''
  }
}

/** Network and server errors, worded for a student. */
function friendly(message: string | null | undefined): string {
  if (!message || /fetch|network|ECONN|ENOTFOUND|timed? ?out/i.test(message)) return OFFLINE
  if (/rate limit|too many/i.test(message)) return 'Too many tries. Wait a minute, then try again.'
  return message
}
