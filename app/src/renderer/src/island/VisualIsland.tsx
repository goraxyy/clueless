// The visual island: an Animate run's own small window, beside the student's code. The picture
// (the code's variables as boxes, or the lesson's scene), what's being said (and, with voice on,
// read aloud in step), and the controls: back, play / pause, forward, stop, speed and voice.
// Drag it by its top bar. The line each step is about lights up on the code itself (TraceStage).
import { AnimatePresence, motion } from 'motion/react'
import { useLayoutEffect, useMemo, useRef, type ButtonHTMLAttributes } from 'react'
import { SPEEDS, stepCount, type IslandPlayback, type IslandView } from '../../../shared/contracts'
import { narrateStep } from '../../../shared/narrate'
import type { CodeTrace, Lesson } from '../../../shared/trace'
import { BackIcon, NextIcon, PauseIcon, PlayIcon, RetryIcon, SpeakerIcon, SpeakerOffIcon, StopIcon } from '../components/icons'
import { Markdown } from '../components/Markdown'
import { cx } from '../components/ui'
import { SceneView } from '../visuals/SceneView'
import { speech } from '../voice/speaker'
import { useSpeech } from '../voice/useSpeech'
import { islandApi } from './api'
import { Figure, type FigureState } from './Figures'
import { useIslandView } from './IslandScreen'
import { stepBadge } from './TraceStage'
import { changesAt, pointersAt, valuesAt } from './traceState'
import { latestAnswer, useStepNarration } from './useNarration'

export function VisualIsland() {
  const view = useIslandView()
  useStepNarration(view)
  const playback = view?.playback
  if (!view || !playback || !stepCount(view)) return null
  return <Card view={view} playback={playback} />
}

function Card({ view, playback }: { view: IslandView; playback: IslandPlayback }) {
  // The window fits the card.
  const root = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = root.current
    if (!el) return
    const report = (): void => {
      const r = el.getBoundingClientRect()
      islandApi.resizeVisual({ width: Math.ceil(r.width), height: Math.ceil(r.height) })
    }
    report()
    const ro = new ResizeObserver(report)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const total = stepCount(view)
  const { index, playing } = playback
  const finished = !playing && index >= total - 1
  const speaking = useSpeech().state === 'speaking'

  return (
    // `dark`: the island is always dark, whatever the system theme.
    <div ref={root} className="dark inline-flex p-2.5" data-visual-island data-app-ready>
      <div className="flex w-max min-w-[380px] max-w-[580px] flex-col overflow-hidden rounded-2xl border border-white/10 bg-zinc-950/95 text-zinc-100 shadow-[0_16px_50px_rgba(0,0,0,0.5)]">
        <header className="drag flex h-9 shrink-0 items-center gap-2 border-b border-white/10 px-3 text-[12px]" title="Drag to move">
          <span className={cx('h-2 w-2 shrink-0 rounded-full bg-claude-500', speaking && 'animate-pulse')} />
          <span className="min-w-0 flex-1 truncate font-mono text-zinc-300">{title(view, index)}</span>
          <span className="shrink-0 tabular-nums text-zinc-500">
            {Math.max(0, index + 1)} / {total}
          </span>
        </header>
        <div className="px-3.5 pb-2.5 pt-3">
          {index >= 0 && view.trace && <TracePicture trace={view.trace} index={index} finished={finished} />}
          {index >= 0 && !view.trace && view.lesson && <LessonPicture lesson={view.lesson} index={index} />}
          <Said view={view} index={index} />
        </div>
        <div className="mx-3.5 h-1 overflow-hidden rounded-full bg-white/10">
          <div className="h-full rounded-full bg-claude-500 transition-[width] duration-500" style={{ width: `${(Math.max(0, index + 1) / total) * 100}%` }} />
        </div>
        <Controls view={view} playback={playback} total={total} finished={finished} />
      </div>
    </div>
  )
}

/** The top bar: the line being run (or talked about), else what this is. */
function title(view: IslandView, index: number): string {
  if (view.trace) {
    const step = view.trace.steps[index]
    return (step && view.trace.code.split('\n')[step.line - 1]?.trim()) || 'Your code, step by step'
  }
  const step = view.lesson?.steps[index]
  return (step?.line && view.lesson?.text.split('\n')[step.line - 1]?.trim()) || 'The idea, step by step'
}

/** The code's variables as boxes: what this step changed lights up, what it reads gets an outline. */
function TracePicture({ trace, index, finished }: { trace: CodeTrace; index: number; finished: boolean }) {
  const values = useMemo(() => valuesAt(trace, index), [trace, index])
  const changes = useMemo(() => changesAt(trace, index), [trace, index])
  const pointers = useMemo(() => pointersAt(trace, values), [trace, values])
  const step = trace.steps[index]
  const reads = new Set(step?.reads ?? [])
  const shown = trace.entities.filter((e) => values[e.id])
  const badge = step ? stepBadge(trace, step, index) : null
  return (
    <div className="mb-2.5">
      {badge && <span className={cx('mb-2 inline-block rounded-full px-2 py-px text-[12px] font-semibold', badge.tone)}>{badge.text}</span>}
      {shown.length > 0 ? (
        <div className="flex max-w-[560px] flex-wrap items-start gap-3" style={{ zoom: 0.72 }}>
          <AnimatePresence>
            {shown.map((e) => {
              const state: FigureState = changes[e.id] ? 'changed' : reads.has(e.id) ? 'read' : finished ? 'rest' : 'idle'
              return <Figure key={e.id} entity={e} value={values[e.id]} change={changes[e.id]} state={state} pointers={pointers[e.id] ?? []} />
            })}
          </AnimatePresence>
        </div>
      ) : (
        <div className="py-3 text-center font-mono text-[12px] text-zinc-500">nothing set yet</div>
      )}
    </div>
  )
}

/** The lesson's picture at this step. The same scene drawn again with new data animates the difference. */
function LessonPicture({ lesson, index }: { lesson: Lesson; index: number }) {
  const scene = lesson.steps[index]?.scene
  if (!scene) return null
  return (
    <div className="mb-2.5 flex justify-center overflow-hidden rounded-xl bg-white/[0.03] p-3">
      <SceneView scene={scene} />
    </div>
  )
}

/** What's said at this step (read aloud with voice on). Before step 1: the answer itself. */
function Said({ view, index }: { view: IslandView; index: number }) {
  const markdown = index < 0 ? latestAnswer(view) : view.trace ? null : view.lesson?.steps[index]?.say
  const plain = index >= 0 && view.trace ? narrateStep(view.trace, index).text : null
  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={index}
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.25 }}
        className={cx('max-w-[540px] leading-snug text-zinc-100', index < 0 ? 'text-[14px]' : 'text-[13.5px]')}
      >
        {plain ?? <Markdown text={markdown ?? ''} />}
      </motion.div>
    </AnimatePresence>
  )
}

function Controls({ view, playback, total, finished }: { view: IslandView; playback: IslandPlayback; total: number; finished: boolean }) {
  const { index, playing } = playback
  const nextSpeed = SPEEDS[(SPEEDS.indexOf(view.speed as (typeof SPEEDS)[number]) + 1) % SPEEDS.length]
  return (
    <div className="flex items-center gap-0.5 px-2 py-1.5">
      <Control title="Go back a step" onClick={() => islandApi.step(-1)} disabled={index <= 0}>
        <BackIcon size={14} />
      </Control>
      {playing ? (
        <Control title="Pause" onClick={() => islandApi.pause()}>
          <PauseIcon size={14} />
        </Control>
      ) : (
        <Control title={finished ? 'Play it again' : 'Play'} onClick={() => islandApi.play()}>
          {finished ? <RetryIcon size={14} /> : <PlayIcon size={14} />}
        </Control>
      )}
      <Control title="Forward a step" onClick={() => islandApi.step(+1)} disabled={index >= total - 1}>
        <NextIcon size={14} />
      </Control>
      <Control
        title="Stop: take the animation off the screen"
        onClick={() => {
          speech.stop()
          islandApi.stop()
        }}
      >
        <StopIcon size={13} />
      </Control>
      <span className="flex-1" />
      <button
        type="button"
        onClick={() => islandApi.setSpeed(nextSpeed)}
        title={`Speed: ${view.speed}× (click for ${nextSpeed}×)`}
        className="no-drag h-8 min-w-12 rounded-full bg-white/[0.07] px-2.5 text-[12.5px] font-semibold tabular-nums text-zinc-200 hover:bg-white/[0.14]"
      >
        {view.speed}×
      </button>
      <Control
        title={view.voice ? 'Voice is on: each step is read aloud. Click to mute' : 'Voice is off. Click to hear each step'}
        aria-pressed={view.voice}
        onClick={() => {
          if (view.voice) speech.stop()
          islandApi.setVoice(!view.voice)
        }}
        className={view.voice ? 'text-claude-400' : undefined}
      >
        {view.voice ? <SpeakerIcon size={15} /> : <SpeakerOffIcon size={15} />}
      </Control>
    </div>
  )
}

function Control({ className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={cx(
        'no-drag flex h-8 w-8 items-center justify-center rounded-full text-zinc-300 transition-colors hover:bg-white/[0.12] hover:text-white disabled:pointer-events-none disabled:opacity-30',
        className
      )}
      {...rest}
    />
  )
}
