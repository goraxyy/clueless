// The shape of every reply Claude gives the tutor engine ("wire" format).
// These zod schemas are sent to the API as a structured-output JSON schema, so Claude's reply
// always parses. Structured outputs allow at most 16 union-typed fields (anyOf or nullable) and
// unions make the grammar slow to compile, so this schema uses only 3: `problem` and `recap`
// can be null, and a visual frame is one of several scene kinds. Everywhere else "nothing" is
// written as "" (strings), -1 (numbers), "none" (enums) or [] (lists).
// The tutor engine turns this into the friendlier app types in contracts.ts (with nulls).
import { z } from 'zod'

export const Subject = z.enum(['coding', 'math', 'physics', 'other'])

export const GapType = z.enum([
  'recall_slip', // forgot syntax / formula / rule -> show it right away
  'concept_gap', // doesn't know how the idea works -> side lesson
  'strategy_gap', // knows the tools, not which one fits -> questions
  'careless_slip' // sign, unit, off-by-one -> "check your work"
])

export const TurnKind = z.enum([
  'question', // Clueless asks something
  'hint', // one rung of the hint ladder
  'recall_card', // syntax / formula shown directly
  'side_lesson', // detour for a concept gap
  'feedback', // right / not quite
  'solved' // step or whole problem done
])

export const Verdict = z.enum(['correct', 'partial', 'incorrect', 'none'])
export const Expects = z.enum(['text', 'math', 'code', 'choice', 'none'])
export const CheckKind = z.enum(['equivalent', 'antiderivative', 'units'])

export const PlanStep = z.object({
  id: z.number(),
  text: z.string(),
  status: z.enum(['done', 'current', 'locked'])
})

// ---------- visuals (drawn by the visual engine in the UI) ----------
// Conventions: "" = no label, -1 = none, cells are strings ("" = empty cell).
export const Scene = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('array'),
    name: z.string(),
    items: z.array(z.string()),
    highlight: z.array(z.number()),
    pointers: z.array(z.object({ name: z.string(), index: z.number() }))
  }),
  z.object({
    type: z.literal('grid'),
    name: z.string(),
    cells: z.array(z.array(z.string())),
    highlight: z.array(z.object({ r: z.number(), c: z.number() })),
    boxSize: z.number() // e.g. 3 for Sudoku boxes, -1 for none
  }),
  z.object({
    type: z.literal('hashmap'),
    name: z.string(),
    entries: z.array(z.object({ key: z.string(), value: z.string() })),
    highlight: z.array(z.string())
  }),
  z.object({
    type: z.literal('sets'),
    name: z.string(),
    bins: z.array(z.object({ label: z.string(), items: z.array(z.string()) })),
    flash: z.number() // index of the bin that just got a repeat, -1 for none
  }),
  z.object({
    type: z.literal('plot'),
    xMin: z.number(),
    xMax: z.number(),
    yMin: z.number(),
    yMax: z.number(),
    functions: z.array(z.object({ expr: z.string(), label: z.string() })), // math.js syntax
    points: z.array(z.object({ x: z.number(), y: z.number(), label: z.string() })),
    shade: z.object({ expr: z.string(), from: z.number(), to: z.number() }) // expr "" = no shading
  }),
  z.object({
    type: z.literal('vectors'),
    vectors: z.array(z.object({ x: z.number(), y: z.number(), label: z.string() })),
    surfaceAngleDeg: z.number() // ramp angle, -1 for no surface
  }),
  z.object({
    type: z.literal('numberline'),
    min: z.number(),
    max: z.number(),
    marks: z.array(z.object({ x: z.number(), label: z.string() }))
  }),
  z.object({
    type: z.literal('tree'),
    nodes: z.array(z.object({ id: z.string(), label: z.string(), parent: z.string() })), // parent "" = root
    highlight: z.array(z.string())
  }),
  z.object({
    type: z.literal('graph'),
    nodes: z.array(z.object({ id: z.string(), label: z.string() })),
    edges: z.array(z.object({ from: z.string(), to: z.string(), label: z.string() })),
    directed: z.boolean()
  })
])

export const Visual = z.object({
  caption: z.string(),
  frames: z.array(Scene), // [] = no visual
  narration: z.array(z.string()) // one spoken sentence per frame
})

// ---------- the reply ----------

export const WireTurn = z.object({
  kind: TurnKind,
  message: z.string(), // Markdown, math in $...$
  hintLevel: z.number(), // 0 = none, 1..5 = hint ladder
  verdict: Verdict, // on the student's last answer
  plan: z.array(PlanStep),
  gap: z.object({ type: z.enum(['none', ...GapType.options]), topic: z.string() }),
  expects: Expects,
  choices: z.array(z.string()),
  visual: Visual,
  // The app runs this on the student's next answer. reference is math.js syntax;
  // for 'antiderivative' it's the integrand (the app differentiates the student's answer).
  check: z.object({
    kind: z.enum(['none', ...CheckKind.options]),
    reference: z.string(),
    variable: z.string(),
    unit: z.string()
  })
})

export const WireProblem = z.object({
  subject: Subject,
  title: z.string(),
  summary: z.string(),
  language: z.string(), // coding only: 'python', 'cpp', ...; "" otherwise
  hiddenSolution: z.string() // NEVER sent to the UI
})

export const WireRecap = z.object({
  explainBack: z.string(),
  gaps: z.array(z.object({ type: GapType, topic: z.string() })),
  similarProblem: z.string() // "" = none
})

export const WireReply = z.object({
  problem: WireProblem.nullable(), // only on the reply to [NEW PROBLEM]
  turn: WireTurn,
  recap: WireRecap.nullable() // only on the reply to [RECAP]
})
