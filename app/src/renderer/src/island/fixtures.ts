// A hand-written trace for the tests: LeetCode 217,
// Contains Duplicate, run on nums = [3, 1, 4, 1]. Same shape Claude sends.
import type { EntityValue, TraceReply, TraceStep } from '../../../shared/trace'

export const SAMPLE_CODE = `class Solution:
    def containsDuplicate(self, nums: List[int]) -> bool:
        seen = set()
        for i in range(len(nums)):
            n = nums[i]
            if n in seen:
                return True
            seen.add(n)
        return False`

const v = (over: Partial<EntityValue>): EntityValue => ({ scalar: '', items: [], entries: [], rows: [], ...over })
const step = (line: number, focus: string, kind: TraceStep['kind'], over: Partial<TraceStep> = {}): TraceStep => ({
  line,
  endLine: line,
  focus,
  kind,
  result: '',
  reads: [],
  updates: [],
  ...over
})

const NUMS = ['3', '1', '4', '1']

function pass(i: number, seenBefore: string[]): TraceStep[] {
  const n = NUMS[i]
  const repeat = seenBefore.includes(n)
  const steps = [
    step(4, 'for i in range(len(nums)):', 'loop', { reads: ['nums'], updates: [{ entity: 'i', value: v({ scalar: String(i) }) }] }),
    step(5, 'n = nums[i]', 'assign', { reads: ['nums', 'i'], updates: [{ entity: 'n', value: v({ scalar: n }) }] }),
    step(6, 'n in seen', 'condition', { result: repeat ? 'true' : 'false', reads: ['n', 'seen'] })
  ]
  if (repeat) steps.push(step(7, 'return True', 'return', { result: 'True' }))
  else steps.push(step(8, 'seen.add(n)', 'call', { reads: ['n'], updates: [{ entity: 'seen', value: v({ items: [...seenBefore, n] }) }] }))
  return steps
}

export const CONTAINS_DUPLICATE: TraceReply & { trace: NonNullable<TraceReply['trace']> } = {
  message:
    'Watch `seen` fill up as the loop walks through `nums = [3, 1, 4, 1]`. Keep an eye on the moment a number shows up that is already inside `seen`.',
  trace: {
    language: 'python',
    code: SAMPLE_CODE,
    entities: [
      { id: 'nums', name: 'nums', kind: 'array', indexOf: null },
      { id: 'seen', name: 'seen', kind: 'set', indexOf: null },
      { id: 'i', name: 'i', kind: 'value', indexOf: 'nums' },
      { id: 'n', name: 'n', kind: 'value', indexOf: null }
    ],
    steps: [
      step(2, 'nums: List[int]', 'call', { updates: [{ entity: 'nums', value: v({ items: NUMS }) }] }),
      step(3, 'seen = set()', 'declare', { updates: [{ entity: 'seen', value: v({}) }] }),
      ...pass(0, []),
      ...pass(1, ['3']),
      ...pass(2, ['3', '1']),
      ...pass(3, ['3', '1', '4'])
    ]
  },
  lesson: null
}
