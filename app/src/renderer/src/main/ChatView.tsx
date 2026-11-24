// Chat in the main window: the same tutor session as the floating panel (one problem at a time,
// shared between them), shown in full. Reading the screen tucks this window away first.
import { useEffect, useMemo, useState, type FormEvent } from 'react'
import type { AppStatus, SessionView } from '../../../shared/contracts'
import { toSpeech } from '../../../shared/speechText'
import { api } from '../api'
import { MonitorIcon, SelectAreaIcon, SendIcon } from '../components/icons'
import { Button, hotkeyLabel, Kbd } from '../components/ui'
import { SessionScreen } from '../screens/Session'
import { speech } from '../voice/speaker'
import { useSpeech } from '../voice/useSpeech'
import type { VoiceConversation } from '../voice/useVoiceConversation'

export function ChatView({ status }: { status: AppStatus }) {
  const [session, setSession] = useState<SessionView | null>(null)
  const conv = useQuietConversation()

  useEffect(() => {
    void api.getSession().then(setSession)
    return api.onSession(setSession)
  }, [])

  if (!session || (!session.problem && !session.busy && !session.error)) return <StartChat status={status} />

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl pb-10">
        <SessionScreen session={session} conv={conv} onOpenGaps={() => {}} fullThread />
      </div>
    </div>
  )
}

/** Nothing started: read the screen, pick the problem, or type it. */
function StartChat({ status }: { status: AppStatus }) {
  const [text, setText] = useState('')
  const ready = Boolean(status.provider)

  const submit = (e: FormEvent): void => {
    e.preventDefault()
    if (!text.trim() || !ready) return
    api.askText(text.trim())
    setText('')
  }

  return (
    <div className="flex h-full flex-col items-center justify-center px-8 pb-16">
      <h1 className="text-2xl font-semibold tracking-tight">What are you stuck on?</h1>
      <p className="mt-2 max-w-md text-center text-sm text-zinc-500 dark:text-zinc-400">
        Clueless walks you through it with questions and hints, not the answer.
      </p>
      <form onSubmit={submit} className="mt-6 w-full max-w-2xl">
        <div className="flex items-end gap-2 rounded-2xl border border-zinc-900/10 bg-white p-2 shadow-sm focus-within:border-claude-500 dark:border-white/15 dark:bg-white/5">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) submit(e)
            }}
            rows={3}
            placeholder={ready ? 'Paste or type the problem…' : 'Sign in first (Profile), then type the problem here…'}
            className="selectable max-h-60 min-h-[4.5rem] flex-1 resize-none bg-transparent px-2 py-1 text-[14px] outline-none placeholder:text-zinc-400"
          />
          <Button variant="primary" type="submit" disabled={!text.trim() || !ready} className="h-9 w-9 !px-0" title="Start">
            <SendIcon size={16} />
          </Button>
        </div>
      </form>
      <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
        <Button onClick={() => api.askFromMain('screen')} disabled={!ready}>
          <MonitorIcon size={15} /> Read my screen
        </Button>
        <Button onClick={() => api.askFromMain('area')} disabled={!ready}>
          <SelectAreaIcon size={15} /> Select the problem
        </Button>
      </div>
      <p className="mt-6 flex items-center gap-1.5 text-xs text-zinc-400">
        Anywhere, any app: <Kbd>{hotkeyLabel(status.hotkeys.ask, status.platform)}</Kbd> reads your screen
      </p>
    </div>
  )
}

const IDLE_INPUT: VoiceConversation['input'] = {
  state: 'idle',
  heard: '',
  interim: '',
  level: 0,
  notice: null,
  start: async () => {},
  stop: () => {},
  cancel: () => {}
}

/**
 * Voice stays in the floating panel (one recording at a time, and replies read aloud once): here
 * the mic opens the panel, and "read aloud" works on request.
 */
function useQuietConversation(): VoiceConversation {
  const snap = useSpeech()
  return useMemo(
    () => ({
      enabled: false,
      setEnabled: () => api.showPanel(),
      input: IDLE_INPUT,
      speech: snap,
      processing: false,
      talk: () => api.showPanel(),
      toggleMic: () => api.showPanel(),
      readAloud: (markdown: string) => speech.speak(toSpeech(markdown))
    }),
    [snap]
  )
}
