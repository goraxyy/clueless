// Code mode ("Animate my code"): drawn on the student's real code, in a click-through window
// that covers the screen. Highlights the lines each frame is about, floats the animated data
// structure next to them, and draws an arrow from the lines to it. Plays once, then freezes.
import { motion } from 'motion/react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { StageIsland, StageShow } from '../../../shared/contracts'
import { api } from '../api'
import { TraceStage } from '../island/TraceStage'
import { FrameDots } from './AnimationPane'
import { arrowPath, placeCard } from '../../../shared/layout'
import { SceneView } from './SceneView'
import { useFramePlayer } from './useFramePlayer'

const SPRING = { type: 'spring', stiffness: 260, damping: 30 } as const
const clamp01 = (v: number): number => Math.max(0, Math.min(1, v))

/** The stage window's whole page (#stage): the tutor's visual over the code, or an Animate run's line highlight. */
export function StageScreen() {
  const [show, setShow] = useState<StageShow | null>(null)
  const [island, setIsland] = useState<StageIsland | null>(null)
  useEffect(() => api.onStage(setShow), [])
  useEffect(() => api.onStageIsland(setIsland), [])
  return (
    <>
      {show && <CodeOverlay show={show} />}
      {island?.view && <TraceStage view={island.view} island={island.island} />}
    </>
  )
}

export function CodeOverlay({ show }: { show: StageShow }) {
  const { visual, nonce, avoid } = show
  const area = show.area.rect
  const player = useFramePlayer(visual.frames.length, nonce)
  const scene = visual.frames[player.index]

  // The lines this frame is about. Frames without their own focus keep the last one.
  const focus = visual.focus.length ? visual.focus[Math.min(player.index, visual.focus.length - 1)] : null
  const top = area.y + clamp01(Math.min(focus?.top ?? 0, focus?.bottom ?? 1)) * area.height
  const bottom = Math.max(top + 14, area.y + clamp01(Math.max(focus?.top ?? 0, focus?.bottom ?? 1)) * area.height)
  const anchorY = focus ? (top + bottom) / 2 : area.y + 24

  const view = useViewport()
  const card = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 380, height: 260 })
  useLayoutEffect(() => {
    const el = card.current
    if (!el) return
    const measure = (): void => setSize((s) => (s.width === el.offsetWidth && s.height === el.offsetHeight ? s : { width: el.offsetWidth, height: el.offsetHeight }))
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const place = placeCard(area, size, view, avoid, anchorY)

  return (
    <div className="pointer-events-none fixed inset-0 overflow-hidden">
      {/* the selected code */}
      <motion.div
        key={`area-${nonce}`}
        className="absolute rounded-md border-2 border-dashed border-claude-500/80"
        style={{ left: area.x - 4, top: area.y - 4, width: area.width + 8, height: area.height + 8 }}
        initial={{ opacity: 0, scale: 1.02 }}
        animate={{ opacity: 1, scale: 1 }}
      />
      {/* the lines this frame is about */}
      {focus && (
        <motion.div
          className="absolute rounded-sm border-l-4 border-claude-500 bg-claude-500/25"
          style={{ left: area.x - 2, width: area.width + 4 }}
          initial={false}
          animate={{ top: top - 2, height: bottom - top + 4 }}
          transition={SPRING}
        />
      )}
      {place.arrow && (
        <svg className="absolute inset-0 h-full w-full overflow-visible">
          <defs>
            <marker id="stage-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
              <path d="M0 0L10 5L0 10z" fill="#d97757" />
            </marker>
          </defs>
          <motion.path
            key={`arrow-${nonce}`}
            fill="none"
            stroke="#d97757"
            strokeWidth={2.5}
            strokeLinecap="round"
            markerEnd="url(#stage-arrow)"
            style={{ filter: 'drop-shadow(0 1px 2px rgb(0 0 0 / 0.4))' }}
            initial={{ pathLength: 0, d: arrowPath(place.arrow.from, place.arrow.to, place.side) }}
            animate={{ pathLength: 1, d: arrowPath(place.arrow.from, place.arrow.to, place.side) }}
            transition={{ pathLength: { duration: 0.5 }, d: SPRING }}
          />
        </svg>
      )}
      {/* the animated data structure, floating next to the code */}
      <motion.div
        ref={card}
        className="absolute w-max max-w-[440px] rounded-xl border border-zinc-900/10 bg-white/92 p-3 text-zinc-900 shadow-2xl dark:border-white/15 dark:bg-zinc-950/88 dark:text-zinc-100"
        initial={{ opacity: 0, left: place.card.x, top: place.card.y }}
        animate={{ opacity: 1, left: place.card.x, top: place.card.y }}
        transition={SPRING}
      >
        <div className="mb-2 flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-claude-500" />
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-600 dark:text-zinc-300">{visual.caption || 'Your code, step by step'}</span>
          <span className="text-[11px] tabular-nums text-zinc-400">
            {player.index + 1} / {visual.frames.length}
          </span>
        </div>
        {scene && <SceneView scene={scene} />}
        <div className="mt-2">
          <FrameDots count={visual.frames.length} index={player.index} />
        </div>
      </motion.div>
    </div>
  )
}

function useViewport(): { width: number; height: number } {
  const [size, setSize] = useState({ width: window.innerWidth, height: window.innerHeight })
  useEffect(() => {
    const onResize = (): void => setSize({ width: window.innerWidth, height: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return size
}
