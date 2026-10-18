// The island: a dark pill at the top of the screen with one switch, "Highlight": while it's on,
// highlighting anything brings up two buttons next to the cursor. Ask explains it in the panel
// (AskCard); Animate also plays it step by step, with a voice, in the visual island
// (VisualIsland) while the line it's on lights up on the screen (TraceStage).
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { IslandView } from '../../../shared/contracts'
import { ChevronDownIcon, Logo, PlayIcon } from '../components/icons'
import { cx } from '../components/ui'
import { islandApi } from './api'

export function IslandScreen() {
  const view = useIslandView()
  return view ? <Pill view={view} /> : null
}

export function useIslandView(): IslandView | null {
  const [view, setView] = useState<IslandView | null>(null)
  useEffect(() => {
    void islandApi.getView().then(setView)
    return islandApi.onView(setView)
  }, [])
  return view
}

const DARK = 'border border-white/10 bg-zinc-900/90 shadow-[0_12px_40px_rgba(0,0,0,0.45)] backdrop-blur'

/** The pill. Reports its size so the window fits it. */
export function Pill({ view }: { view: IslandView }) {
  const root = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = root.current
    if (!el) return
    const report = (): void => {
      const r = el.getBoundingClientRect()
      islandApi.resize({ width: Math.ceil(r.width), height: Math.ceil(r.height) })
    }
    report()
    const ro = new ResizeObserver(report)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return (
    <div ref={root} className="inline-flex p-2.5 text-zinc-100" data-app-ready>
      <div className={cx('flex h-12 items-center gap-1.5 rounded-full pl-1.5 pr-1.5', DARK)}>
        <div
          className={cx('flex h-9 w-9 items-center justify-center rounded-full bg-claude-500 text-white', view.phase === 'thinking' && 'animate-pulse')}
          title={view.phase === 'thinking' ? 'Thinking…' : 'Clueless'}
        >
          <Logo size={19} />
        </div>
        <Switch
          label="Highlight"
          on={view.askOnHighlight}
          onChange={(on) => islandApi.setAskOnHighlight(on)}
          title={
            view.askOnHighlight
              ? 'On: highlight anything to get Ask and Animate buttons'
              : 'Off: highlighting does nothing (turn it off in a terminal, where Ctrl+C stops programs)'
          }
        />
        <button
          type="button"
          onClick={() => islandApi.hide()}
          title="Hide (Ctrl/⌘+Shift+3 brings it back)"
          className="flex h-9 items-center gap-1 rounded-full bg-white/[0.07] pl-2 pr-3 text-[13px] font-medium hover:bg-white/[0.12]"
        >
          <ChevronDownIcon size={15} /> Hide
        </button>
      </div>
    </div>
  )
}

function Switch({ label, on, onChange, title }: { label: string; on: boolean; onChange: (on: boolean) => void; title: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      title={title}
      className="flex h-9 items-center gap-2 rounded-full bg-white/[0.07] px-3 text-[13px] font-medium hover:bg-white/[0.12]"
    >
      {label}
      <span className={cx('relative h-[18px] w-8 rounded-full transition-colors', on ? 'bg-claude-500' : 'bg-zinc-600')}>
        <span className={cx('absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white shadow transition-[left]', on ? 'left-[16px]' : 'left-[2px]')} />
      </span>
    </button>
  )
}

/** The window next to the cursor after a highlight: Ask (explain it in the panel) or Animate
 *  (explain it with an animation and a voice, in the visual island). */
export function SelectionButtons() {
  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        onClick={() => islandApi.ask(false)}
        title="Explain this in the panel"
        className="flex h-9 items-center gap-1.5 rounded-full bg-claude-500 pl-2 pr-4 text-[14px] font-semibold text-zinc-950 shadow-[0_6px_20px_rgba(0,0,0,0.35)] ring-1 ring-black/10 hover:bg-claude-400"
      >
        <Logo size={17} /> Ask
      </button>
      <button
        type="button"
        onClick={() => islandApi.ask(true)}
        title="Explain it with an animation and a voice"
        className="flex h-9 items-center gap-1.5 rounded-full bg-zinc-900 pl-2.5 pr-4 text-[14px] font-semibold text-zinc-50 shadow-[0_6px_20px_rgba(0,0,0,0.35)] ring-1 ring-white/15 hover:bg-zinc-800"
      >
        <PlayIcon size={14} className="text-claude-400" /> Animate
      </button>
    </div>
  )
}
