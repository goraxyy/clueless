// Two-way voice for a session: talk (useVoiceInput) and hear the replies (speech), half-duplex.
// Voice never has its own conversation: what you say goes through the same `send` as typing,
// and what's spoken is the visible message of the tutor's latest turn.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { SessionView } from '../../../shared/contracts'
import { toSpeech } from '../../../shared/speechText'
import { api } from '../api'
import { speech } from './speaker'
import type { SpeechSnapshot } from './speech'
import { useSpeech } from './useSpeech'
import { useVoiceInput, type VoiceInput } from './useVoiceInput'
import { useVoiceMode, voiceMode } from './voiceMode'

export interface VoiceConversation {
  /** Voice mode: replies are read aloud and the mic is a click away. */
  enabled: boolean
  setEnabled(on: boolean): void
  input: VoiceInput
  speech: SpeechSnapshot
  /** The transcript was sent; waiting for the tutor's reply. */
  processing: boolean
  /** Start listening (turns voice mode on, stops any reply being read). */
  talk(): void
  /** Mic button / hotkey: start, or stop and send. */
  toggleMic(): void
  /** Read a message aloud on request (works with voice mode off too). */
  readAloud(markdown: string): void
}

export function useVoiceConversation({
  session,
  disabled,
  onSpoken
}: {
  session: SessionView | null // null: nothing started yet (what you say becomes the problem)
  disabled: boolean // the tutor is busy
  onSpoken: (text: string) => void
}): VoiceConversation {
  const enabled = useVoiceMode()
  const [processing, setProcessing] = useState(false)
  const snap = useSpeech()
  const sawBusy = useRef(false)

  const input = useVoiceInput((text) => {
    onSpoken(text)
    sawBusy.current = false
    setProcessing(true)
  })

  // Refs so the hotkey and the reply watcher always see the latest values.
  const live = useRef({ enabled, disabled, input })
  live.current = { enabled, disabled, input }

  const setEnabled = useCallback((on: boolean): void => {
    voiceMode.set(on)
    if (!on) {
      // Voice off: mic off and silence, right away.
      live.current.input.cancel()
      speech.stop()
    }
  }, [])

  const talk = useCallback((): void => {
    const { input, disabled } = live.current
    if (disabled || input.state === 'finishing') return
    speech.stop() // half-duplex: never listen while Clueless is talking
    if (!live.current.enabled) setEnabled(true)
    void input.start()
  }, [setEnabled])

  const toggleMic = useCallback((): void => {
    const { input } = live.current
    if (input.state === 'starting' || input.state === 'listening') input.stop()
    else talk()
  }, [talk])

  const readAloud = useCallback((markdown: string): void => {
    live.current.input.cancel()
    speech.speak(toSpeech(markdown))
  }, [])

  // "Waiting for Clueless" lasts until the reply (or an error) arrives.
  useEffect(() => {
    if (!processing) return
    if (disabled) sawBusy.current = true
    else if (sawBusy.current) setProcessing(false)
    const t = setTimeout(() => !sawBusy.current && setProcessing(false), 3000) // never got busy
    return () => clearTimeout(t)
  }, [processing, disabled])

  // Read each NEW tutor reply aloud in voice mode. Replies that were already on screen when the
  // session (or voice mode) started are not read.
  const latest = findLastTutor(session)
  const lastSeen = useRef<string | null>(latest?.id ?? null)
  useEffect(() => {
    if (!latest || latest.id === lastSeen.current) return
    lastSeen.current = latest.id
    const { enabled, input } = live.current
    const recording = input.state === 'starting' || input.state === 'listening' || input.state === 'finishing'
    if (enabled && !recording && !latest.animated) speech.speak(toSpeech(latest.message))
  }, [latest?.id, latest?.message])

  // The voice hotkey (Ctrl/Cmd+Shift+1).
  useEffect(() => api.onVoiceToggle(() => toggleMic()), [toggleMic])

  // Leaving the session or hiding the panel: stop talking.
  useEffect(() => {
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') speech.stop()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      speech.stop()
    }
  }, [])

  return { enabled, setEnabled, input, speech: snap, processing, talk, toggleMic, readAloud }
}

function findLastTutor(session: SessionView | null): { id: string; message: string; animated: boolean } | null {
  if (!session) return null
  for (let i = session.thread.length - 1; i >= 0; i--) {
    const item = session.thread[i]
    // An animated reply is read by the animation window, in step with it.
    if (item.role === 'tutor') return { id: item.id, message: item.turn.message, animated: Boolean(item.turn.animation && item.turn.visual) }
  }
  return null
}
