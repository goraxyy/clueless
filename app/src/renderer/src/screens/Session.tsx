// The problem session, kept small: problem bar, current step, ONLY the latest exchange
// (the student's last input and Clueless's last reply), quick actions and the answer box.
// The full conversation still lives in the session (for the recap and memory); it's just not shown.
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type {
  CheckResult,
  InputKind,
  PlanStep,
  ProblemView,
  RecapView,
  SessionView,
  StepIntent,
  Subject,
  TurnView
} from '../../../shared/contracts'
import { api } from '../api'
import {
  CheckIcon,
  FlagIcon,
  LockIcon,
  PlayIcon,
  PlusIcon,
  RetryIcon,
  SendIcon,
  SpeakerIcon,
  SpeakerOffIcon
} from '../components/icons'
import { Markdown, MathText, mathToHtml } from '../components/Markdown'
import { MicButton, SpeakingStrip, VoiceStrip } from '../components/MicButton'
import { Button, cx, IconButton } from '../components/ui'
import { speech } from '../voice/speaker'
import type { VoiceConversation } from '../voice/useVoiceConversation'

/** Voice (`conv`) lives in the app, so the compact pill can talk too. */
export function SessionScreen({
  session,
  onOpenGaps,
  conv
}: {
  session: SessionView
  onOpenGaps: () => void
  conv: VoiceConversation
}) {
  const ready = Boolean(session.problem) && !session.busy
  const opening = isOpeningQuestion(session)

  return (
    <div className="session-screen flex min-h-0 flex-col">
      {session.problem && <ProblemBar problem={session.problem} />}
      {session.plan.length > 0 && !opening && <PlanList plan={session.plan} disabled={!ready || Boolean(session.recap)} />}
      <LatestExchange session={session} onOpenGaps={onOpenGaps} onReadAloud={conv.readAloud} />
      {session.stuck.level === 2 && !session.busy && !session.recap && (
        <StuckBubble reason={session.stuck.reason} />
      )}
      {session.error && (
        // Without a problem there's nothing to retry: offer a way back to the start screen instead.
        <ErrorBox message={session.error} canRetry={Boolean(session.problem)} onDismiss={session.problem ? null : () => api.action('new')} />
      )}
      {session.problem && !session.recap && !opening && <QuickActions disabled={!ready} />}
      {session.problem && (
        <Composer session={session} disabled={!ready} conv={conv} opening={opening} />
      )}
    </div>
  )
}

/**
 * Right after a scan Clueless asks "What's tripping you up?" with options. Until the student
 * answers, hints and the plan don't apply yet, so they're hidden.
 */
function isOpeningQuestion(session: SessionView): boolean {
  return (
    session.expects === 'choice' &&
    session.choices.length > 0 &&
    !session.recap &&
    !session.thread.some((t) => t.role === 'student')
  )
}

/**
 * The options to show under the latest reply. None once the student has answered (they'd sit
 * there while Clueless thinks), and the opening "where are you stuck?" options never come back.
 */
function openChoices(session: SessionView): string[] {
  if (session.expects !== 'choice' || session.recap) return []
  const last = session.thread.filter((t) => t.role !== 'system').at(-1)
  if (!last || last.role !== 'tutor') return []
  const opening = session.thread.find((t) => t.role === 'tutor')
  const asked = opening?.role === 'tutor' && opening !== last ? new Set(opening.turn.choices) : new Set<string>()
  return session.choices.filter((c) => !asked.has(c))
}

// ---------- problem + plan ----------

const SUBJECTS: Subject[] = ['coding', 'math', 'physics', 'other']

function ProblemBar({ problem }: { problem: ProblemView }) {
  return (
    <div className="flex items-center gap-2 border-b border-zinc-900/10 px-3 py-1.5 dark:border-white/10" title={problem.summary}>
      <select
        value={problem.subject}
        onChange={(e) => api.setSubject(e.target.value as Subject)}
        title="Wrong subject? Change it"
        className="no-drag h-5 shrink-0 cursor-pointer rounded border-0 bg-claude-100 px-1 text-[10px] font-semibold uppercase tracking-wide text-claude-900 outline-none dark:bg-claude-500/15 dark:text-claude-400"
      >
        {SUBJECTS.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
      <div className="min-w-0 flex-1 truncate text-[13px] font-semibold text-zinc-900 dark:text-zinc-50">{problem.title}</div>
      <IconButton title="New problem" onClick={() => api.action('new')} className="h-6 w-6">
        <PlusIcon size={14} />
      </IconButton>
    </div>
  )
}

/** What clicking a step means, by its status. */
const STEP_CLICK: Record<PlanStep['status'], { intent: StepIntent; hint: string; title: string }> = {
  current: { intent: 'stuck', hint: 'Stuck?', title: 'Stuck on this step? Click for a hint about it' },
  done: { intent: 'revisit', hint: 'Go back', title: 'Go back to this step' },
  locked: { intent: 'claim', hint: 'Done it?', title: "Already done this? Click and Clueless will check" }
}

function PlanList({ plan, disabled }: { plan: PlanStep[]; disabled: boolean }) {
  const [open, setOpen] = useState(false)
  const current = plan.findIndex((s) => s.status === 'current')
  const done = plan.filter((s) => s.status === 'done').length
  const shown = open ? plan : plan.filter((s) => s.status === 'current')

  return (
    <div className="border-b border-zinc-900/10 px-3 py-1.5 dark:border-white/10">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="no-drag mb-0.5 flex w-full items-center gap-2 text-[10px] font-medium uppercase tracking-wide text-zinc-400"
      >
        <span>Plan</span>
        <span className="flex flex-1 gap-0.5">
          {plan.map((s) => (
            <span
              key={s.id}
              className={cx(
                'h-1 flex-1 rounded-full',
                s.status === 'done' ? 'bg-emerald-500' : s.status === 'current' ? 'bg-claude-500' : 'bg-zinc-200 dark:bg-zinc-700'
              )}
            />
          ))}
        </span>
        <span className="normal-case tracking-normal">
          {current >= 0 ? `step ${current + 1} of ${plan.length}` : `${done} of ${plan.length} done`} · {open ? 'hide' : 'all'}
        </span>
      </button>
      <ol className="space-y-0.5">
        {shown.map((s) => (
          <li key={s.id}>
            <button
              type="button"
              disabled={disabled}
              onClick={() => api.step(s.id, STEP_CLICK[s.status].intent)}
              title={disabled ? undefined : STEP_CLICK[s.status].title}
              className={cx(
                'no-drag group -mx-1 flex w-[calc(100%+0.5rem)] items-start gap-2 rounded-md px-1 py-px text-left text-[12.5px] transition-colors',
                'enabled:hover:bg-zinc-900/5 disabled:cursor-default dark:enabled:hover:bg-white/10',
                s.status === 'current' && 'font-medium text-zinc-900 dark:text-zinc-50',
                s.status !== 'current' && 'text-zinc-400',
                s.status === 'locked' && 'dark:text-zinc-500'
              )}
            >
              <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
                {s.status === 'done' ? (
                  <CheckIcon size={13} className="text-emerald-500" />
                ) : s.status === 'locked' ? (
                  <LockIcon size={11} />
                ) : (
                  <span className="h-2 w-2 rounded-full bg-claude-500" />
                )}
              </span>
              {/* Locked steps arrive without text: they'd give the strategy away. */}
              <span
                className={cx(
                  'min-w-0 flex-1',
                  s.status === 'done' && 'line-through decoration-zinc-300 dark:decoration-zinc-600'
                )}
              >
                {s.status === 'locked' ? `Step ${plan.indexOf(s) + 1}` : s.text}
              </span>
              {!disabled && (
                <span className="shrink-0 text-[10.5px] font-normal text-claude-500 opacity-0 transition-opacity group-hover:opacity-100">
                  {STEP_CLICK[s.status].hint}
                </span>
              )}
            </button>
          </li>
        ))}
      </ol>
    </div>
  )
}

// ---------- the latest exchange ----------

function findLastIndex<T>(list: T[], test: (item: T) => boolean): number {
  for (let i = list.length - 1; i >= 0; i--) if (test(list[i])) return i
  return -1
}

/** Only the student's latest input and Clueless's latest reply. */
function LatestExchange({
  session,
  onOpenGaps,
  onReadAloud
}: {
  session: SessionView
  onOpenGaps: () => void
  onReadAloud: (markdown: string) => void
}) {
  const { thread } = session
  const tutorAt = findLastIndex(thread, (t) => t.role === 'tutor')
  const studentAt = findLastIndex(thread, (t) => t.role === 'student')
  // A student message waiting for its reply, or the one that the latest reply answers.
  const pending = studentAt > tutorAt
  const showStudent = studentAt >= 0 && (pending || studentAt === tutorAt - 1)
  const tutor = tutorAt >= 0 ? thread[tutorAt] : null
  const student = showStudent ? thread[studentAt] : null

  return (
    <div className="exchange space-y-2 px-3 py-2.5">
      {student && student.role === 'student' && <StudentLine text={student.text} as={student.as} check={student.check} />}
      {session.busy && <BusyRow label={session.busy} />}
      {tutor && tutor.role === 'tutor' && !pending && (
        <div className={cx('transition-opacity', session.busy && 'opacity-40')}>
          <TutorCard turn={tutor.turn} onReadAloud={() => onReadAloud(tutor.turn.message)} />
          {session.recap && session.recap.afterItemId === tutor.id && (
            <RecapCard recap={session.recap} onOpenGaps={onOpenGaps} />
          )}
        </div>
      )}
    </div>
  )
}

const KIND_LABEL: Partial<Record<TurnView['kind'], string>> = {
  hint: 'Hint',
  recall_card: 'Quick syntax',
  solved: 'Solved'
}

const GAP_LABEL = {
  recall_slip: 'Recall slip',
  concept_gap: 'Concept gap',
  strategy_gap: 'Strategy gap',
  careless_slip: 'Careless slip'
} as const

function TutorCard({ turn, onReadAloud }: { turn: TurnView; onReadAloud: () => void }) {
  const label = KIND_LABEL[turn.kind]
  const tone =
    turn.kind === 'recall_card'
      ? 'border-sky-200 bg-sky-50/70 dark:border-sky-900 dark:bg-sky-950/40'
      : turn.kind === 'solved'
          ? 'border-emerald-200 bg-emerald-50/70 dark:border-emerald-900 dark:bg-emerald-950/40'
          : 'border-zinc-900/10 bg-white/70 dark:border-white/10 dark:bg-black/35'

  return (
    <div className={cx('group relative rounded-xl border py-2 pl-3 pr-7 text-zinc-800 dark:text-zinc-100', tone)}>
      <IconButton
        title="Read aloud"
        onClick={onReadAloud}
        // !absolute: IconButton's own `relative` would otherwise win and put it on a line of its own.
        className="!absolute bottom-1 right-1 h-6 w-6 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
      >
        <SpeakerIcon size={13} />
      </IconButton>
      {(label || turn.hintLevel > 0 || turn.gap || turn.verdict !== 'none') && (
        <div className="mb-1 flex flex-wrap items-center gap-1.5 text-[10.5px]">
          <Verdict verdict={turn.verdict} />
          {label && <span className="font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{label}</span>}
          {turn.hintLevel > 0 && <HintDots level={turn.hintLevel} />}
          {turn.gap && (
            <span className="truncate rounded-full bg-zinc-100 px-1.5 py-px text-zinc-500 dark:bg-white/10 dark:text-zinc-400">
              {GAP_LABEL[turn.gap.type]} · {turn.gap.topic}
            </span>
          )}
        </div>
      )}
      <div>
        <Markdown text={turn.message} />
      </div>
    </div>
  )
}

function Verdict({ verdict }: { verdict: TurnView['verdict'] }) {
  if (verdict === 'none') return null
  const map = {
    correct: ['Correct', 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300'],
    partial: ['Partly', 'bg-claude-100 text-claude-800 dark:bg-claude-600/15 dark:text-claude-400'],
    incorrect: ['Not quite', 'bg-rose-100 text-rose-800 dark:bg-rose-500/15 dark:text-rose-300']
  } as const
  const [text, cls] = map[verdict]
  return <span className={cx('rounded-full px-1.5 py-px font-medium', cls)}>{text}</span>
}

function HintDots({ level }: { level: number }) {
  return (
    <span className="flex items-center gap-0.5" title={`Hint level ${level} of 5`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <span key={n} className={cx('h-1.5 w-1.5 rounded-full', n <= level ? 'bg-claude-500' : 'bg-zinc-200 dark:bg-zinc-700')} />
      ))}
    </span>
  )
}

const CHECK_LABEL: Record<CheckResult['status'], [string, string]> = {
  match: ['Math engine: matches', 'text-emerald-600 dark:text-emerald-400'],
  mismatch: ["Math engine: doesn't match", 'text-rose-600 dark:text-rose-400'],
  missing_units: ['Math engine: add units', 'text-claude-600 dark:text-claude-500'],
  wrong_units: ["Math engine: units don't match", 'text-rose-600 dark:text-rose-400'],
  unparseable: ["Math engine: couldn't read this as math", 'text-zinc-400']
}

function StudentLine({ text, as, check }: { text: string; as: InputKind; check: CheckResult | null }) {
  return (
    <div className="flex items-start gap-2 text-[12.5px]">
      <span className="mt-px shrink-0 text-[10px] font-semibold uppercase tracking-wide text-zinc-400">
        {as === 'recall' ? 'Asked' : 'You'}
      </span>
      <div className="min-w-0 flex-1">
        {as === 'code' ? (
          <pre className="selectable line-clamp-3 whitespace-pre-wrap font-mono text-[11.5px] text-zinc-700 dark:text-zinc-300">{text}</pre>
        ) : as === 'math' && mathToHtml(text) ? (
          <MathText input={text} className="selectable text-zinc-700 dark:text-zinc-300" />
        ) : (
          <span className="selectable line-clamp-2 text-zinc-700 dark:text-zinc-300">{text}</span>
        )}
        {check && <div className={cx('text-[10.5px]', CHECK_LABEL[check.status][1])}>{CHECK_LABEL[check.status][0]}</div>}
      </div>
    </div>
  )
}

function BusyRow({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
      <span className="flex gap-0.5">
        <span className="busy-dot h-1.5 w-1.5 rounded-full bg-claude-500" />
        <span className="busy-dot h-1.5 w-1.5 rounded-full bg-claude-500" />
        <span className="busy-dot h-1.5 w-1.5 rounded-full bg-claude-500" />
      </span>
      {label}
    </div>
  )
}

function RecapCard({ recap, onOpenGaps }: { recap: RecapView; onOpenGaps: () => void }) {
  return (
    <div className="mt-2 rounded-xl border border-claude-400/70 bg-claude-50/60 p-3 text-[12.5px] text-zinc-800 dark:border-claude-600/30 dark:bg-claude-600/5 dark:text-zinc-100">
      <div className="mb-2 flex items-center gap-2">
        <FlagIcon size={14} className="text-claude-600" />
        <span className="font-semibold">Recap</span>
        <span className="ml-auto text-xs text-zinc-500">
          {recap.solved ? 'Solved' : 'Not solved yet'} · {recap.attempts} answers · {recap.hintsUsed} hints
          {recap.revealed ? ' · revealed' : ''}
        </span>
      </div>
      <div className="mb-2">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Explain it back</div>
        <div className="selectable">{recap.explainBack}</div>
        <div className="text-xs text-zinc-500">Answer in the box below.</div>
      </div>
      {recap.gaps.length > 0 && (
        <div className="mb-2">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Gaps found</div>
          <div className="flex flex-wrap gap-1">
            {recap.gaps.map((g, i) => (
              <span key={i} className="rounded-full bg-white/70 px-2 py-px text-xs ring-1 ring-zinc-200 dark:bg-black/35 dark:ring-zinc-700">
                {GAP_LABEL[g.type]} · {g.topic}
              </span>
            ))}
          </div>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        {recap.gaps.length > 0 && (
          <Button variant="chip" onClick={onOpenGaps}>
            See all your gaps
          </Button>
        )}
        {recap.similarProblem && (
          <Button variant="chip" onClick={() => api.askText(recap.similarProblem!)} title={recap.similarProblem}>
            Try a similar one
          </Button>
        )}
        <Button variant="chip" onClick={() => api.action('new')}>
          New problem
        </Button>
      </div>
      {recap.similarProblem && <div className="mt-2 text-xs text-zinc-500">Similar: {recap.similarProblem}</div>}
    </div>
  )
}

// ---------- stuck, errors, actions ----------

function StuckBubble({ reason }: { reason: string | null }) {
  return (
    <div className="mx-3 mb-2 rounded-xl border border-claude-400 bg-claude-50 px-3 py-2 text-[13px] text-zinc-800 shadow-sm dark:border-claude-600/40 dark:bg-claude-600/10 dark:text-zinc-100">
      <div className="mb-1.5">
        <span className="font-semibold">Stuck?</span>
        {reason && <span className="text-zinc-500 dark:text-zinc-400"> Looks like {reason}.</span>}
      </div>
      <div className="flex flex-wrap gap-1.5">
        <Button variant="chip" onClick={() => api.action('next')}>
          What next?
        </Button>
        <Button variant="chip" onClick={() => api.action('im_fine')}>
          I'm fine
        </Button>
      </div>
    </div>
  )
}

function ErrorBox({ message, canRetry, onDismiss }: { message: string; canRetry: boolean; onDismiss: (() => void) | null }) {
  return (
    <div className="mx-3 mb-2 mt-2 flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[12.5px] text-rose-800 dark:border-rose-900 dark:bg-rose-950/50 dark:text-rose-200">
      <span className="min-w-0 flex-1">{message}</span>
      {canRetry && (
        <Button variant="chip" onClick={() => api.action('retry')}>
          <RetryIcon size={12} /> Retry
        </Button>
      )}
      {onDismiss && (
        <Button variant="chip" onClick={onDismiss}>
          Dismiss
        </Button>
      )}
    </div>
  )
}

/** One row: Hint, What next?, Check my work, Example. The recap comes by itself once it's solved. */
function QuickActions({ disabled }: { disabled: boolean }) {
  return (
    <div className="flex flex-nowrap justify-between gap-1 border-t border-zinc-900/10 px-3 pt-1.5 dark:border-white/10">
      <Button variant="chip" disabled={disabled} onClick={() => api.action('hint')} title="A slightly bigger hint">
        Hint
      </Button>
      <Button variant="chip" disabled={disabled} onClick={() => api.action('next')} title="Not sure what to do next?">
        What next?
      </Button>
      <Button variant="chip" disabled={disabled} onClick={() => api.action('check_my_work')} title="Clueless looks at your screen again">
        Check my work
      </Button>
      <Button variant="chip" disabled={disabled} onClick={() => api.action('example')} title="A similar worked example, with different numbers">
        Example
      </Button>
    </div>
  )
}

// ---------- answer box ----------

function Composer({
  session,
  disabled,
  conv,
  opening
}: {
  session: SessionView
  disabled: boolean
  conv: VoiceConversation
  opening: boolean
}) {
  const [text, setText] = useState('')
  const input = useRef<HTMLTextAreaElement>(null)
  // One box for everything: answers, and questions like "how do I write a set?" (Clueless answers those directly).
  const as: InputKind = session.expects === 'math' ? 'math' : session.expects === 'code' ? 'code' : 'text'

  useEffect(() => {
    if (!disabled) input.current?.focus()
  }, [disabled, session.thread.length])

  // Grow with the text (up to max-h), so the panel stays small for one-line answers.
  useEffect(() => {
    const el = input.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [text, as])

  const submit = (value = text): void => {
    if (!value.trim() || disabled) return
    api.send({ text: value, as })
    setText('')
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    // Code: Enter is a newline, Cmd/Ctrl+Enter sends. Everything else: Enter sends.
    const send = as === 'code' ? e.key === 'Enter' && (e.metaKey || e.ctrlKey) : e.key === 'Enter' && !e.shiftKey
    if (send) {
      e.preventDefault()
      submit()
    }
  }

  const choices = openChoices(session)
  const placeholder = opening
    ? 'Something else? Type it here…'
    : as === 'math'
      ? 'Type your answer, e.g. x^2 e^x - 2x e^x + 2e^x + C'
      : as === 'code'
        ? 'Paste or type code (⌘/Ctrl + Enter to send)'
        : 'Your answer, or ask anything…'

  return (
    <div className="px-3 pb-2.5 pt-1.5">
      {opening ? (
        // The opening options get the room: one full-width row each.
        <div className="mb-2 flex flex-col gap-1">
          {session.choices.map((c) => (
            <Button key={c} variant="chip" disabled={disabled} onClick={() => submit(c)} className="w-full !justify-start">
              {c}
            </Button>
          ))}
        </div>
      ) : (
        choices.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {choices.map((c) => (
              <Button key={c} variant="chip" disabled={disabled} onClick={() => submit(c)}>
                {c}
              </Button>
            ))}
          </div>
        )
      )}
      <SpeakingStrip conv={conv} onStop={speech.stop} onPause={speech.pause} onResume={speech.resume} />
      <VoiceStrip voice={conv.input} onDismiss={conv.input.cancel} />
      <div className="flex items-end gap-1.5 rounded-xl border border-zinc-900/10 bg-white/70 px-2 py-1 focus-within:border-claude-500 dark:border-white/15 dark:bg-black/35">

        <textarea
          ref={input}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          rows={as === 'code' ? 3 : 1}
          disabled={disabled}
          className={cx(
            'no-drag max-h-28 min-h-[1.75rem] flex-1 resize-none bg-transparent py-0.5 text-[13px] text-zinc-900 outline-none placeholder:text-zinc-400 dark:text-zinc-50',
            as === 'code' && 'font-mono text-[12.5px]'
          )}
        />
        <IconButton
          title={conv.enabled ? 'Voice on: replies are read aloud. Click to turn off' : 'Voice off. Click to have replies read aloud'}
          aria-pressed={conv.enabled}
          onClick={() => conv.setEnabled(!conv.enabled)}
          className={cx(conv.enabled && 'text-claude-600 dark:text-claude-400')}
        >
          {conv.enabled ? <SpeakerIcon size={15} /> : <SpeakerOffIcon size={15} />}
        </IconButton>
        <IconButton
          title="Animate: the idea at this step, with voice, in its own window"
          disabled={disabled}
          onClick={() => api.action('animate')}
          className="text-claude-500 disabled:opacity-40 dark:text-claude-400"
        >
          <PlayIcon size={14} />
        </IconButton>
        <MicButton conv={conv} disabled={disabled} />
        <IconButton
          title="Send"
          onClick={() => submit()}
          disabled={disabled || !text.trim()}
          className="bg-claude-500 text-white hover:bg-claude-400 hover:text-white disabled:opacity-40 dark:text-white dark:hover:bg-claude-400"
        >
          <SendIcon size={15} />
        </IconButton>
      </div>
      {as === 'math' && text.trim() && (
        <div className="mt-1.5 min-h-5 truncate px-1 text-sm text-zinc-700 dark:text-zinc-200">
          {mathToHtml(text) ? <MathText input={text} /> : <span className="text-xs text-zinc-400">Can't read that as math yet</span>}
        </div>
      )}
    </div>
  )
}

