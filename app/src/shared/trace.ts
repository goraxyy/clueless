// What Animate on a highlight comes back with.
// - Code: a trace. Every step the code runs: which line, which part of the line, and the new value
//   of every variable ("entity") that changed. Python is run for real to get it (src/main/run); for
//   other languages Claude reads the code and writes the steps down itself.
// - Anything else (a math problem, a paragraph): a lesson. A few steps, each a picture (the same
//   scenes the tutor draws), the lines of the highlight it's about, and what's said over it.
//
// The wire schema has one union (a lesson step's scene); "nothing" is "" or [] everywhere else.
import { z } from 'zod'
import { Scene } from './schema'

export const EntityKind = z.enum([
  'value', // a number, string, bool, None, ...: one box
  'array', // a list / array / indexed string: a row of boxes
  'grid', // a 2-D list: a grid of boxes
  'set', // a set: a bag of items
  'map' // a dict / hashmap / object / Counter: key → value rows
])

export const StepKind = z.enum(['declare', 'assign', 'loop', 'condition', 'call', 'return', 'other'])

/** One entity's whole value at a moment. Only the field for its kind is used; the rest are empty. */
export const EntityValue = z.object({
  scalar: z.string(), // value: "5", "'a'", "True", "None"
  items: z.array(z.string()), // array and set (sets in insertion order)
  entries: z.array(z.object({ key: z.string(), value: z.string() })), // map
  rows: z.array(z.array(z.string())) // grid
})

export const TraceWire = z.object({
  message: z.string(), // Markdown, shown before the animation (or alone when there's none)
  language: z.string(), // "python", "cpp", ... ("" when it isn't code)
  entities: z.array(
    z.object({
      id: z.string(),
      name: z.string(), // as written in the code
      kind: EntityKind,
      indexOf: z.string() // an index variable: the id of the array or grid it indexes, else ""
    })
  ),
  steps: z.array(
    z.object({
      line: z.number(), // 1-based, in the highlighted code
      endLine: z.number(), // same as line for a one-line step
      focus: z.string(), // the exact part of the line this step is about ("" = the whole line)
      kind: StepKind,
      result: z.string(), // condition: "true" / "false"; return: the value; else ""
      reads: z.array(z.string()), // ids of entities this step reads
      updates: z.array(z.object({ entity: z.string(), value: EntityValue })) // full new values
    })
  ), // [] = no animation (Animate off, the highlight isn't code, or the app runs it: see run)
  // [RUN] only: how the app runs the highlighted Python itself. "" otherwise.
  run: z.object({
    setup: z.string(), // runs first: the inputs the code needs
    call: z.string() // runs after it to start it, e.g. "Solution().twoSum([2, 7, 11, 15], 9)"
  }),
  // [ANIMATE ON] and the highlight isn't code: the concept, step by step. [] otherwise.
  lesson: z.array(
    z.object({
      line: z.number(), // 1-based, in the highlighted text; 0 = not about one part of it
      endLine: z.number(), // same as line for one line
      say: z.string(), // read aloud while this step is on screen; one or two short sentences
      scene: Scene // the whole picture at this step
    })
  )
})

export type EntityKind = z.infer<typeof EntityKind>
export type StepKind = z.infer<typeof StepKind>
export type EntityValue = z.infer<typeof EntityValue>
export type TraceWireT = z.infer<typeof TraceWire>

export interface TraceEntity {
  id: string
  name: string
  kind: EntityKind
  indexOf: string | null
}

export interface TraceStep {
  line: number
  endLine: number
  focus: string
  kind: StepKind
  result: string
  reads: string[]
  updates: { entity: string; value: EntityValue }[]
}

export interface CodeTrace {
  language: string
  code: string // the highlighted code, normalized; step line numbers point into it
  entities: TraceEntity[]
  steps: TraceStep[]
}

export interface LessonStep {
  line: number | null // the highlighted line it's about; null = the whole idea
  endLine: number | null
  say: string
  scene: z.infer<typeof Scene>
}

/** A concept animation: Animate on something that isn't code. */
export interface Lesson {
  text: string // the highlighted text, normalized; step line numbers point into it
  steps: LessonStep[]
}

export interface TraceReply {
  message: string
  trace: CodeTrace | null
  lesson: Lesson | null
}

export const MAX_STEPS = 120
export const MAX_LESSON_STEPS = 16

/** Make copied code clean and stable: \n line ends, tabs as 4 spaces, no shared indent, no blank edges. */
export function normalizeSnippet(text: string): string {
  const lines = text
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '    ')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
  while (lines.length && !lines[0].trim()) lines.shift()
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop()
  const indents = lines.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length)
  const common = indents.length ? Math.min(...indents) : 0
  return lines.map((l) => l.slice(common)).join('\n')
}

/** "  1 | code" lines, so Claude can point at exact line numbers. */
export function numberLines(code: string): string {
  const lines = code.split('\n')
  const width = String(lines.length).length
  return lines.map((l, i) => `${String(i + 1).padStart(width)} | ${l}`).join('\n')
}

const emptyValue = (): EntityValue => ({ scalar: '', items: [], entries: [], rows: [] })

/** Wire reply -> app reply. Drops anything that doesn't fit the code instead of failing. */
export function fromTraceWire(wire: TraceWireT, code: string): TraceReply {
  const message = wire.message.trim()
  const lines = code.split('\n')

  const entities: TraceEntity[] = []
  const ids = new Set<string>()
  for (const e of wire.entities) {
    const id = e.id.trim()
    if (!id || ids.has(id)) continue
    ids.add(id)
    entities.push({ id, name: e.name.trim() || id, kind: e.kind, indexOf: e.indexOf.trim() || null })
  }
  for (const e of entities) if (e.indexOf && !ids.has(e.indexOf)) e.indexOf = null

  const steps: TraceStep[] = []
  for (const s of wire.steps.slice(0, MAX_STEPS)) {
    const line = clampInt(s.line, 1, lines.length)
    const endLine = clampInt(s.endLine, line, lines.length)
    const focus = s.focus && lines[line - 1].includes(s.focus) ? s.focus : ''
    steps.push({
      line,
      endLine,
      focus,
      kind: s.kind,
      result: s.result.trim(),
      reads: [...new Set(s.reads.filter((id) => ids.has(id)))],
      updates: s.updates
        .filter((u) => ids.has(u.entity))
        .map((u) => ({ entity: u.entity, value: { ...emptyValue(), ...u.value } }))
    })
  }

  const hasText = lines.some((l) => l.trim())
  const trace = entities.length && steps.length && hasText ? { language: wire.language.trim(), code, entities, steps } : null

  const lessonSteps: LessonStep[] = []
  for (const s of wire.lesson.slice(0, MAX_LESSON_STEPS)) {
    const say = s.say.trim()
    if (!say) continue
    const line = s.line >= 1 ? clampInt(s.line, 1, lines.length) : null
    lessonSteps.push({ line, endLine: line && clampInt(s.endLine, line, lines.length), say, scene: s.scene })
  }
  const lesson = !trace && lessonSteps.length && hasText ? { text: code, steps: lessonSteps } : null
  return { message, trace, lesson }
}

function clampInt(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Number.isFinite(v) ? Math.round(v) : lo))
}
