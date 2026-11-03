// Signing in: Google or an email link (both finish in the browser), then the beta invite code and
// the 18+ confirmation. Shown in place of everything else until the account is ready.
import { useState } from 'react'
import type { AccountView, UsageView } from '../../../shared/contracts'
import { api } from '../api'
import { Logo } from '../components/icons'
import { Button, cx } from '../components/ui'

const input =
  'no-drag h-9 w-full rounded-lg border border-zinc-900/10 bg-white/60 px-3 text-[13px] text-zinc-900 outline-none transition-colors placeholder:text-zinc-400 focus:border-claude-400/70 dark:border-white/15 dark:bg-white/[0.06] dark:text-zinc-50 dark:placeholder:text-zinc-500'

export function AccountScreen({ account }: { account: AccountView }) {
  return (
    <div className="flex flex-col items-center px-7 pb-6 pt-6 text-center">
      <div className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-gradient-to-b from-claude-400 to-claude-500 text-white shadow-sm">
        <Logo size={18} />
      </div>
      {account.state === 'waiting' ? (
        <Waiting account={account} />
      ) : account.state === 'needs-invite' ? (
        <Invite account={account} />
      ) : (
        <SignIn account={account} />
      )}
    </div>
  )
}

function SignIn({ account }: { account: AccountView }) {
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const run = (work: () => Promise<unknown>) => async (): Promise<void> => {
    setBusy(true)
    try {
      await work()
    } finally {
      setBusy(false)
    }
  }
  const sendLink = run(() => api.accountEmail(email))
  return (
    <>
      <h1 className="mt-3 text-[17px] font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">Sign in to Clueless</h1>
      <p className="mt-0.5 text-[12.5px] text-zinc-500 dark:text-zinc-400">Free during the beta, for college students 18 and older.</p>
      <Button variant="primary" className="mt-5 w-full" disabled={busy} onClick={run(() => api.accountGoogle())}>
        <GoogleMark /> Continue with Google
      </Button>
      <div className="mt-3 flex w-full items-center gap-3 text-[11.5px] text-zinc-400 dark:text-zinc-500">
        <span className="h-px flex-1 bg-zinc-900/10 dark:bg-white/10" />
        or
        <span className="h-px flex-1 bg-zinc-900/10 dark:bg-white/10" />
      </div>
      <form
        className="mt-3 flex w-full flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (email.trim()) void sendLink()
        }}
      >
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@school.edu"
          autoComplete="email"
          className={input}
        />
        <Button type="submit" disabled={busy || !email.trim()} className="w-full">
          Email me a sign-in link
        </Button>
      </form>
      <ErrorLine text={account.error} />
    </>
  )
}

function Waiting({ account }: { account: AccountView }) {
  return (
    <>
      <h1 className="mt-3 text-[17px] font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
        {account.waitingFor === 'email' ? 'Check your email' : 'Finish in your browser'}
      </h1>
      <p className="mt-1 text-[12.5px] text-zinc-500 dark:text-zinc-400">
        {account.waitingFor === 'email' ? (
          <>
            We sent a link to <span className="font-medium text-zinc-700 dark:text-zinc-200">{account.email}</span>. Open it on this
            computer and Clueless signs you in.
          </>
        ) : (
          'Sign in with Google in the browser window that just opened. Clueless continues by itself.'
        )}
      </p>
      <div className="mt-4 flex items-center gap-2 text-[12px] text-zinc-400">
        <span className="glow-dot h-2 w-2 rounded-full bg-claude-500" /> Waiting…
      </div>
      <Button variant="ghost" className="mt-3" onClick={() => void api.accountCancel()}>
        {account.waitingFor === 'email' ? 'Use a different email' : 'Cancel'}
      </Button>
    </>
  )
}

function Invite({ account }: { account: AccountView }) {
  const [code, setCode] = useState('')
  const [adult, setAdult] = useState(false)
  const [busy, setBusy] = useState(false)
  const submit = async (): Promise<void> => {
    setBusy(true)
    try {
      await api.accountActivate(code, adult)
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <h1 className="mt-3 text-[17px] font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">One more step</h1>
      <p className="mt-0.5 text-[12.5px] text-zinc-500 dark:text-zinc-400">
        Clueless is invite-only during the beta. Your class or a friend can give you a code.
      </p>
      <form
        className="mt-5 flex w-full flex-col gap-2.5 text-left"
        onSubmit={(e) => {
          e.preventDefault()
          if (code.trim() && adult) void submit()
        }}
      >
        <input
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          placeholder="Invite code"
          autoFocus
          spellCheck={false}
          className={cx(input, 'font-mono tracking-wider')}
        />
        <label className="no-drag flex cursor-pointer items-center gap-2 text-[12.5px] text-zinc-600 dark:text-zinc-300">
          <input type="checkbox" checked={adult} onChange={(e) => setAdult(e.target.checked)} className="accent-claude-500" />
          I&apos;m 18 or older
        </label>
        <Button type="submit" variant="primary" disabled={busy || !code.trim() || !adult} className="w-full">
          Start using Clueless
        </Button>
      </form>
      <ErrorLine text={account.error} />
      <p className="mt-4 text-[11.5px] text-zinc-400 dark:text-zinc-500">
        Signed in as {account.email ?? 'you'} ·{' '}
        <button type="button" className="no-drag underline-offset-2 hover:underline" onClick={() => void api.accountSignOut()}>
          Sign out
        </button>
      </p>
    </>
  )
}

function ErrorLine({ text }: { text: string | null }) {
  if (!text) return null
  return <p className="mt-3 text-[12px] text-rose-600 dark:text-rose-400">{text}</p>
}

/** "14 of 20 problems left this week" and when the week resets, for the settings card. */
export function usageLines(usage: UsageView): { main: string; detail: string } {
  const resets = usage.resetsAt
    ? new Date(usage.resetsAt).toLocaleString(undefined, { weekday: 'long', hour: 'numeric', minute: '2-digit' })
    : 'next week'
  if (usage.limitReached || (usage.problemsLeft === 0 && usage.asksLeft === 0)) {
    return { main: "This week's free use is used up", detail: `Resets ${resets}` }
  }
  return {
    main: `${usage.problemsLeft} of ${usage.problemsLimit} problems left this week`,
    detail: `${usage.asksLeft} of ${usage.asksLimit} Asks left · resets ${resets}`
  }
}

/** Google's "G", in its colors. */
function GoogleMark() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true" className="rounded-full bg-white p-px">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.76h3.57c2.08-1.92 3.27-4.74 3.27-8.09z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z" />
      <path fill="#FBBC05" d="M5.84 14.1A6.6 6.6 0 0 1 5.5 12c0-.73.13-1.44.34-2.1V7.06H2.18A11 11 0 0 0 1 12c0 1.78.43 3.46 1.18 4.94l3.66-2.84z" />
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1A11 11 0 0 0 2.18 7.06l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z" />
    </svg>
  )
}
