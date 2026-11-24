// First run: sign in, allow what Clueless needs, then the hotkeys. Also exports the sign-in form and
// the permissions list that Profile and Settings reuse.
import { useEffect, useState, type FormEvent } from 'react'
import type { AppStatus, PermissionKind, PermissionsState } from '../../../shared/contracts'
import { api } from '../api'
import { CheckIcon, Logo } from '../components/icons'
import { Button, hotkeyLabel, isMac, Kbd } from '../components/ui'
import { Card } from './MainApp'

type Step = 'account' | 'permissions' | 'ready'

export function SetupView({ status, onDone }: { status: AppStatus; onDone: () => void }) {
  const needsAccount = status.account.configured && !status.account.signedIn && !status.provider
  const [step, setStep] = useState<Step>(needsAccount ? 'account' : 'permissions')

  // Signed in from this screen: on to permissions.
  useEffect(() => {
    if (step === 'account' && (status.account.signedIn || status.provider)) setStep('permissions')
  }, [status.account.signedIn, status.provider, step])

  return (
    <div className="drag flex h-full flex-col items-center justify-center px-8">
      <div className="no-drag w-full max-w-md">
        <div className="mb-6 flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-b from-claude-400 to-claude-500 text-white shadow-sm">
            <Logo size={19} />
          </div>
          <span className="text-xl font-semibold tracking-tight">Welcome to Clueless</span>
        </div>
        {step === 'account' && (
          <>
            <p className="mb-4 text-sm text-zinc-500 dark:text-zinc-400">
              Clueless helps you through problems with questions and hints, not answers. Sign in to start: no API key needed.
            </p>
            <Card>
              <SignInForm />
            </Card>
          </>
        )}
        {step === 'permissions' && (
          <>
            <p className="mb-4 text-sm text-zinc-500 dark:text-zinc-400">
              {isMac(status.platform)
                ? 'Clueless needs a few things from macOS. It only reads your screen when you ask it to.'
                : 'Clueless only reads your screen when you ask it to.'}
            </p>
            <Card>
              <PermissionsList />
            </Card>
            <div className="mt-4 flex justify-end">
              <Button variant="primary" onClick={() => setStep('ready')}>
                Continue
              </Button>
            </div>
          </>
        )}
        {step === 'ready' && (
          <>
            <p className="mb-4 text-sm text-zinc-500 dark:text-zinc-400">
              Clueless lives in the menu bar and works over any app, even full-screen ones.
            </p>
            <Card className="space-y-2.5 text-[13.5px]">
              <HotkeyRow keys={hotkeyLabel(status.hotkeys.ask, status.platform)} label="Read your screen" />
              <HotkeyRow keys={hotkeyLabel(status.hotkeys.area, status.platform)} label="Select just the problem" />
              <HotkeyRow keys={hotkeyLabel('CommandOrControl+Shift+1', status.platform)} label="Talk" />
              <HotkeyRow keys={hotkeyLabel('CommandOrControl+Shift+3', status.platform)} label="Show or hide the island" />
              <p className="pt-1 text-[12.5px] text-zinc-500">Highlight anything, in any app, for Ask and Animate buttons.</p>
            </Card>
            <div className="mt-4 flex justify-end">
              <Button variant="primary" onClick={onDone}>
                Start
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function HotkeyRow({ keys, label }: { keys: string; label: string }) {
  return (
    <div className="flex items-center justify-between">
      <span>{label}</span>
      <Kbd>{keys}</Kbd>
    </div>
  )
}

/** Email, then the 6-digit code from the email. The status update afterwards moves things on. */
export function SignInForm() {
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    const result = sent ? await api.verifyCode(email, code) : await api.sendCode(email)
    setBusy(false)
    if (!result.ok) return setError(result.message)
    if (!sent) setSent(true)
  }

  const field =
    'selectable h-10 w-full rounded-lg border border-zinc-900/10 bg-white px-3 text-[14px] outline-none focus:border-claude-500 dark:border-white/15 dark:bg-black/20'
  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="text-[13.5px] font-medium">{sent ? `We sent a code to ${email}` : 'Your email'}</div>
      {sent ? (
        <input
          key="code"
          className={`${field} font-mono tracking-[0.3em]`}
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="123456"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 10))}
          autoFocus
        />
      ) : (
        <input
          key="email"
          className={field}
          type="email"
          autoComplete="email"
          placeholder="you@school.edu"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoFocus
        />
      )}
      {error && <div className="text-[12.5px] text-rose-600 dark:text-rose-400">{error}</div>}
      <div className="flex items-center gap-2">
        {sent && (
          <button
            type="button"
            className="no-drag text-[12.5px] text-zinc-500 underline underline-offset-2"
            onClick={() => {
              setSent(false)
              setCode('')
              setError(null)
            }}
          >
            Use another email
          </button>
        )}
        <Button variant="primary" type="submit" disabled={busy || (sent ? code.length < 6 : !email.trim())} className="ml-auto">
          {busy ? 'One moment…' : sent ? 'Sign in' : 'Email me a code'}
        </Button>
      </div>
    </form>
  )
}

const PERMISSIONS: { kind: PermissionKind; label: string; why: string }[] = [
  { kind: 'screen', label: 'Screen Recording', why: 'To read the problem on your screen when you press the hotkey.' },
  { kind: 'microphone', label: 'Microphone', why: 'Only while you hold the talk button.' },
  { kind: 'accessibility', label: 'Accessibility', why: 'To notice when you highlight something, for Ask and Animate.' }
]

/** What macOS has allowed, with a button for each that isn't. Checks again every 2 seconds, since
 *  the switches are flipped in System Settings. */
export function PermissionsList() {
  const [state, setState] = useState<PermissionsState | null>(null)

  useEffect(() => {
    const load = (): void => void api.getPermissions().then(setState)
    load()
    const timer = setInterval(load, 2000)
    return () => clearInterval(timer)
  }, [])

  if (!state) return null
  const granted = (kind: PermissionKind): boolean =>
    kind === 'accessibility' ? state.accessibility : (kind === 'screen' ? state.screen : state.microphone) === 'granted'

  return (
    <div className="space-y-3">
      {PERMISSIONS.map(({ kind, label, why }) => (
        <div key={kind} className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-[13.5px] font-medium">{label}</div>
            <div className="text-[12px] text-zinc-500">{why}</div>
          </div>
          {granted(kind) ? (
            <span className="flex items-center gap-1 text-[12.5px] text-emerald-600 dark:text-emerald-400">
              <CheckIcon size={14} /> Allowed
            </span>
          ) : (
            <Button variant="chip" onClick={() => void api.requestPermission(kind).then(setState)}>
              Allow
            </Button>
          )}
        </div>
      ))}
      {state.screen !== 'granted' && (
        <p className="text-[12px] text-zinc-500">After allowing Screen Recording, macOS may ask you to quit and reopen Clueless.</p>
      )}
    </div>
  )
}
