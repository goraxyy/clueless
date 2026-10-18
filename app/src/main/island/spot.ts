// Where are the highlighted lines on screen? We know where the drag started and ended and how many
// lines were copied, so the line height is the drag's height divided by the line count. The
// screenshot then fine-tunes it: rows with text on them have "ink" (pixels that stand out from
// their row), the gaps between lines have none, so we slide the line grid until its centers sit
// on the ink, and find the left and right edges of the text.
// No Electron imports, so it's unit-tested with made-up images.
import type { CodeSpot } from '../../shared/contracts'

export interface Point {
  x: number
  y: number
}

/** A grayscale copy of part of a display, one value per DIP pixel, in display-local coordinates. */
export interface Gray {
  x: number
  y: number
  width: number
  height: number
  data: Uint8Array // luminance 0..255, row by row
}

const DEFAULT_LINE = 22
/** A pixel this much brighter or darker than its row's usual color is ink. */
const INK = 48

/**
 * `from` / `to`: where the drag started and ended (display-local DIP). `lines`: how many lines the
 * highlight has. `gray`: the screen around it, or null (then the drag points alone are used).
 */
export function spotFromSelection(from: Point, to: Point, lines: number, displayId: number, gray: Gray | null): CodeSpot {
  const n = Math.max(1, lines)
  const y0 = Math.min(from.y, to.y)
  const y1 = Math.max(from.y, to.y)
  const xa = Math.min(from.x, to.x)
  const xb = Math.max(from.x, to.x)
  let h = n > 1 ? (y1 - y0) / (n - 1) : DEFAULT_LINE
  // A drag that doesn't match the line count (wrapped lines, a keyboard selection): no line grid.
  if (n > 1 && (h < 8 || h > 90)) return { displayId, left: to.x, top: to.y, width: 0, lineHeight: 0, lines: n }

  let center = y0 // the middle of the first line
  let left = xa - 8
  let right = Math.max(xb, xa + 240) + 8
  if (gray) {
    const ink = rowInk(gray, Math.max(xa - 10, gray.x), Math.min(Math.max(xb, xa + 80) + 10, gray.x + gray.width))
    if (n === 1) {
      const band = inkBand(ink, gray, y0)
      if (band) {
        h = Math.max(12, (band.bottom - band.top) * 1.45)
        center = (band.top + band.bottom) / 2
      }
    } else {
      center = y0 + bestPhase(ink, gray, y0, h, n)
    }
    const edges = textEdges(gray, center - h / 2, center + (n - 0.5) * h, xa, xb, h)
    if (edges) [left, right] = [edges.left - 6, edges.right + 6]
  }
  return { displayId, left: Math.round(left), width: Math.round(right - left), top: Math.round(center - h / 2), lineHeight: h, lines: n }
}

/** Per row of `gray`: how many pixels between x0 and x1 stand out from that row's usual color. */
function rowInk(gray: Gray, x0: number, x1: number): Float32Array {
  const out = new Float32Array(gray.height)
  const a = Math.max(0, Math.round(x0 - gray.x))
  const b = Math.min(gray.width, Math.round(x1 - gray.x))
  if (b <= a) return out
  const hist = new Uint32Array(256)
  for (let r = 0; r < gray.height; r++) {
    hist.fill(0)
    const row = r * gray.width
    for (let c = a; c < b; c++) hist[gray.data[row + c]]++
    const med = median(hist, b - a)
    let count = 0
    for (let c = a; c < b; c++) if (Math.abs(gray.data[row + c] - med) > INK) count++
    out[r] = count / (b - a)
  }
  return out
}

function median(hist: Uint32Array, total: number): number {
  let seen = 0
  for (let v = 0; v < 256; v++) {
    seen += hist[v]
    if (seen * 2 >= total) return v
  }
  return 255
}

const inkAt = (ink: Float32Array, gray: Gray, y: number): number => {
  const r = Math.round(y - gray.y)
  return r >= 0 && r < ink.length ? ink[r] : 0
}

/** The shift (-h/2..h/2) that puts the most ink on the line centers and the least between lines. */
function bestPhase(ink: Float32Array, gray: Gray, y0: number, h: number, n: number): number {
  let best = 0
  let bestScore = -Infinity
  const reach = Math.floor(h / 2)
  for (let d = -reach; d <= reach; d++) {
    let score = 0
    for (let k = 0; k < n; k++) {
      const c = y0 + d + k * h
      // the middle third of a line has the most ink; the gap between lines has none
      score += inkAt(ink, gray, c) + inkAt(ink, gray, c - h / 6) + inkAt(ink, gray, c + h / 6)
      score -= 1.5 * inkAt(ink, gray, c + h / 2)
    }
    // ties: stay close to where the mouse was
    if (score > bestScore + 1e-6 || (Math.abs(score - bestScore) <= 1e-6 && Math.abs(d) < Math.abs(best))) {
      bestScore = score
      best = d
    }
  }
  return best
}

/** The run of inked rows around `y` (allowing 1-row gaps), or null if there's no ink there. */
function inkBand(ink: Float32Array, gray: Gray, y: number): { top: number; bottom: number } | null {
  const r = Math.round(y - gray.y)
  const has = (i: number): boolean => i >= 0 && i < ink.length && ink[i] > 0.01
  let start = r
  for (let i = r; i >= Math.max(0, r - 6); i--) if (has(i)) start = i
  if (!has(start)) return null
  let top = start
  let bottom = start
  while (has(top - 1) || has(top - 2)) top -= has(top - 1) ? 1 : 2
  while (has(bottom + 1) || has(bottom + 2)) bottom += has(bottom + 1) ? 1 : 2
  return { top: top + gray.y, bottom: bottom + 1 + gray.y }
}

/** Left and right edges of the text in rows top..bottom, starting from the drag's x range. */
function textEdges(gray: Gray, top: number, bottom: number, xa: number, xb: number, h: number): { left: number; right: number } | null {
  const r0 = Math.max(0, Math.round(top - gray.y))
  const r1 = Math.min(gray.height, Math.round(bottom - gray.y))
  if (r1 <= r0) return null
  // each row's usual color, then which columns have ink in any row
  const meds: number[] = []
  const hist = new Uint32Array(256)
  for (let r = r0; r < r1; r++) {
    hist.fill(0)
    for (let c = 0; c < gray.width; c++) hist[gray.data[r * gray.width + c]]++
    meds.push(median(hist, gray.width))
  }
  // how many of the rows have ink in column c
  const colInk = (c: number): number => {
    let n = 0
    for (let r = r0; r < r1; r++) if (Math.abs(gray.data[r * gray.width + c] - meds[r - r0]) > INK) n++
    return n / (r1 - r0)
  }
  const border = (c: number): boolean => r1 - r0 >= 3 && colInk(c) >= 0.8 // a divider, scrollbar or panel edge
  const ca = Math.max(0, Math.min(gray.width - 1, Math.round(xa - gray.x)))
  const cb = Math.max(0, Math.min(gray.width - 1, Math.round(xb - gray.x)))
  // Left: the text of the lines (word gaps are under a character), stopping at the first real gap,
  // so the line numbers in the gutter and the panel beside the editor stay out.
  let left = ca
  for (let c = ca, empty = 0; c >= 0 && empty < Math.max(6, h * 0.75); c--) {
    if (border(c)) break
    if (colInk(c) > 0) {
      left = c
      empty = 0
    } else empty++
  }
  // Right: lines end at different places, so allow a wider gap, but never past a divider.
  let right = cb
  for (let c = cb, empty = 0; c < gray.width && empty < h * 4; c++) {
    if (border(c)) break
    if (colInk(c) > 0) {
      right = c
      empty = 0
    } else empty++
  }
  return { left: left + gray.x, right: right + 1 + gray.x }
}

/**
 * A screenshot crop (BGRA bytes, `scale` image pixels per DIP) as a Gray in display-local DIP,
 * with its top-left at (originX, originY).
 */
export function grayFromBitmap(bgra: Uint8Array, width: number, height: number, scale: number, originX: number, originY: number): Gray {
  const w = Math.max(1, Math.floor(width / scale))
  const h = Math.max(1, Math.floor(height / scale))
  const data = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    const sy = Math.min(height - 1, Math.round(y * scale))
    for (let x = 0; x < w; x++) {
      const i = (sy * width + Math.min(width - 1, Math.round(x * scale))) * 4
      data[y * w + x] = (bgra[i] * 29 + bgra[i + 1] * 150 + bgra[i + 2] * 77) >> 8 // B, G, R
    }
  }
  return { x: originX, y: originY, width: w, height: h, data }
}
