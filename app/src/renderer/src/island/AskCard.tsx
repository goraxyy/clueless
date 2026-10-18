// The answer to Ask or Animate, in the panel: what was highlighted, the latest question and
// answer, and follow-ups. An Animate run plays in the visual island (it has the controls); here
// there's just where it's at, Stop, and Replay once it's off the screen.
import { useEffect, useState, type KeyboardEvent } from 'react'
import { stepCount, type IslandView } from '../../../shared/contracts'
import { CloseIcon, PlayIcon, RetryIcon, SendIcon, SpeakerIcon, SpeakerOffIcon, StopIcon } from '../components/icons'
import { Markdown } from '../components/Markdown'
import { Button, cx, IconButton } from '../components/ui'
import { speech } from '../voice/speaker'
import { useVoiceMode, voiceMode } from '../voice/voiceMode'
import { islandApi } from './api'

export function AskCard({ view, onReadAloud }: { view: IslandView; onReadAloud?: (markdown: string) => void }) {
  const last = view.messages[view.messages.length - 1]
  const answer = last?.role === 'clueless' ? last.text : null
  // The student's latest follow-up: still waiting for its answer, or the one the answer is for.
  const asked = [...view.messages].reverse().find((m) => m.role === 'student')
  const showAsked = asked && (view.phase === 'thinking' || view.messages[view.messages.length - 2] === asked)

  return (
    <div className="space-y-2 px-3 py-2.5" data-ask-card>
      <div className="flex items-center gap-2">
        <span className="shrink-0 rounded-full bg-claude-500/15 px-2 py-px text-[10.5px] font-semibold uppercase tracking-wide text-claude-700 dark:text-claude-400">
          {view.animate ? 'Animate' : 'Ask'}
        </span>
        {view.snippet && <SnippetPreview text={view.snippet} />}
        <VoiceToggle />
        <IconButton title="Close" onClick={() => islandApi.close()} className="h-6 w-6 shrink-0">
          <CloseIcon size={13} />
        </IconButton>
      </div>

      {showAsked && (
        <div className="flex items-start gap-2 text-[12.5px]">
          <span className="mt-px shrink-0 text-[10px] font-semibold uppercase tracking-wide text-zinc-400">You</span>
          <span className="selectable line-clamp-2 text-zinc-700 dark:text-zinc-300">{asked.text}</span>
        </div>
      )}
      {view.phase === 'thinking' && <Thinking since={view.busySince} animate={view.animate} />}
      {view.phase === 'answer' && answer && (
        <div className="group relative rounded-xl border border-zinc-900/10 bg-white/70 py-2 pl-3 pr-7 text-[13px] text-zinc-800 dark:border-white/10 dark:bg-black/35 dark:text-zinc-100">
          {onReadAloud && (
            <IconButton
              title="Read aloud"
              onClick={() => onReadAloud(answer)}
              className="absolute right-1 top-1 h-6 w-6 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
            >
              <SpeakerIcon size={13} />
            </IconButton>
          )}
          <div className="selectable">
            <Markdown text={answer} />
          </div>
        </div>
      )}
      {view.error && <div className="rounded-lg bg-rose-50 px-2.5 py-1.5 text-xs text-rose-700 dark:bg-rose-950/50 dark:text-rose-200">{view.error}</div>}
      {view.notice && <div className="rounded-lg bg-zinc-100 px-2.5 py-1.5 text-xs text-zinc-600 dark:bg-white/10 dark:text-zinc-300">{view.notice}</div>}
      {view.phase === 'answer' && stepCount(view) > 0 && <Playback view={view} />}
      {view.phase === 'answer' && !view.error && <FollowUp />}
    </div>
  )
}

/** Voice on: Ask's answers are read aloud (an animation has its own voice, in the visual island). */
function VoiceToggle() {
  const on = useVoiceMode()
  return (
    <IconButton
      title={on ? 'Voice is on: answers are read aloud. Click to turn it off' : 'Read answers aloud'}
      aria-pressed={on}
      onClick={() => {
        voiceMode.set(!on)
        if (on) speech.stop()
      }}
      className={cx('ml-auto h-6 w-6 shrink-0', on && 'text-claude-600 dark:text-claude-400')}
    >
      {on ? <SpeakerIcon size={13} /> : <SpeakerOffIcon size={13} />}
    </IconButton>
  )
}

function SnippetPreview({ text }: { text: string }) {
  const lines = text.trim().split('\n')
  return (
    <div className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-zinc-500 dark:text-zinc-400">
      {lines[0].trim()}
      {lines.length > 1 && <span className="text-zinc-400 dark:text-zinc-500"> · {lines.length} lines</span>}
    </div>
  )
}

function Thinking({ since, animate }: { since: number | null; animate: boolean }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  const seconds = since ? Math.max(0, Math.round((now - since) / 1000)) : 0
  return (
    <div className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
      <span className="flex gap-0.5">
        <span className="busy-dot h-1.5 w-1.5 rounded-full bg-claude-500" />
        <span className="busy-dot h-1.5 w-1.5 rounded-full bg-claude-500" />
        <span className="busy-dot h-1.5 w-1.5 rounded-full bg-claude-500" />
      </span>
      {animate ? 'Making the animation…' : 'Reading what you highlighted…'}
      <span className="tabular-nums text-zinc-400">{seconds}s</span>
    </div>
  )
}

/** Where the animation is at (its controls are in the visual island), or Replay once it's off the screen. */
function Playback({ view }: { view: IslandView }) {
  const total = stepCount(view)
  const p = view.playback
  if (!p) {
    return (
      <div className="flex items-center gap-2">
        <Button variant="chip" onClick={() => islandApi.replay()} title="Play the animation again">
          <RetryIcon size={12} /> Replay the animation
        </Button>
        <span className="text-[11px] text-zinc-400">{total} steps</span>
      </div>
    )
  }
  return (
    <div className="flex items-center gap-2 text-[11.5px] text-zinc-500 dark:text-zinc-400">
      <PlayIcon size={11} className={cx('shrink-0 text-claude-500', p.playing && 'animate-pulse')} />
      <span className="min-w-0 flex-1 truncate">
        {p.index < 0 ? 'Starting the animation' : p.playing ? 'Animating' : 'Paused'} · step {Math.max(0, p.index + 1)} of {total}
      </span>
      <Button variant="chip" onClick={() => islandApi.stop()} title="Take the animation off the screen">
        <StopIcon size={11} /> Stop
      </Button>
    </div>
  )
}

function FollowUp() {
  const [text, setText] = useState('')
  const send = (): void => {
    if (!text.trim()) return
    islandApi.followUp(text.trim())
    setText('')
  }
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      send()
    }
  }
  return (
    <div className="no-drag flex items-center gap-1.5 rounded-lg border border-zinc-900/10 bg-white/70 py-0.5 pl-2.5 pr-0.5 focus-within:border-claude-500 dark:border-white/15 dark:bg-black/30">
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Ask a follow-up about this…"
        className="h-8 min-w-0 flex-1 bg-transparent text-[13px] text-zinc-800 outline-none placeholder:text-zinc-400 dark:text-zinc-100"
      />
      <IconButton title="Send" onClick={send} disabled={!text.trim()} className="h-7 w-7 bg-claude-500 text-white hover:bg-claude-400 disabled:opacity-40">
        <SendIcon size={13} />
      </IconButton>
    </div>
  )
}
