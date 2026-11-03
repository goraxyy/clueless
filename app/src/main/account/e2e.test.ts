// End to end, on this computer: a student signs in with an email link, enters an invite code, and
// the real Tutor and Tracer talk to Claude through the real `ai` server code. Only the outside world
// is faked: Supabase's sign-in and database (a small local web server) and Claude's API.
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { handle, type UsageEvent } from '../../../../supabase/functions/_shared/handler.ts'
import { Tracer } from '../island/tracer'
import { serverHidden } from '../memory/continue'
import { HistoryStore } from '../memory/history'
import { HistorySync } from '../memory/sync'
import { SessionController } from '../session'
import { createTransport } from '../tutor/provider'
import { Tutor } from '../tutor/tutor'
import { Account } from './account'
import { listenForCallback } from './loopback'

const STUDENT = { id: '6f1c2a52-0000-4000-8000-000000000001', email: 'student@lehigh.edu' }
const TOKEN = 'access-token-for-student'

// ---------- the fake world ----------

const db = {
  activated: false,
  problemsLimit: 20,
  invites: new Map([['LEHIGH-TA', 1]]), // code -> uses left
  events: [] as UsageEvent[],
  sessions: new Map<string, Record<string, unknown>>(), // the `sessions` table
  secrets: new Map<string, { hidden_solution: string; plan: unknown }>() // `session_secrets`
}
const toClaude: { headers: Headers; body: Record<string, unknown> }[] = []
const pending: Promise<unknown>[] = []
let emailedLink: string | null = null

function usageState(): Record<string, unknown> {
  const count = (unit: string): number => db.events.filter((e) => e.unit === unit).length
  return {
    activated: db.activated,
    banned: false,
    plan: 'beta',
    problems_used: count('problem'),
    problems_limit: db.problemsLimit,
    asks_used: count('ask'),
    asks_limit: 60,
    dollars_used: db.events.reduce((sum, e) => sum + e.cost_usd, 0),
    dollars_limit: 2,
    requests_last_minute: 0,
    requests_per_minute: 30,
    resets_at: '2026-11-09T05:00:00+00:00'
  }
}

const tutorReply = {
  problem: { subject: 'math', title: 'Integrate x e^x', summary: 'By parts', language: '', hiddenSolution: '(x-1)e^x + C' },
  turn: {
    kind: 'question',
    message: 'Which part would you call u?',
    hintLevel: 1,
    verdict: 'none',
    plan: [{ id: 1, text: 'Pick u and dv', status: 'current' }],
    gap: { type: 'none', topic: '' },
    expects: 'text',
    choices: [],
    visual: { caption: '', frames: [], narration: [] },
    check: { kind: 'none', reference: '', variable: '', unit: '' }
  },
  recap: null
}
const traceReply = { message: 'It sets x to 1.', language: 'python', entities: [], steps: [], run: { setup: '', call: '' }, lesson: [] }

/** Claude's API: a JSON reply for the tutor, a streamed one for Ask. */
async function fakeClaude(_url: string | URL | Request, init?: RequestInit): Promise<Response> {
  const body = JSON.parse(String(init?.body))
  toClaude.push({ headers: new Headers(init?.headers), body })
  const usage = { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  if (!body.stream) {
    return Response.json({ id: 'msg_1', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: JSON.stringify(tutorReply) }], stop_reason: 'end_turn', stop_sequence: null, usage })
  }
  const events = [
    { type: 'message_start', message: { id: 'msg_2', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: JSON.stringify(traceReply) } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 90 } },
    { type: 'message_stop' }
  ]
  const sse = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('')
  return new Response(sse, { headers: { 'content-type': 'text/event-stream' } })
}

const session = (): Record<string, unknown> => ({
  access_token: TOKEN,
  token_type: 'bearer',
  expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  refresh_token: 'refresh-token',
  user: { id: STUDENT.id, aud: 'authenticated', role: 'authenticated', email: STUDENT.email, app_metadata: {}, user_metadata: {}, created_at: '2026-11-03T00:00:00Z' }
})

let server: Server
let base = ''

async function route(req: IncomingMessage, body: Buffer): Promise<Response> {
  const url = new URL(req.url ?? '/', base)
  const signedIn = req.headers.authorization === `Bearer ${TOKEN}`
  const json = body.length ? JSON.parse(body.toString()) : {}

  // Supabase Auth
  if (url.pathname === '/auth/v1/otp') {
    emailedLink = url.searchParams.get('redirect_to')
    return json.code_challenge ? Response.json({}) : Response.json({ msg: 'PKCE expected' }, { status: 400 })
  }
  if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'pkce') {
    return json.auth_code === 'code-from-the-email' && json.code_verifier
      ? Response.json(session())
      : Response.json({ code: 'bad_code', msg: 'invalid flow state' }, { status: 400 })
  }
  if (url.pathname === '/auth/v1/logout') return new Response(null, { status: 204 })

  // The database's functions
  if (url.pathname === '/rest/v1/rpc/my_usage') return signedIn ? Response.json(usageState()) : Response.json(null)
  if (url.pathname === '/rest/v1/rpc/activate') {
    const left = db.invites.get(String(json.invite).toUpperCase()) ?? 0
    if (!signedIn || json.adult !== true || left < 1) {
      return Response.json({ code: 'P0001', message: "That invite code isn't valid, or it has been used up.", details: null, hint: null }, { status: 400 })
    }
    db.invites.set(String(json.invite).toUpperCase(), left - 1)
    db.activated = true
    return Response.json({ id: STUDENT.id })
  }

  // History: just enough of the database's REST API for the sync
  if (url.pathname === '/rest/v1/sessions') {
    if (!signedIn) return Response.json({ message: 'JWT expired' }, { status: 401 })
    if (req.method === 'POST') {
      for (const row of Array.isArray(json) ? json : [json]) db.sessions.set(row.id, { ...row, user_id: STUDENT.id })
      return new Response(null, { status: 201 })
    }
    if (req.method === 'DELETE') {
      const ids = /^in\.\((.*)\)$/.exec(url.searchParams.get('id') ?? '')?.[1].split(',') ?? []
      for (const id of ids) db.sessions.delete(id.replace(/"/g, ''))
      return new Response(null, { status: 204 })
    }
    const columns = (url.searchParams.get('select') ?? '*').split(',').map((c) => c.trim())
    const id = url.searchParams.get('id')?.replace(/^eq\./, '')
    const rows = [...db.sessions.values()]
      .filter((r) => !id || r.id === id)
      .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
    return Response.json(rows.map((r) => Object.fromEntries(columns.map((c) => [c, r[c]]))))
  }
  if (url.pathname === '/rest/v1/rpc/save_secrets') {
    if (!db.sessions.has(json.session)) return Response.json({ code: 'P0002', message: 'Save the session first.' }, { status: 400 })
    const before = db.secrets.get(json.session)
    db.secrets.set(json.session, { hidden_solution: json.solution || before?.hidden_solution || '', plan: json.full_plan })
    return new Response(null, { status: 204 })
  }

  // The `ai` function, the real code
  if (url.pathname.startsWith('/functions/v1/ai/')) {
    const headers = new Headers()
    for (const [name, value] of Object.entries(req.headers)) {
      if (typeof value === 'string' && !['host', 'connection', 'content-length', 'transfer-encoding'].includes(name)) headers.set(name, value)
    }
    return handle(new Request(url, { method: req.method, headers, body }), {
      userFor: async (token) => (token === TOKEN ? STUDENT.id : null),
      usage: async () => usageState() as never,
      secrets: async (user, id) =>
        db.sessions.get(id)?.user_id === user ? { hidden_solution: db.secrets.get(id)?.hidden_solution ?? '', plan: db.secrets.get(id)?.plan ?? [] } : null,
      record: async (e) => void db.events.push(e),
      fetch: fakeClaude as typeof fetch,
      env: (name) => ({ ANTHROPIC_API_KEY: 'server-key' })[name],
      waitUntil: (work) => void pending.push(work)
    })
  }
  return new Response('not found', { status: 404 })
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const response = await route(req, Buffer.concat(chunks))
    res.writeHead(response.status, Object.fromEntries(response.headers))
    if (response.body) for await (const chunk of response.body) res.write(chunk)
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(() => {
  account?.stop()
  server?.close()
})

// ---------- the student ----------

let account: Account
const env = (): Record<string, string> => ({ CLUELESS_SUPABASE_URL: base, CLUELESS_SUPABASE_KEY: 'sb_publishable_test' })
const memory = new Map<string, string>()

async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 10))
  if (!check()) throw new Error(`timed out waiting for ${what}`)
}

describe('a student, end to end', () => {
  it('signs in with an email link opened in the browser', async () => {
    const opened: string[] = []
    account = new Account({
      server: { url: base, publishableKey: 'sb_publishable_test' },
      storage: { getItem: (k) => memory.get(k) ?? null, setItem: (k, v) => void memory.set(k, v), removeItem: (k) => void memory.delete(k) },
      openExternal: async (url) => void opened.push(url),
      onChange: () => {},
      listen: (ms) => listenForCallback(ms, [0]),
      autoRefresh: false
    })
    expect((await account.refresh()).state).toBe('signed-out')

    const waiting = await account.sendEmailLink(STUDENT.email)
    expect(waiting).toMatchObject({ state: 'waiting', waitingFor: 'email', email: STUDENT.email })
    expect(emailedLink).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/)

    // The student clicks the link: Supabase sends their browser back to the app with a code.
    const page = await (await fetch(`${emailedLink}?code=code-from-the-email`)).text()
    expect(page).toContain("You're signed in")
    await until(() => account.current.state === 'needs-invite', 'the session')
    expect(account.current.email).toBe(STUDENT.email)
  })

  it("can't use Claude before entering an invite code", async () => {
    const tutor = new Tutor(createTransport(env(), 'tutor', () => account.accessToken())!)
    await expect(tutor.start({ text: 'Integrate x e^x' })).rejects.toThrow('Finish setting up your account: enter your invite code.')
    expect(toClaude).toHaveLength(0)
  })

  it('enters an invite code and confirms they are 18+', async () => {
    expect((await account.activate('nope', true)).error).toBe("That invite code isn't valid, or it has been used up.")
    const ready = await account.activate('lehigh-ta', true)
    expect(ready).toMatchObject({ state: 'ready', error: null, usage: { problemsLeft: 20, problemsLimit: 20, asksLeft: 60 } })
  })

  it('solves a problem: the tutor goes through the server, with our key and our choice of model', async () => {
    const transport = createTransport(env(), 'tutor', () => account.accessToken())!
    expect(transport.provider).toBe('clueless')
    const reply = await new Tutor(transport).start({ text: 'Integrate x e^x' })
    expect(reply.problem?.title).toBe('Integrate x e^x')
    expect(reply.turn.message).toBe('Which part would you call u?')

    const sent = toClaude.at(-1)!
    expect(sent.headers.get('x-api-key')).toBe('server-key')
    expect(sent.headers.get('authorization')).toBeNull()
    expect(sent.body.model).toBe('claude-sonnet-5-5')
    expect(db.events).toMatchObject([{ user_id: STUDENT.id, job: 'tutor', unit: 'problem', input_tokens: 1200, output_tokens: 300 }])
    expect((await account.refresh()).usage?.problemsLeft).toBe(19)
  })

  it('asks about a highlight: a streamed reply from the fast model, counted once it has been read', async () => {
    const tracer = new Tracer(
      { tutor: createTransport(env(), 'tutor', () => account.accessToken())!, fast: createTransport(env(), 'fast', () => account.accessToken())! },
      null
    )
    const reply = await tracer.ask({ snippet: 'x = 1', image: null, animate: false })
    expect(reply.message).toBe('It sets x to 1.')
    expect(toClaude.at(-1)!.body).toMatchObject({ model: 'claude-haiku-5-5', stream: true })
    await Promise.all(pending)
    expect(db.events.at(-1)).toMatchObject({ job: 'fast', unit: 'ask', model: 'claude-haiku-5-5', output_tokens: 90 })
  })

  it('starts a problem on one laptop and continues it on another', async () => {
    const stuck = { start() {}, stop() {}, snooze() {}, noteActivity() {}, noteWrongStreak() {} }
    const controllerOn = (laptop: HistoryStore): SessionController =>
      new SessionController({
        makeTutor: () => new Tutor(createTransport(env(), 'tutor', () => account.accessToken())!),
        memory: () => laptop,
        captureScreen: async () => null,
        emit: () => {},
        stuck
      })

    // Laptop A: the session saves as it goes, then goes up to the account.
    const laptopA = new HistoryStore(null)
    const syncA = new HistorySync(laptopA, account.supabase, () => {})
    await controllerOn(laptopA).startProblem({ text: 'Integrate x e^x' })
    const id = laptopA.list()[0].id
    expect(laptopA.secret(id)?.solution).toBe('(x-1)e^x + C')
    await syncA.sync()
    expect(laptopA.hasPending).toBe(false)
    expect(laptopA.secret(id)).toBeNull() // the hidden solution has left the laptop...
    expect(db.secrets.get(id)?.hidden_solution).toBe('(x-1)e^x + C') // ...for the locked table
    expect(JSON.stringify(db.sessions.get(id))).not.toContain('(x-1)e^x') // and the session row never had it

    // Laptop B: the list arrives without conversations; opening a session downloads it.
    const laptopB = new HistoryStore(null)
    const syncB = new HistorySync(laptopB, account.supabase, () => {})
    await syncB.sync()
    expect(laptopB.list()).toMatchObject([{ id, title: 'Integrate x e^x', downloaded: false }])
    const saved = await syncB.open(id)
    expect(saved?.thread?.length).toBeGreaterThan(0)

    // Continue: the server puts the hidden solution back before Claude sees it, and it's not a new problem.
    await controllerOn(laptopB).resume(saved!, serverHidden(id))
    const seed = JSON.stringify(toClaude.at(-1)!.body.messages)
    expect(seed).toContain('[CONTINUE]')
    expect(seed).toContain('[HIDDEN SOLUTION] (x-1)e^x + C')
    expect(seed).not.toContain('{{hidden')
    expect(db.events.at(-1)).toMatchObject({ job: 'tutor', unit: null })

    // Deleting it on laptop B removes it everywhere.
    laptopB.remove(id)
    await syncB.sync()
    await syncA.sync()
    expect(db.sessions.has(id)).toBe(false)
    expect(laptopA.list()).toEqual([])
    syncA.stop()
    syncB.stop()
  })

  it("is stopped at the weekly limit with a plain message, and Claude isn't called", async () => {
    db.problemsLimit = 1
    const calls = toClaude.length
    const tutor = new Tutor(createTransport(env(), 'tutor', () => account.accessToken())!)
    await expect(tutor.start({ text: 'Another one' })).rejects.toThrow("You've used this week's 1 free problem. It resets on Monday.")
    expect(toClaude).toHaveLength(calls)
    db.problemsLimit = 20
  })

  it('signs out, and the app stops sending requests', async () => {
    expect((await account.signOut()).state).toBe('signed-out')
    expect(await account.accessToken()).toBeNull()
    const calls = toClaude.length
    const tutor = new Tutor(createTransport(env(), 'tutor', () => account.accessToken())!)
    await expect(tutor.start({ text: 'Integrate x e^x' })).rejects.toThrow('Sign in to Clueless first.')
    expect(toClaude).toHaveLength(calls)
  })
})
