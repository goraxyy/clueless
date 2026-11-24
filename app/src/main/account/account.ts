// Signing in to Clueless (Supabase Auth, a 6-digit code sent by email) and the session that comes
// with it. Runs in the main process: the tokens never reach the UI. No Electron imports (testable);
// where the session is kept is passed in (see box.ts).
import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js'
import type { AccountState, AccountUsage } from '../../shared/contracts'

export interface ServerConfig {
  /** The Supabase project, e.g. https://abcd.supabase.co */
  url: string
  /** Its publishable (anon) key: public by design, it only identifies the project. */
  key: string
}

/** Where the session is kept between launches. */
export interface SecretBox {
  read(): string | null
  write(value: string | null): void
}

type Env = Record<string, string | undefined>
type Result = { ok: true } | { ok: false; message: string }

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** The server, from the env (CLUELESS_SUPABASE_URL / _KEY) or baked into the build. */
export function serverConfig(env: Env = process.env, baked: Env = {}): ServerConfig | null {
  const url = (env.CLUELESS_SUPABASE_URL || baked.url || '').trim().replace(/\/+$/, '')
  const key = (env.CLUELESS_SUPABASE_KEY || baked.key || '').trim()
  return url && key ? { url, key } : null
}

export class Account {
  private readonly client: SupabaseClient
  private session: Session | null = null
  private ready: Promise<void>

  constructor(
    readonly config: ServerConfig,
    box: SecretBox,
    private readonly onChange: (state: AccountState) => void = () => {},
    private readonly http: typeof fetch = fetch
  ) {
    this.client = createClient(config.url, config.key, {
      auth: { storage: boxStorage(box), persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
      global: { fetch: http }
    })
    this.client.auth.onAuthStateChange((_event, session) => {
      const was = this.session?.user.id
      this.session = session
      if (was !== session?.user.id) this.onChange(this.state())
    })
    this.ready = this.client.auth.getSession().then(({ data }) => {
      this.session = data.session
    })
  }

  /** Where the app's server function lives. */
  get apiBase(): string {
    return `${this.config.url}/functions/v1/api`
  }

  /** Resolves once the saved session (if any) is loaded. */
  whenReady(): Promise<void> {
    return this.ready
  }

  state(): AccountState {
    return { configured: true, signedIn: Boolean(this.session), email: this.session?.user.email ?? null }
  }

  async sendCode(email: unknown): Promise<Result> {
    if (typeof email !== 'string' || !EMAIL.test(email.trim())) return { ok: false, message: 'Type your email address.' }
    const { error } = await this.client.auth.signInWithOtp({ email: email.trim(), options: { shouldCreateUser: true } })
    return error ? { ok: false, message: friendly(error.message) } : { ok: true }
  }

  async verifyCode(email: unknown, code: unknown): Promise<Result> {
    if (typeof email !== 'string' || typeof code !== 'string' || !/^\d{6,10}$/.test(code.trim())) {
      return { ok: false, message: 'Type the code from the email.' }
    }
    const { data, error } = await this.client.auth.verifyOtp({ email: email.trim(), token: code.trim(), type: 'email' })
    if (error || !data.session) return { ok: false, message: error ? friendly(error.message) : "That code didn't work." }
    this.session = data.session
    this.onChange(this.state())
    return { ok: true }
  }

  async signOut(): Promise<void> {
    await this.client.auth.signOut().catch(() => {})
    this.session = null
    this.onChange(this.state())
  }

  /** A current access token (refreshed when it's about to expire), or null when signed out. */
  async token(): Promise<string | null> {
    await this.ready
    if (!this.session) return null
    const { data } = await this.client.auth.getSession()
    return data.session?.access_token ?? null
  }

  /** Plan and spend this month, from the server. */
  async usage(): Promise<AccountUsage | null> {
    const token = await this.token()
    if (!token) return null
    try {
      const res = await this.http(`${this.apiBase}/me`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000) })
      return res.ok ? ((await res.json()) as AccountUsage) : null
    } catch {
      return null
    }
  }
}

/** Supabase's storage interface over one box holding a small JSON map. */
function boxStorage(box: SecretBox) {
  const load = (): Record<string, string> => {
    try {
      return JSON.parse(box.read() ?? '{}') as Record<string, string>
    } catch {
      return {}
    }
  }
  return {
    getItem: (key: string) => load()[key] ?? null,
    setItem: (key: string, value: string) => box.write(JSON.stringify({ ...load(), [key]: value })),
    removeItem: (key: string) => {
      const all = load()
      delete all[key]
      box.write(Object.keys(all).length ? JSON.stringify(all) : null)
    }
  }
}

function friendly(message: string): string {
  if (/rate limit|too many|security purposes/i.test(message)) return 'Too many tries. Wait a minute, then try again.'
  if (/expired|invalid/i.test(message)) return 'That code is wrong or has expired. Send a new one.'
  if (/fetch|network/i.test(message)) return "Can't reach Clueless. Check your internet connection."
  return message
}
