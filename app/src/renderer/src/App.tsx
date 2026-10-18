import { MotionConfig } from 'motion/react'
import { useEffect, useRef, useState } from 'react'
import type { AppStatus, SessionView, WindowMode } from '../../shared/contracts'
import { api } from './api'
import { islandApi } from './island/api'
import { AskCard } from './island/AskCard'
import { useAnswerReadAloud } from './island/useNarration'
import { IslandScreen, SelectionButtons, useIslandView } from './island/IslandScreen'
import { VisualIsland } from './island/VisualIsland'
import { AreaSelector } from './screens/AreaSelector'
import { Banners, CompactBar, EmptyState, GLASS_ALPHA, Header, SettingsMenu, type Glass } from './screens/Home'
import { GapsScreen } from './screens/Gaps'
import { SessionScreen } from './screens/Session'
import { VoiceStrip } from './components/MicButton'
import { useVoiceConversation } from './voice/useVoiceConversation'
import { StageScreen } from './island/TraceStage'
import { speech } from './voice/speaker'
import { toSpeech } from '../../shared/speechText'

// One renderer, several windows, picked by the URL hash:
//   (none)   the tutor panel           #select  drag a box around the problem
//   #stage   drawn over the student's screen (the tutor's code animations, Animate's line highlight)
//   #island  the island's pill         #ask     the Ask / Animate buttons next to the cursor
//   #visual  the visual island: an Animate run's picture, voice and controls
export function App() {
  const hash = window.location.hash
  if (hash === '#select') return <AreaSelector />
  if (hash === '#ask') {
    return (
      <div className="flex h-full items-start p-1.5">
        <SelectionButtons />
      </div>
    )
  }
  return (
    <MotionConfig reducedMotion="user">
      {hash === '#stage' ? <StageScreen /> : hash === '#island' ? <IslandScreen /> : hash === '#visual' ? <VisualIsland /> : <Overlay />}
    </MotionConfig>
  )
}

/** The window size for this state. Animations play in their own window, never in the panel. */
function windowMode(compact: boolean): WindowMode {
  return compact ? 'compact' : 'expanded'
}

function Overlay() {
  const [status, setStatus] = useState<AppStatus | null>(null)
  const [session, setSession] = useState<SessionView | null>(null)
  const [screen, setScreen] = useState<'main' | 'gaps'>('main')
  const [compact, setCompact] = useState(false)
  const [glass, setGlass] = useState<Glass>(loadGlass)
  const [size, setSize] = useState<PanelSize>(loadSize)
  const [menu, setMenu] = useState(false)
  const islandView = useIslandView()
  const asking = Boolean(islandView && islandView.phase !== 'idle')
  useAnswerReadAloud(islandView)

  useEffect(() => {
    void api.getStatus().then(setStatus)
    void api.getSession().then(setSession)
    const offSession = api.onSession(setSession)
    const offStatus = api.onStatus(setStatus)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') api.hide()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      offSession()
      offStatus()
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  // A new problem: back to the main screen, full size.
  useEffect(() => {
    if (!session?.id) return
    setScreen('main')
    setCompactMode(false)
  }, [session?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // A new Ask: its answer shows here, so open the panel up.
  useEffect(() => {
    if (!asking) return
    setScreen('main')
    setCompact(false)
    api.setWindowMode(windowMode(false))
  }, [asking])

  // The panel and its window always change size together (the pill has a smaller window).
  const setCompactMode = (next: boolean): void => {
    setCompact(next)
    api.setWindowMode(windowMode(next))
  }
  const toggleCompact = (): void => {
    setMenu(false)
    setCompactMode(!compact)
  }

  // Settings → New session: drop the problem and any Ask, back to the start.
  const newSession = (): void => {
    setMenu(false)
    speech.stop()
    islandApi.close()
    api.action('new')
    setScreen('main')
  }

  // The small window's box: a follow-up to an Ask, an answer to the tutor, or (with nothing
  // started yet) the problem itself. The big window opens to show the reply.
  const submitText = (text: string): void => {
    if (islandView?.phase === 'answer' && !islandView.error) islandApi.followUp(text)
    else if (session?.problem) api.send({ text, as: 'text' })
    else api.askText(text)
    if (compact) setCompactMode(false)
  }

  // Voice lives here, not in the session screen, so the compact pill can talk too.
  // What you say is sent exactly like a typed answer; with no problem yet, it becomes the problem.
  const conv = useVoiceConversation({
    session,
    disabled: Boolean(session?.busy),
    onSpoken: (text) => {
      if (session?.problem) {
        api.send({ text, as: 'text' })
      } else {
        api.askText(text)
      }
      if (compact) setCompactMode(false) // open the panel to show the reply
    }
  })

  // The window is exactly as tall as the panel (plus the settings card under the small window):
  // small when there's little to show.
  const panel = useRef<HTMLDivElement>(null)
  const stack = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = stack.current
    if (!el) return
    let frame = 0
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => api.fitHeight(Math.ceil(el.getBoundingClientRect().height)))
    })
    observer.observe(el)
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
    }
  }, [])

  // A saved width from last time: apply it once the window exists.
  useEffect(() => {
    if (size.width) api.resizeWidth(size.width, 'right')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const changeSize = (next: PanelSize): void => {
    setSize(next)
    try {
      localStorage.setItem('clueless.size', JSON.stringify(next))
    } catch {
      // storage unavailable: the size just won't persist
    }
  }

  const changeGlass = (g: Glass): void => {
    setGlass(g)
    try {
      localStorage.setItem('clueless.glass', g)
    } catch {
      // storage unavailable: the setting just won't persist
    }
  }

  return (
    <div className="relative p-2" data-app-ready>
      <div ref={stack} className="flex flex-col">
      <div
        ref={panel}
        className={
          // overflow-clip, not overflow-hidden: a hidden box can still be scrolled (focusing the
          // answer box did that), which pushed the header out of the top of a short panel.
          'glass-panel relative flex flex-col overflow-clip text-zinc-900 shadow-xl dark:text-zinc-100 ' +
          (compact ? 'rounded-[26px] ' : 'rounded-2xl ') +
          (glass === 'clear' ? 'glass-clear ' : '') +
          'w-full'
        }
        style={
          {
            '--glass': GLASS_ALPHA[glass],
            maxHeight: window.screen.availHeight - 64,
            // The dragged height is a minimum: a longer reply grows the panel (up to maxHeight).
            minHeight: size.height && !compact ? Math.min(size.height, window.screen.availHeight - 64) : undefined
          } as React.CSSProperties
        }
      >
        {compact ? (
          <>
            <CompactBar
              conv={conv}
              busy={Boolean(session?.busy)}
              menuOpen={menu}
              onToggleMenu={() => setMenu(!menu)}
              onExpand={toggleCompact}
              onSubmit={submitText}
            />
            {/* Talking from the small window: your words appear right under it. */}
            <div className="px-2 empty:hidden">
              <VoiceStrip voice={conv.input} onDismiss={conv.input.cancel} />
            </div>
          </>
        ) : (
          <Header
            stuck={session?.stuck ?? null}
            menuOpen={menu}
            onToggleMenu={() => setMenu(!menu)}
            onShrink={toggleCompact}
            onOpenGaps={() => {
              setMenu(false)
              setScreen('gaps')
            }}
          />
        )}
        {menu && !compact && (
          <SettingsMenu glass={glass} onGlass={changeGlass} onNewSession={newSession} onClose={() => setMenu(false)} overContent />
        )}
        {!compact && (
          <>
            <Banners status={status} />
            <div className="panel-body">
              <div className="panel-main">
                {screen === 'gaps' ? (
                  <GapsScreen onBack={() => setScreen('main')} />
                ) : asking ? (
                  <AskCard view={islandView!} onReadAloud={(markdown) => speech.speak(toSpeech(markdown))} />
                ) : session ? (
                  <SessionScreen
                    session={session}
                    onOpenGaps={() => setScreen('gaps')}
                    conv={conv}
                  />
                ) : (
                  <EmptyState status={status} />
                )}
              </div>
            </div>
          </>
        )}
      </div>
      {/* The small window keeps its shape: settings slide down as a card of their own under it. */}
      {menu && compact && (
        <SettingsMenu glass={glass} onGlass={changeGlass} onNewSession={newSession} onClose={() => setMenu(false)} overContent={false} />
      )}
      </div>
      {!compact && <ResizeGrips panel={panel} size={size} onSize={changeSize} />}
    </div>
  )
}

/** User-chosen panel size. null = default (416px wide, as tall as its content). */
interface PanelSize {
  width: number | null
  height: number | null
}

function loadSize(): PanelSize {
  try {
    const saved = JSON.parse(localStorage.getItem('clueless.size') ?? 'null')
    if (saved && typeof saved === 'object') {
      return {
        width: typeof saved.width === 'number' ? saved.width : null,
        height: typeof saved.height === 'number' ? saved.height : null
      }
    }
  } catch {
    // storage unavailable or garbled: use the default
  }
  return { width: null, height: null }
}

type Edge = 'left' | 'right' | 'bottom' | 'bottom-left' | 'bottom-right'

const GRIPS: { edge: Edge; className: string }[] = [
  { edge: 'left', className: 'left-0 top-3 bottom-3 w-2.5 cursor-ew-resize' },
  { edge: 'right', className: 'right-0 top-3 bottom-3 w-2.5 cursor-ew-resize' },
  { edge: 'bottom', className: 'bottom-0 left-3 right-3 h-2.5 cursor-ns-resize' },
  { edge: 'bottom-left', className: 'bottom-0 left-0 h-4 w-4 cursor-nesw-resize' },
  { edge: 'bottom-right', className: 'bottom-0 right-0 h-4 w-4 cursor-nwse-resize' }
]

/**
 * Drag handles on the panel's edges. Transparent windows can't be resized natively, so the
 * width goes to the main process and the height becomes the panel's own (the window follows it).
 * Double-click a handle to go back to the default size.
 */
function ResizeGrips({
  panel,
  size,
  onSize
}: {
  panel: React.RefObject<HTMLDivElement | null>
  size: PanelSize
  onSize: (s: PanelSize) => void
}) {
  const start = (edge: Edge) => (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    const x0 = e.screenX
    const y0 = e.screenY
    const w0 = window.innerWidth
    const h0 = panel.current?.getBoundingClientRect().height ?? 300
    const maxH = window.screen.availHeight - 64
    let next = { ...size }
    const move = (ev: PointerEvent): void => {
      const dx = ev.screenX - x0
      const dy = ev.screenY - y0
      if (edge !== 'bottom') {
        const left = edge === 'left' || edge === 'bottom-left'
        const width = Math.round(left ? w0 - dx : w0 + dx)
        api.resizeWidth(width, left ? 'right' : 'left')
        next = { ...next, width: Math.max(320, Math.min(width, 960)) }
      }
      if (edge.startsWith('bottom')) {
        next = { ...next, height: Math.round(Math.max(160, Math.min(h0 + dy, maxH))) }
        onSize(next)
      }
    }
    const up = (): void => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      onSize(next)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }

  const reset = (): void => {
    api.resizeWidth(416, 'right')
    onSize({ width: null, height: null })
  }

  return (
    <>
      {GRIPS.map((g) => (
        <div
          key={g.edge}
          className={'no-drag absolute z-50 ' + g.className}
          onPointerDown={start(g.edge)}
          onDoubleClick={reset}
          title="Drag to resize · double-click to reset"
        />
      ))}
    </>
  )
}

function loadGlass(): Glass {
  try {
    const saved = localStorage.getItem('clueless.glass')
    if (saved === 'glass' || saved === 'clear' || saved === 'solid') return saved
  } catch {
    // storage unavailable: use the default
  }
  return 'glass'
}
