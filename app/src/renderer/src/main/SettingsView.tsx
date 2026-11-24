// Settings: starting up, permissions, hotkeys, and where your own Claude key goes.
import type { ReactNode } from 'react'
import type { AppSettings, AppStatus } from '../../../shared/contracts'
import { api } from '../api'
import { cx, hotkeyLabel, Kbd } from '../components/ui'
import { Card, Page } from './MainApp'
import { PermissionsList } from './SetupView'

export function SettingsView({
  status,
  settings,
  onSettings
}: {
  status: AppStatus
  settings: AppSettings
  onSettings: (s: AppSettings) => void
}) {
  const set = (patch: Partial<AppSettings>): void => void api.setSettings(patch).then(onSettings)
  return (
    <Page title="Settings">
      <div className="max-w-2xl space-y-4">
        <Section title="Starting up">
          <Toggle
            label="Open Clueless when you log in"
            hint="It starts in the menu bar, ready for the hotkeys."
            on={settings.openAtLogin}
            onChange={(on) => set({ openAtLogin: on })}
          />
          <Toggle
            label="Show this window when Clueless opens"
            hint="Off: it opens straight to the floating panel."
            on={settings.openMainOnLaunch}
            onChange={(on) => set({ openMainOnLaunch: on })}
          />
        </Section>

        <Section title="Permissions">
          <PermissionsList />
        </Section>

        <Section title="Hotkeys">
          <div className="space-y-2 text-[13.5px]">
            <Row label="Read your screen" keys={hotkeyLabel(status.hotkeys.ask, status.platform)} />
            <Row label="Select just the problem" keys={hotkeyLabel(status.hotkeys.area, status.platform)} />
            <Row label="Talk" keys={hotkeyLabel('CommandOrControl+Shift+1', status.platform)} />
            <Row label="Show or hide the island" keys={hotkeyLabel('CommandOrControl+Shift+3', status.platform)} />
            {status.hotkeyErrors.length > 0 && (
              <p className="text-[12px] text-rose-600 dark:text-rose-400">Taken by another app: {status.hotkeyErrors.join('; ')}</p>
            )}
          </div>
        </Section>

        <Section title="Your own Claude access">
          <p className="text-[13px] text-zinc-500">
            {status.provider === 'clueless'
              ? 'Clueless runs through your account. To use your own Claude API key or Amazon Bedrock instead, put it in '
              : status.provider
                ? `Using your own ${status.provider === 'bedrock' ? 'Amazon Bedrock' : 'Claude API key'} (${status.model}), from `
                : 'No Claude access yet. Sign in (Profile), or put a Claude API key or Bedrock settings in '}
            <code className="selectable break-all font-mono text-[12px]">{status.envFile}</code>.
          </p>
        </Section>
      </div>
    </Page>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card>
      <div className="mb-3 text-[14px] font-semibold">{title}</div>
      {children}
    </Card>
  )
}

function Row({ label, keys }: { label: string; keys: string }) {
  return (
    <div className="flex items-center justify-between">
      <span>{label}</span>
      <Kbd>{keys}</Kbd>
    </div>
  )
}

function Toggle({ label, hint, on, onChange }: { label: string; hint: string; on: boolean; onChange: (on: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center gap-3 py-1.5">
      <div className="min-w-0 flex-1">
        <div className="text-[13.5px]">{label}</div>
        <div className="text-[12px] text-zinc-500">{hint}</div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        onClick={() => onChange(!on)}
        className={cx('no-drag relative h-5 w-9 rounded-full transition-colors', on ? 'bg-claude-500' : 'bg-zinc-300 dark:bg-white/20')}
      >
        <span className={cx('absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all', on ? 'left-[18px]' : 'left-0.5')} />
      </button>
    </label>
  )
}
