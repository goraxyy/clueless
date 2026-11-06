// The first time Clueless opens (after signing in): the three things macOS has to allow, each with
// a live tick, then a sample problem to try. Settings shows the same permission list later.
import { useEffect, useRef, useState } from 'react'
import type { AppStatus, PermissionName, PermissionsView } from '../../../shared/contracts'
import { api } from '../api'
import { CheckIcon, Logo } from '../components/icons'
import { Button, cx, hotkeyLabel } from '../components/ui'

const SAMPLE_PROBLEM = 'Find the derivative of f(x) = x² · sin(x).'

const ROWS: { name: PermissionName; title: string; why: string }[] = [
  { name: 'screen', title: 'Screen Recording', why: 'So Clueless can read the problem on your screen. Needed.' },
  { name: 'accessibility', title: 'Accessibility', why: 'So Ask and Animate appear when you highlight text. Optional.' },
  { name: 'microphone', title: 'Microphone', why: 'So you can talk to Clueless. Optional.' }
]

/** The permissions, checked every second and a half while shown (they change in System Settings). */
export function usePermissions(): [PermissionsView | null, (name: PermissionName) => void] {
  const [view, setView] = useState<PermissionsView | null>(null)
  useEffect(() => {
    let alive = true
    const read = (): void => void api.getPermissions().then((v) => alive && setView(v))
    read()
    const timer = setInterval(read, 1500)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])
  const ask = (name: PermissionName): void => void api.askPermission(name).then(setView)
  return [view, ask]
}

export function PermissionList({ view, onAsk, platform }: { view: PermissionsView | null; onAsk: (name: PermissionName) => void; platform: string }) {
  // macOS applies Screen Recording only after a restart: offer one once the student has gone to allow it.
  const screenAtStart = useRef<string | null>(null)
  if (view && screenAtStart.current === null) screenAtStart.current = view.screen
  const [askedScreen, setAskedScreen] = useState(false)
  const restartNote = platform === 'darwin' && screenAtStart.current !== 'granted' && (askedScreen || view?.screen === 'granted')
  const ask = (name: PermissionName): void => {
    if (name === 'screen') setAskedScreen(true)
    onAsk(name)
  }
  return (
    <div className="flex flex-col gap-1.5">
      {ROWS.map((row) => {
        const granted = view?.[row.name] === 'granted'
        return (
          <div key={row.name} className="flex items-center gap-2.5 rounded-lg border border-zinc-900/10 bg-white/50 px-2.5 py-2 text-left dark:border-white/10 dark:bg-white/[0.04]">
            <span
              className={cx(
                'flex h-5 w-5 shrink-0 items-center justify-center rounded-full',
                granted ? 'bg-emerald-500 text-white' : 'border border-zinc-300 dark:border-zinc-600'
              )}
            >
              {granted && <CheckIcon size={12} strokeWidth={3} />}
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[12.5px] font-medium text-zinc-800 dark:text-zinc-100">{row.title}</div>
              <div className="text-[11px] text-zinc-500 dark:text-zinc-400">{row.why}</div>
            </div>
            {!granted && view && (
              <Button variant="chip" onClick={() => ask(row.name)}>
                {platform === 'darwin' ? 'Allow' : 'Open settings'}
              </Button>
            )}
          </div>
        )
      })}
      {restartNote && (
        <p className="px-1 text-[11px] text-zinc-500 dark:text-zinc-400">
          After switching Screen Recording on, restart Clueless so macOS applies it.{' '}
          <button type="button" className="no-drag font-medium text-claude-600 hover:underline dark:text-claude-400" onClick={() => api.relaunch()}>
            Restart Clueless
          </button>
        </p>
      )}
    </div>
  )
}

export function FirstRunScreen({ status }: { status: AppStatus }) {
  const [view, ask] = usePermissions()
  const askKey = hotkeyLabel(status.hotkeys.ask, status.platform)
  const tryIt = (): void => {
    api.finishFirstRun()
    api.askText(SAMPLE_PROBLEM)
  }
  return (
    <div className="flex flex-col items-center px-6 pb-5 pt-5 text-center">
      <div className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-gradient-to-b from-claude-400 to-claude-500 text-white shadow-sm">
        <Logo size={18} />
      </div>
      <h1 className="mt-3 text-[17px] font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">Welcome to Clueless</h1>
      <p className="mt-0.5 text-[12.5px] text-zinc-500 dark:text-zinc-400">A few things to allow first. You can change them later in Settings.</p>
      <div className="mt-4 w-full">
        <PermissionList view={view} onAsk={ask} platform={status.platform} />
      </div>
      <p className="mt-3 text-[12px] text-zinc-500 dark:text-zinc-400">
        Any time you're stuck, press <span className="font-medium text-zinc-700 dark:text-zinc-200">{askKey}</span> and Clueless reads your screen.
      </p>
      <Button variant="primary" className="mt-4 w-full" onClick={tryIt}>
        Try it on a sample problem
      </Button>
      <button type="button" className="no-drag mt-2 text-[12px] text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-100" onClick={() => api.finishFirstRun()}>
        Skip for now
      </button>
    </div>
  )
}
