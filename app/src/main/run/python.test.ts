import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { looksLikePython, PythonRunner, toCodeTrace } from './python'

const runner = new PythonRunner(join(process.cwd(), 'node_modules', 'pyodide'))
// Loading Python itself takes a few seconds (more on a busy or slow machine): do it once, up front,
// so each test's own time limit covers only its run.
beforeAll(() => runner.run('1 + 1', 60_000), 60_000)
afterAll(() => runner.dispose())

const TWO_SUM = `class Solution:
    def twoSum(self, nums: List[int], target: int) -> List[int]:
        seen = {}
        for i, n in enumerate(nums):
            if target - n in seen:
                return [seen[target - n], i]
            seen[n] = i`

describe('running Python for a trace', () => {
  it('traces a LeetCode method: arguments first, then each line, the condition results and the return', async () => {
    const run = await runner.trace(TWO_SUM, { setup: 'nums = [2, 7, 11]\ntarget = 9', call: 'Solution().twoSum(nums, target)' })
    expect(run.error).toBe('')
    expect(run.value).toBe('[0, 1]')
    const trace = toCodeTrace(run, TWO_SUM)!
    expect(trace.entities.map((e) => [e.name, e.kind])).toEqual([
      ['nums', 'array'],
      ['target', 'value'],
      ['seen', 'map'],
      ['i', 'value'],
      ['n', 'value']
    ])
    expect(trace.entities.find((e) => e.name === 'i')?.indexOf).toBeNull() // i never indexes nums here
    const [call, ...rest] = trace.steps
    expect(call).toMatchObject({ kind: 'call', line: 2 })
    expect(rest.map((s) => [s.line, s.kind, s.result])).toEqual([
      [3, 'assign', ''],
      [4, 'loop', ''],
      [5, 'condition', 'false'],
      [7, 'assign', ''],
      [4, 'loop', ''],
      [5, 'condition', 'true'],
      [6, 'return', '[0, 1]']
    ])
    expect(rest[1].focus).toBe('for i, n in enumerate(nums)')
    expect(rest[2].focus).toBe('target - n in seen')
    expect(rest[3].updates[0]).toMatchObject({ entity: 'seen', value: { entries: [{ key: '2', value: '0' }] } })
  })

  it('runs loose lines with inputs from the setup, and points index variables at their array', async () => {
    const code = `best = 0\nfor i in range(len(nums)):\n    if nums[i] > best:\n        best = nums[i]`
    const trace = toCodeTrace(await runner.trace(code, { setup: 'nums = [3, 9, 4]', call: '' }), code)!
    expect(trace.steps[0]).toMatchObject({ kind: 'call', line: 1, updates: [{ entity: 'nums', value: { items: ['3', '9', '4'] } }] })
    expect(trace.entities.find((e) => e.name === 'i')?.indexOf).toBe('nums')
    expect(trace.steps.at(-1)?.updates).toEqual([]) // the last loop header just ends the loop
  })

  it('draws lists of lists as grids and indexed strings as boxes', async () => {
    const code = `board = [["5", "."], [".", "3"]]\ns = "ab"\nc = s[0]`
    const trace = toCodeTrace(await runner.trace(code, { setup: '', call: '' }), code)!
    expect(trace.entities.map((e) => e.kind)).toEqual(['grid', 'array', 'value'])
    expect(trace.steps[0].updates[0].value.rows).toEqual([
      ['5', '.'],
      ['.', '3']
    ])
    expect(trace.steps[2].updates[0].value.scalar).toBe("'a'")
  })

  it('shows the error where buggy code crashes', async () => {
    const code = `nums = [1, 2]\nfor i in range(3):\n    x = nums[i]`
    const run = await runner.trace(code, { setup: '', call: '' })
    expect(run.error).toBe('IndexError: list index out of range')
    const trace = toCodeTrace(run, code)!
    expect(trace.steps.at(-1)).toMatchObject({ kind: 'other', result: 'IndexError: list index out of range' })
  })

  it('stops a loop that never ends', async () => {
    const code = `i = 0\nwhile True:\n    i += 1`
    const run = await runner.trace(code, { setup: '', call: '' })
    expect(run.stopped).toBe('steps')
    expect(toCodeTrace(run, code)!.steps.length).toBeLessThanOrEqual(120)
  })

  it('reports a bad setup instead of tracing', async () => {
    const run = await runner.trace(TWO_SUM, { setup: 'nums = [2, 7', call: '' })
    expect(run.setupError).toMatch(/SyntaxError/)
    expect(run.steps).toEqual([])
  })

  it('runs a whole program for the test set', async () => {
    expect(await runner.run('print(sum(range(4)))')).toEqual({ ok: true, stdout: '6\n' })
    expect((await runner.run('raise ValueError("no")')).error).toBe('ValueError: no')
  })
})

describe('spotting Python', () => {
  it('tells Python from C-like code', () => {
    expect(looksLikePython(TWO_SUM)).toBe(true)
    expect(looksLikePython('rows = [set() for _ in range(9)]\nseen = {}')).toBe(true)
    expect(looksLikePython('for (int i = 0; i < n; i++) {\n  sum += a[i];\n}')).toBe(false)
    expect(looksLikePython('const seen = new Map();')).toBe(false)
    expect(looksLikePython('int[] a = new int[5];')).toBe(false)
  })
})
