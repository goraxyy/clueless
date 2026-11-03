// The [CONTINUE] message: a new conversation with Claude about a saved problem, seeded with what
// history kept (the screenshots are gone, and Claude can't be handed an edited old conversation).
import type { SavedSession, ThreadItem } from '../../shared/contracts'
import type { Secret } from './history'

const LAST_TURNS = 8
const MAX_LINE = 600

/** With an account the app never has the hidden solution: the server fills this in. */
export const serverHidden = (sessionId: string): string => `{{hidden:${sessionId}}}`

/** Without one (developers' own keys), it comes from this laptop. Worded like the server's version. */
export function localHidden(secret: Secret | null): string {
  const steps = (secret?.plan ?? []).map((s, i) => `${i + 1}. (${s.status}) ${s.text}`)
  return [
    `[HIDDEN SOLUTION] ${secret?.solution.trim() || '(not saved: work it out again from the problem)'}`,
    `[FULL PLAN]${steps.length ? `\n${steps.join('\n')}` : ' (not saved)'}`
  ].join('\n')
}

export function continueMessage(saved: SavedSession, hidden: string): string {
  const gaps = saved.gaps.map((g) => `${g.topic} (${g.type})`).join('; ')
  return [
    '[CONTINUE]',
    `Problem: ${saved.title} (${saved.subject}). ${saved.summary}`.trim(),
    hidden,
    `So far: ${saved.attempts} answers checked, ${saved.hintsUsed} hints, ${saved.solved ? 'solved' : 'not solved yet'}.`,
    `Gaps seen: ${gaps || 'none'}`,
    'Last turns:',
    ...(saved.thread ?? []).slice(-LAST_TURNS).flatMap(line)
  ].join('\n')
}

function line(item: ThreadItem): string[] {
  const clip = (text: string): string => (text.length > MAX_LINE ? `${text.slice(0, MAX_LINE)}…` : text)
  if (item.role === 'tutor') return [`Clueless: ${clip(item.turn.message)}`]
  if (item.role === 'student') return [`Student: ${clip(item.text)}`]
  return []
}
