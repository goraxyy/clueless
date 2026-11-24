// Profile: who you are, your plan and this month's use, and what you've worked on.
import { useEffect, useState } from 'react'
import type { AccountUsage, AppStatus, Flashcard, MemoryView, SessionSummary } from '../../../shared/contracts'
import { api } from '../api'
import { Button } from '../components/ui'
import { Card, Page } from './MainApp'
import { SignInForm } from './SetupView'

export function ProfileView({ status }: { status: AppStatus }) {
  // undefined: loading · null: the server couldn't be reached
  const [usage, setUsage] = useState<AccountUsage | null | undefined>(undefined)
  const [history, setHistory] = useState<SessionSummary[]>([])
  const [cards, setCards] = useState<Flashcard[]>([])
  const [memory, setMemory] = useState<MemoryView | null>(null)

  useEffect(() => {
    if (status.account.signedIn) {
      setUsage(undefined)
      void api.getUsage().then(setUsage)
    } else {
      setUsage(null)
    }
  }, [status.account.signedIn])

  useEffect(() => {
    const load = (): void => {
      void api.listHistory().then(setHistory)
      void api.listCards().then(setCards)
      void api.getMemory().then(setMemory)
    }
    load()
    return api.onMemoryChanged(load)
  }, [])

  const solved = history.filter((h) => h.solved).length
  const hints = history.reduce((n, h) => n + h.hintsUsed, 0)

  return (
    <Page title="Profile">
      <div className="max-w-2xl space-y-4">
        <Card>
          {!status.account.configured ? (
            <p className="text-[13.5px] text-zinc-500">
              This copy of Clueless uses your own Claude access, set in <code className="selectable font-mono text-[12.5px]">{status.envFile}</code>.
            </p>
          ) : status.account.signedIn ? (
            <Account email={status.account.email} usage={usage} />
          ) : (
            <>
              <div className="mb-3 text-[15px] font-semibold">Sign in</div>
              <SignInForm />
            </>
          )}
        </Card>

        <div className="grid grid-cols-4 gap-3">
          <Stat label="Problems" value={history.length} />
          <Stat label="Solved" value={solved} />
          <Stat label="Hints used" value={hints} />
          <Stat label="Flashcards" value={cards.length} />
        </div>

        {memory && memory.gaps.length > 0 && (
          <Card>
            <div className="mb-2 text-[14px] font-semibold">What trips you up most</div>
            <div className="space-y-1.5">
              {memory.gaps.slice(0, 8).map((g) => (
                <div key={g.id} className="flex items-center gap-2 text-[13px]">
                  <span className="min-w-0 flex-1 truncate">{g.topic}</span>
                  <span className="text-[12px] text-zinc-400">{g.subject}</span>
                  <span className="w-10 text-right text-[12px] text-zinc-500">{g.timesSeen}×</span>
                </div>
              ))}
            </div>
          </Card>
        )}
      </div>
    </Page>
  )
}

function Account({ email, usage }: { email: string | null; usage: AccountUsage | null | undefined }) {
  const used = usage && usage.limitMicro > 0 ? Math.min(100, Math.round((usage.spentMicro / usage.limitMicro) * 100)) : null
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-semibold">{email}</div>
          <div className="text-[12.5px] text-zinc-500">
            {usage ? (usage.plan === 'pro' ? 'Pro plan' : 'Free plan') : usage === undefined ? 'Loading…' : "Couldn't reach Clueless to show your plan."}
          </div>
        </div>
        <Button variant="ghost" onClick={() => void api.signOut()}>
          Sign out
        </Button>
      </div>
      {usage && used !== null && (
        <div>
          <div className="mb-1 flex justify-between text-[12.5px] text-zinc-500">
            <span>{used}% of this month's Clueless used</span>
            <span>Resets {new Date(usage.resetsAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-zinc-200 dark:bg-white/10">
            <div className="h-full rounded-full bg-claude-500" style={{ width: `${used}%` }} />
          </div>
        </div>
      )}
      {usage?.plan === 'free' && usage.upgradeUrl && (
        <div className="flex items-center gap-3 rounded-lg bg-claude-50 p-3 dark:bg-claude-500/10">
          <div className="flex-1 text-[13px]">
            <div className="font-medium">Clueless Pro</div>
            <div className="text-zinc-500">About eight times this month's allowance, every month.</div>
          </div>
          <Button variant="primary" onClick={() => api.openExternal(usage.upgradeUrl!)}>
            Upgrade
          </Button>
        </div>
      )}
      {usage?.plan === 'pro' && usage.manageUrl && (
        <Button onClick={() => api.openExternal(usage.manageUrl!)}>Manage subscription</Button>
      )}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <Card className="p-3">
      <div className="text-xl font-semibold">{value}</div>
      <div className="text-[12px] text-zinc-500">{label}</div>
    </Card>
  )
}
