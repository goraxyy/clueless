// Settings: everything a student used to set in .env, and more. Account and this week's use, voice,
// shortcuts (click one, press new keys), the Highlight switch, transparency, permissions and data.
import { useEffect, useState, type ReactNode } from 'react'
import type { AppStatus, HotkeyName } from '../../../shared/contracts'
import { acceleratorFor } from '../../../shared/accelerator'
import { api } from '../api'
import { islandApi } from '../island/api'
import { useIslandView } from '../island/IslandScreen'
import { BackIcon } from '../components/icons'
import { Button, cx, hotkeyLabel, IconButton, isMac } from '../components/ui'
import { VOICE_KEY } from '../voice/speech'
import { speech } from '../voice/speaker'
import { useVoiceMode, voiceMode } from '../voice/voiceMode'
import { usageLines } from './Account'
import { PermissionList, usePermissions } from './FirstRun'
import type { Glass } from './Home'

const HOTKEYS: { name: HotkeyName; label: string }[] = [
  { name: 'ask', label: 'Read my screen' },
  { name: 'area', label: 'Select just the problem' },
  { name: 'voice', label: 'Talk to Clueless' },
  { name: 'island', label: 'Show or hide the island' }
]

export function SettingsScreen({ status, glass, onGlass, onBack }: { status: AppStatus; glass: Glass; onGlass: (g: Glass) => void; onBack: () => void }) {
  const account = status.account?.state === 'ready' ? status.account : null
  const usage = account?.usage ? usageLines(account.usage) : null
  const [permissions, askPermission] = usePermissions()
  const [wipe, setWipe] = useState(false)

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-zinc-900/10 px-3 py-2 dark:border-white/10">
        <IconButton title="Back" onClick={onBack}>
          <BackIcon size={15} />
        </IconButton>
        <span className="text-xs font-medium text-zinc-700 dark:text-zinc-200">Settings</span>
        <span className="ml-auto text-[11px] text-zinc-400">Clueless {status.version}</span>
      </div>
      <div className="max-h-[440px] space-y-4 overflow-y-auto px-3 py-3">
        {account && (
          <Section title="Account">
            <Row label={account.email ?? 'Signed in'} detail={usage ? `${usage.main}. ${usage.detail}` : undefined}>
              <Button variant="chip" onClick={() => void api.accountSignOut()}>
                Sign out
              </Button>
            </Row>
          </Section>
        )}

        <Section title="Voice">
          <ReadAloud />
          <VoicePicker />
        </Section>

        <Section title="Shortcuts">
          {HOTKEYS.map((h) => (
            <HotkeyRow key={h.name} name={h.name} label={h.label} accelerator={status.hotkeys[h.name]} platform={status.platform} />
          ))}
        </Section>

        <Section title="Highlights">
          <HighlightSwitch />
        </Section>

        <Section title="Look">
          <Row label="Transparency">
            <div className="flex gap-1">
              {(['glass', 'clear', 'solid'] as Glass[]).map((g) => (
                <Button key={g} variant="chip" className={cx('capitalize', g === glass && '!border-claude-500 !text-claude-600 dark:!text-claude-400')} onClick={() => onGlass(g)}>
                  {g}
                </Button>
              ))}
            </div>
          </Row>
        </Section>

        <Section title="Permissions">
          <PermissionList view={permissions} onAsk={askPermission} platform={status.platform} />
        </Section>

        <Section title="Your data">
          <Row label="History" detail="Every saved session and the gaps it found, on every computer.">
            <Button
              variant="chip"
              className={cx(wipe && '!border-rose-400 !text-rose-600 dark:!text-rose-400')}
              onClick={() => (wipe ? void api.deleteAllHistory().then(() => setWipe(false)) : setWipe(true))}
            >
              {wipe ? 'Delete everything?' : 'Delete all'}
            </Button>
          </Row>
        </Section>
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-zinc-400">{title}</h2>
      <div className="space-y-1.5">{children}</div>
    </section>
  )
}

function Row({ label, detail, children }: { label: string; detail?: string; children?: ReactNode }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-zinc-900/10 bg-white/50 px-2.5 py-2 dark:border-white/10 dark:bg-white/[0.04]">
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12.5px] text-zinc-800 dark:text-zinc-100">{label}</div>
        {detail && <div className="text-[11px] text-zinc-500 dark:text-zinc-400">{detail}</div>}
      </div>
      {children}
    </div>
  )
}

function Toggle({ on, onChange, label }: { on: boolean; onChange: (on: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      className={cx('no-drag relative h-5 w-9 shrink-0 rounded-full transition-colors', on ? 'bg-claude-500' : 'bg-zinc-300 dark:bg-zinc-600')}
    >
      <span className={cx('absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all', on ? 'left-[18px]' : 'left-0.5')} />
    </button>
  )
}

function ReadAloud() {
  const on = useVoiceMode()
  return (
    <Row label="Read replies aloud" detail="Clueless speaks its replies, and the mic is a click away.">
      <Toggle on={on} onChange={(next) => voiceMode.set(next)} label="Read replies aloud" />
    </Row>
  )
}

/** The computer's own voices in the student's language ("Automatic" picks a natural-sounding one). */
function VoicePicker() {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([])
  const [chosen, setChosen] = useState(() => {
    try {
      return localStorage.getItem(VOICE_KEY) ?? ''
    } catch {
      return ''
    }
  })
  useEffect(() => {
    if (typeof speechSynthesis === 'undefined') return
    const base = navigator.language.toLowerCase().split('-')[0]
    const load = (): void =>
      setVoices(speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().startsWith(base)).sort((a, b) => a.name.localeCompare(b.name)))
    load()
    speechSynthesis.addEventListener('voiceschanged', load)
    return () => speechSynthesis.removeEventListener('voiceschanged', load)
  }, [])
  const choose = (name: string): void => {
    setChosen(name)
    try {
      if (name) localStorage.setItem(VOICE_KEY, name)
      else localStorage.removeItem(VOICE_KEY)
    } catch {
      // storage unavailable: the choice lasts until the window closes
    }
  }
  return (
    <Row label="Voice" detail="Your computer's own voices.">
      <select
        value={chosen}
        onChange={(e) => choose(e.target.value)}
        className="no-drag h-7 max-w-[150px] rounded-md border border-zinc-900/10 bg-white/70 px-1.5 text-[12px] text-zinc-800 outline-none dark:border-white/15 dark:bg-black/40 dark:text-zinc-100"
      >
        <option value="">Automatic</option>
        {voices.map((v) => (
          <option key={v.voiceURI} value={v.name}>
            {v.name}
          </option>
        ))}
      </select>
      <Button variant="chip" onClick={() => speech.speak('This is how Clueless sounds.')}>
        Try
      </Button>
    </Row>
  )
}

/** Click, then press the new keys. Escape cancels. */
function HotkeyRow({ name, label, accelerator, platform }: { name: HotkeyName; label: string; accelerator: string; platform: string }) {
  const [recording, setRecording] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
    if (!recording) return
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation() // Escape here cancels the recording, not hides the panel
      if (e.code === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey) return setRecording(false)
      const next = acceleratorFor(e, isMac(platform))
      if (!next) return // a modifier on its own: keep listening
      setRecording(false)
      void api.setHotkey(name, next).then(setProblem)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [recording, name, platform])

  return (
    <Row label={label} detail={problem ?? (recording ? 'Press the new keys, or Escape to cancel.' : undefined)}>
      <button
        type="button"
        onClick={() => {
          setProblem(null)
          setRecording(!recording)
        }}
        title="Click, then press the new keys"
        className={cx(
          'no-drag min-w-[96px] rounded-md border px-2 py-1 text-center font-mono text-[11.5px] transition-colors',
          recording
            ? 'border-claude-500 bg-claude-50 text-claude-700 dark:bg-claude-600/10 dark:text-claude-300'
            : 'border-zinc-900/10 bg-white/70 text-zinc-700 hover:border-claude-400 dark:border-white/15 dark:bg-black/40 dark:text-zinc-200'
        )}
      >
        {recording ? 'Press keys…' : hotkeyLabel(accelerator, platform)}
      </button>
    </Row>
  )
}

function HighlightSwitch() {
  const island = useIslandView()
  const on = island?.askOnHighlight ?? true
  return (
    <Row label="Ask and Animate on highlights" detail="Buttons appear next to text you highlight in any app.">
      <Toggle on={on} onChange={(next) => islandApi.setAskOnHighlight(next)} label="Ask and Animate on highlights" />
    </Row>
  )
}
