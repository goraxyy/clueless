// The main window (#main): an ordinary app window, opened from Finder or the menu bar. Chat with the
// tutor, past problems, flashcards, your account and settings. First run: setup (sign in, then
// permissions). The floating panel and the island keep working beside it.
import { useEffect, useState, type ReactNode } from 'react'
import type { AppSettings, AppStatus, Flashcard } from '../../../shared/contracts'
import { api } from '../api'
import { CardIcon, ChatIcon, GearIcon, HistoryIcon, Logo, PanelIcon, UserIcon } from '../components/icons'
import { cx } from '../components/ui'
import { ChatView } from './ChatView'
import { FlashcardsView } from './FlashcardsView'
import { HistoryView } from './HistoryView'
import { ProfileView } from './ProfileView'
import { SettingsView } from './SettingsView'
import { SetupView } from './SetupView'

export type Page = 'chat' | 'history' | 'flashcards' | 'profile' | 'settings'

const NAV: { page: Page; label: string; icon: (p: { size?: number }) => ReactNode }[] = [
  { page: 'chat', label: 'Chat', icon: ChatIcon },
  { page: 'history', label: 'History', icon: HistoryIcon },
  { page: 'flashcards', label: 'Flashcards', icon: CardIcon },
  { page: 'profile', label: 'Profile', icon: UserIcon },
  { page: 'settings', label: 'Settings', icon: GearIcon }
]

export function MainApp() {
  const [status, setStatus] = useState<AppStatus | null>(null)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [page, setPage] = useState<Page>('chat')
  const due = useDueCount()

  useEffect(() => {
    void api.getStatus().then(setStatus)
    void api.getSettings().then(setSettings)
    return api.onStatus(setStatus)
  }, [])

  if (!status || !settings) return <div className="h-full bg-zinc-50 dark:bg-zinc-900" />

  if (!settings.setupDone) {
    return (
      <Frame>
        <SetupView status={status} onDone={() => void api.setSettings({ setupDone: true }).then(setSettings)} />
      </Frame>
    )
  }

  return (
    <Frame>
      <div className="flex h-full min-h-0">
        <aside className="flex w-56 shrink-0 flex-col border-r border-zinc-900/10 bg-zinc-100/70 dark:border-white/10 dark:bg-black/25">
          <div className="drag h-12 shrink-0" />
          <div className="flex items-center gap-2 px-4 pb-4 pt-1">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-b from-claude-400 to-claude-500 text-white shadow-sm">
              <Logo size={15} />
            </div>
            <span className="text-[15px] font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">Clueless</span>
          </div>
          <nav className="flex flex-col gap-0.5 px-2">
            {NAV.map(({ page: p, label, icon: Icon }) => (
              <button
                key={p}
                type="button"
                onClick={() => setPage(p)}
                className={cx(
                  'no-drag flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13.5px] transition-colors',
                  page === p
                    ? 'bg-white font-medium text-zinc-900 shadow-sm dark:bg-white/10 dark:text-white'
                    : 'text-zinc-600 hover:bg-zinc-900/5 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-white/5 dark:hover:text-zinc-100'
                )}
              >
                <Icon size={15} />
                {label}
                {p === 'flashcards' && due > 0 && (
                  <span className="ml-auto rounded-full bg-claude-500 px-1.5 text-[10.5px] font-semibold text-white">{due}</span>
                )}
              </button>
            ))}
          </nav>
          <div className="mt-auto space-y-2 p-3">
            <button
              type="button"
              onClick={() => api.showPanel()}
              className="no-drag flex w-full items-center gap-2 rounded-lg border border-zinc-900/10 px-2.5 py-1.5 text-[12.5px] text-zinc-600 hover:bg-white dark:border-white/10 dark:text-zinc-300 dark:hover:bg-white/10"
              title="The floating panel works over any app, even full-screen ones"
            >
              <PanelIcon size={14} /> Show the floating panel
            </button>
            {status.account.signedIn && (
              <div className="truncate px-1 text-[11.5px] text-zinc-400" title={status.account.email ?? ''}>
                {status.account.email}
              </div>
            )}
          </div>
        </aside>
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="drag h-12 shrink-0" />
          <div className="min-h-0 flex-1">
            {page === 'chat' && <ChatView status={status} />}
            {page === 'history' && <HistoryView />}
            {page === 'flashcards' && <FlashcardsView />}
            {page === 'profile' && <ProfileView status={status} />}
            {page === 'settings' && <SettingsView status={status} settings={settings} onSettings={setSettings} />}
          </div>
        </main>
      </div>
    </Frame>
  )
}

/** The window's solid background (the panel's windows are see-through; this one isn't). */
function Frame({ children }: { children: ReactNode }) {
  return <div className="h-full bg-zinc-50 text-zinc-900 dark:bg-zinc-900 dark:text-zinc-100">{children}</div>
}

/** Flashcards due for review now: the badge in the sidebar. */
function useDueCount(): number {
  const [cards, setCards] = useState<Flashcard[]>([])
  useEffect(() => {
    const load = (): void => void api.listCards().then(setCards)
    load()
    const off = api.onMemoryChanged(load)
    const timer = setInterval(load, 60_000) // cards come due as time passes
    return () => {
      off()
      clearInterval(timer)
    }
  }, [])
  const now = Date.now()
  return cards.filter((c) => Date.parse(c.due) <= now).length
}

/** A page's title row and scrollable body. */
export function Page({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 px-8 pb-4">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        <div className="ml-auto flex items-center gap-2">{actions}</div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-8 pb-8">{children}</div>
    </div>
  )
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cx('rounded-xl border border-zinc-900/10 bg-white p-4 dark:border-white/10 dark:bg-white/5', className)}>{children}</div>
  )
}

export function formatDate(iso: string): string {
  const d = new Date(iso)
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' })
}
