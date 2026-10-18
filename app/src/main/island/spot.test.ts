import { describe, expect, it } from 'vitest'
import { spotFromSelection, type Gray } from './spot'

/** A fake editor: lines of "text" (bright speckles) every `lineHeight` px from `top`. */
function editor(opts: { top: number; lineHeight: number; lines: [number, number][]; background?: number; selection?: number; text?: number }): Gray {
  const gray: Gray = { x: 0, y: 0, width: 900, height: 500, data: new Uint8Array(900 * 500).fill(opts.background ?? 30) }
  opts.lines.forEach(([x0, x1], k) => {
    const lineTop = opts.top + k * opts.lineHeight
    for (let y = lineTop; y < lineTop + opts.lineHeight; y++) {
      for (let x = x0; x < x1; x++) {
        const glyphRow = y >= lineTop + opts.lineHeight * 0.25 && y < lineTop + opts.lineHeight * 0.75
        const glyph = glyphRow && (x * 7 + y * 3) % 5 < 2
        if (glyph) gray.data[y * gray.width + x] = opts.text ?? 210
        else if (opts.selection != null) gray.data[y * gray.width + x] = opts.selection
      }
    }
  })
  return gray
}

const CODE: [number, number][] = [
  [120, 420], // class Solution:
  [150, 520],
  [180, 380],
  [180, 460],
  [210, 330]
]

describe('spotFromSelection', () => {
  it('finds the line grid even when the drag started low in the first line', () => {
    const gray = editor({ top: 100, lineHeight: 24, lines: CODE })
    const spot = spotFromSelection({ x: 125, y: 100 + 20 }, { x: 330, y: 100 + 4 * 24 + 20 }, 5, 7, gray)
    expect(spot.displayId).toBe(7)
    expect(spot.lineHeight).toBe(24)
    expect(Math.abs(spot.top - 100)).toBeLessThanOrEqual(2)
    expect(Math.abs(spot.left - (120 - 6))).toBeLessThanOrEqual(2)
    expect(Math.abs(spot.left + spot.width - (520 + 6))).toBeLessThanOrEqual(2)
  })

  it('keeps the line numbers and the panel beside the editor out of the highlight', () => {
    const gray = editor({ top: 100, lineHeight: 24, lines: CODE })
    for (let y = 100; y < 100 + 5 * 24; y++) {
      for (let x = 70; x < 92; x++) if ((x + y) % 3 === 0 && (y - 100) % 24 > 6 && (y - 100) % 24 < 18) gray.data[y * gray.width + x] = 150 // line numbers
      gray.data[y * gray.width + 50] = 120 // the editor's left edge
      for (let x = 0; x < 45; x++) if ((x * 5 + y) % 4 === 0) gray.data[y * gray.width + x] = 220 // the problem text beside it
    }
    const spot = spotFromSelection({ x: 121, y: 112 }, { x: 330, y: 100 + 4 * 24 + 12 }, 5, 1, gray)
    expect(Math.abs(spot.left - (120 - 6))).toBeLessThanOrEqual(2)
  })

  it('works on a light theme with the selection colored in', () => {
    const gray = editor({ top: 60, lineHeight: 20, lines: CODE, background: 250, selection: 205, text: 25 })
    const spot = spotFromSelection({ x: 121, y: 60 + 3 }, { x: 330, y: 60 + 4 * 20 + 3 }, 5, 1, gray)
    expect(Math.abs(spot.top - 60)).toBeLessThanOrEqual(2)
  })

  it('measures a single highlighted line from its text', () => {
    const gray = editor({ top: 200, lineHeight: 30, lines: [[100, 400]] })
    const spot = spotFromSelection({ x: 150, y: 214 }, { x: 150, y: 214 }, 1, 1, gray)
    expect(spot.lineHeight).toBeGreaterThan(18)
    expect(spot.top).toBeLessThanOrEqual(207)
    expect(spot.top + spot.lineHeight).toBeGreaterThanOrEqual(222)
  })

  it('gives up on the line grid when the drag does not fit the line count', () => {
    const spot = spotFromSelection({ x: 10, y: 100 }, { x: 200, y: 104 }, 6, 1, null)
    expect(spot).toMatchObject({ lineHeight: 0, left: 200, top: 104 })
  })

  it('uses the drag points alone without a screenshot', () => {
    const spot = spotFromSelection({ x: 100, y: 112 }, { x: 300, y: 172 }, 4, 1, null)
    expect(spot).toMatchObject({ lineHeight: 20, top: 102, lines: 4 })
  })
})
