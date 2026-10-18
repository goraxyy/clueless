// While an Animate run plays, the student's own text lights up (a click-through window over the
// screen): a dashed outline around what they highlighted, a band on the line the current step is
// about (with a tag for conditions, loops and returns). The picture and the voice are in the visual
// island. The pace comes from the island controller.
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useState } from 'react'
import { stepCount, type CodeSpot, type IslandView, type Rect, type StageIsland } from '../../../shared/contracts'
import type { CodeTrace, TraceStep } from '../../../shared/trace'
import { api } from '../api'
import { cx } from '../components/ui'
import { loopPass } from './traceState'


/** The stage window's whole page (#stage): an Animate run's highlight on the student's code. */
export function StageScreen() {
  const [show, setShow] = useState<StageIsland | null>(null)
  useEffect(() => api.onStageIsland(setShow), [])
  return show?.view ? <TraceStage view={show.view} /> : null
}

export function TraceStage({ view }: { view: IslandView }) {
  const { spot, playback } = view
  if (!spot || !playback || view.spotLost || !stepCount(view)) return null
  return <Drawing key={playback.nonce} view={view} spot={spot} index={playback.index} />
}

function Drawing({ view, spot, index }: { view: IslandView; spot: CodeSpot; index: number }) {
  const lh = spot.lineHeight
  if (lh <= 0) return <div className="pointer-events-none fixed inset-0" data-trace-stage /> // where the lines are is unknown
  const area: Rect = { x: spot.left, y: spot.top, width: spot.width, height: spot.lines * lh }
  const lines = linesAt(view, index)
  const band = lines ? { y: spot.top + (lines.line - 1) * lh, height: (lines.endLine - lines.line + 1) * lh } : null
  const step = index >= 0 ? view.trace?.steps[index] : undefined
  const badge = step && view.trace ? stepBadge(view.trace, step, index) : null

  return (
    <div className="pointer-events-none fixed inset-0 overflow-hidden" data-trace-stage>
      <motion.div
        className="absolute rounded-md border-2 border-dashed border-claude-500/70"
        style={{ left: area.x - 4, top: area.y - 3, width: area.width + 8, height: area.height + 6 }}
        initial={{ opacity: 0, scale: 1.02 }}
        animate={{ opacity: 1, scale: 1 }}
      />
      {band && (
        <motion.div
          className="absolute rounded-sm border-l-4 border-claude-500 bg-claude-500/25 shadow-[0_0_18px_rgba(217,119,87,0.35)]"
          style={{ left: area.x - 2, width: area.width + 4 }}
          initial={{ opacity: 0, top: band.y, height: band.height }}
          animate={{ opacity: 1, top: band.y, height: band.height }}
          // Quick, so the band is on the right line by the time the visual island shows the step.
          transition={{ duration: 0.18, ease: 'easeOut' }}
        >
          <AnimatePresence initial={false}>
            {badge && (
              <motion.span
                key={`${index}:${badge.text}`}
                initial={{ opacity: 0, x: -6, scale: 0.85 }}
                animate={{ opacity: 1, x: 0, scale: 1 }}
                exit={{ opacity: 0, transition: { duration: 0.08 } }}
                transition={{ duration: 0.15 }}
                className={cx('absolute right-1 top-1/2 -translate-y-1/2 whitespace-nowrap rounded-full px-2 py-px text-[12px] font-semibold shadow', badge.tone)}
              >
                {badge.text}
              </motion.span>
            )}
          </AnimatePresence>
        </motion.div>
      )}
    </div>
  )
}

/** The highlighted lines step `index` is about (a code step's lines, or a lesson step's). */
function linesAt(view: IslandView, index: number): { line: number; endLine: number } | null {
  if (index < 0) return null
  const step = view.trace?.steps[index] ?? view.lesson?.steps[index]
  if (!step?.line) return null
  return { line: step.line, endLine: step.endLine ?? step.line }
}

/** A small tag on the line for steps whose meaning isn't a value change. */
export function stepBadge(trace: CodeTrace, step: TraceStep, index: number): { text: string; tone: string } | null {
  if (step.kind === 'condition' && /^(true|false)$/i.test(step.result)) {
    const yes = step.result.toLowerCase() === 'true'
    return { text: yes ? '✓ true' : '✗ false', tone: yes ? 'bg-emerald-400 text-zinc-950' : 'bg-rose-500 text-white' }
  }
  if (step.kind === 'loop') return { text: `↻ pass ${loopPass(trace, index)}`, tone: 'bg-claude-400 text-zinc-950' }
  if (step.kind === 'return') return { text: step.result ? `→ ${step.result}` : 'return', tone: 'bg-sky-400 text-zinc-950' }
  if (step.kind === 'other' && /Error|Exception/.test(step.result)) return { text: '✗ crash', tone: 'bg-rose-500 text-white' }
  return null
}
