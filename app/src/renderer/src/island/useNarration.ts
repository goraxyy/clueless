// Voice and animation in step. The visual island has its own voice: with voice on, it reads each
// step of an Animate run aloud, and the island controller moves to the next step only once that
// line has been said (stepDone). The intro reads the answer itself. The speed button speeds the
// voice up with the animation.
// The panel reads Ask's text-only answers aloud, like tutor replies, when its voice mode is on.
import { useEffect, useRef } from 'react'
import { stepCount, type IslandView } from '../../../shared/contracts'
import { narrateStep } from '../../../shared/narrate'
import { toSpeech } from '../../../shared/speechText'
import { speech } from '../voice/speaker'
import { useVoiceMode } from '../voice/voiceMode'
import { islandApi } from './api'

/** What step `index` says: the trace's own line, or the lesson's. index -1 = the answer. */
export function stepSpeech(view: IslandView, index: number): string {
  if (index < 0) return toSpeech(introText(view) ?? '')
  if (view.trace) return narrateStep(view.trace, index).speech
  return toSpeech(view.lesson?.steps[index]?.say ?? '')
}

/** Said before step 1: the tutor's Animate reply, or the Ask answer. */
export function introText(view: IslandView): string | null {
  return view.lesson?.intro ?? latestAnswer(view)
}

export function latestAnswer(view: IslandView | null): string | null {
  return [...(view?.messages ?? [])].reverse().find((m) => m.role === 'clueless')?.text ?? null
}

/** The visual island: read each step aloud, in step with the animation. */
export function useStepNarration(view: IslandView | null): void {
  const voiceOn = Boolean(view?.voice)
  // Hidden window: nothing is read aloud, so don't wait for it.
  useEffect(() => {
    const report = (): void => islandApi.setNarrated(voiceOn && document.visibilityState === 'visible')
    report()
    document.addEventListener('visibilitychange', report)
    return () => document.removeEventListener('visibilitychange', report)
  }, [voiceOn])

  const speed = view?.speed ?? 1
  useEffect(() => speech.setRate(speed), [speed])

  const live = useRef(view)
  live.current = view
  const p = view?.playback ?? null
  const last = view ? stepCount(view) - 1 : -1

  // Read a step when it comes up (playing on, or stepped to by hand), or when Play is pressed.
  // Pause, voice off or Stop: quiet.
  const key = p ? `${p.nonce}:${p.index}` : null
  const playing = Boolean(p?.playing)
  const before = useRef<{ key: string | null; playing: boolean }>({ key: null, playing: false })
  useEffect(() => {
    const prev = before.current
    before.current = { key, playing }
    const v = live.current
    if (!voiceOn || !key || !v?.playback || !stepCount(v)) return speech.stop()
    const { nonce, index } = v.playback
    if (key !== prev.key || (playing && !prev.playing)) {
      speech.speak(stepSpeech(v, index), () => islandApi.stepDone(nonce, index))
    } else if (!playing && prev.playing && index < last) {
      speech.stop() // paused mid-way
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` and `playing` cover the playback
  }, [key, playing, voiceOn])
}

/** The panel: read a text-only Ask answer aloud, like a tutor reply, when voice mode is on. */
export function useAnswerReadAloud(view: IslandView | null): void {
  const voiceOn = useVoiceMode()
  const live = useRef(view)
  live.current = view
  const answer = latestAnswer(view)
  const count = view?.messages.length ?? 0
  const seen = useRef(count)
  useEffect(() => {
    const grew = count > seen.current
    seen.current = count
    const v = live.current
    // An animated answer is read by the visual island instead.
    if (!grew || !voiceOn || !v || v.playback || v.phase !== 'answer' || !answer) return
    if (v.messages[v.messages.length - 1]?.role === 'clueless') speech.speak(toSpeech(answer))
  }, [count, voiceOn, answer])
}
