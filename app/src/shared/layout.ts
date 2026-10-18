// Where a card goes next to the student's code (the tutor's code-mode animation, the visual
// island): never on top of it if there's room, and out from under the Clueless panel.
import type { Rect } from './contracts'

export type Side = 'right' | 'left' | 'below' | 'above' | 'inside'

export interface Point {
  x: number
  y: number
}

export interface Placement {
  card: Rect
  side: Side
  /** The arrow from the highlighted code line to the card (null when the card sits on the code). */
  arrow: { from: Point; to: Point } | null
}

const MARGIN = 12 // from the screen edges
const GAP = 36 // between the code and the card (room for the arrow)

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))

export function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

/**
 * @param area the code the student selected
 * @param size the card's size
 * @param view the screen (stage window) size
 * @param avoid the Clueless panel, if it's on this screen
 * @param anchorY the middle of the highlighted code lines
 */
export function placeCard(
  area: Rect,
  size: { width: number; height: number },
  view: { width: number; height: number },
  avoid: Rect | null,
  anchorY: number
): Placement {
  const { width, height } = size
  const y = clamp(anchorY - height / 2, MARGIN, view.height - height - MARGIN)
  const x = clamp(area.x, MARGIN, view.width - width - MARGIN)
  const candidates: [Side, Rect][] = [
    ['right', { x: area.x + area.width + GAP, y, width, height }],
    ['left', { x: area.x - GAP - width, y, width, height }],
    ['below', { x, y: area.y + area.height + GAP, width, height }],
    ['above', { x, y: area.y - GAP - height, width, height }]
  ]
  const fits = (r: Rect): boolean =>
    r.x >= MARGIN && r.y >= MARGIN && r.x + r.width <= view.width - MARGIN && r.y + r.height <= view.height - MARGIN
  const free = (r: Rect): boolean => !avoid || !intersects(r, avoid)

  const found = candidates.find(([, r]) => fits(r) && free(r)) ?? candidates.find(([, r]) => fits(r))
  if (!found) {
    // The code fills the screen: float the card in its bottom-right corner.
    const card = {
      x: clamp(area.x + area.width - width - MARGIN, MARGIN, view.width - width - MARGIN),
      y: clamp(area.y + area.height - height - MARGIN, MARGIN, view.height - height - MARGIN),
      width,
      height
    }
    return { card, side: 'inside', arrow: null }
  }

  const [side, card] = found
  const cardY = clamp(anchorY, card.y + 18, card.y + card.height - 18)
  const cardX = card.x + card.width / 2
  const lineX = clamp(cardX, area.x + 16, area.x + area.width - 16)
  const arrow =
    side === 'right'
      ? { from: { x: area.x + area.width, y: anchorY }, to: { x: card.x, y: cardY } }
      : side === 'left'
        ? { from: { x: area.x, y: anchorY }, to: { x: card.x + card.width, y: cardY } }
        : side === 'below'
          ? { from: { x: lineX, y: area.y + area.height }, to: { x: cardX, y: card.y } }
          : { from: { x: lineX, y: area.y }, to: { x: cardX, y: card.y + card.height } }
  return { card, side, arrow }
}

/** A smooth arrow path between two points, leaving and arriving along the given side. */
export function arrowPath(from: Point, to: Point, side: Side): string {
  if (side === 'below' || side === 'above') {
    const dy = (to.y - from.y) / 2
    return `M${from.x} ${from.y} C${from.x} ${from.y + dy} ${to.x} ${to.y - dy} ${to.x} ${to.y}`
  }
  const dx = (to.x - from.x) / 2
  return `M${from.x} ${from.y} C${from.x + dx} ${from.y} ${to.x - dx} ${to.y} ${to.x} ${to.y}`
}

/**
 * The arrow from the code line at `anchorY` (in `area`, the highlighted code) to a card that's
 * already somewhere (the visual island). null when the card covers the code.
 */
export function arrowTo(area: Rect, anchorY: number, card: Rect): { from: Point; to: Point; side: Side } | null {
  const cardY = clamp(anchorY, card.y + 18, card.y + card.height - 18)
  const cardX = card.x + card.width / 2
  const lineX = clamp(cardX, area.x + 16, area.x + area.width - 16)
  if (card.x >= area.x + area.width) return { from: { x: area.x + area.width, y: anchorY }, to: { x: card.x, y: cardY }, side: 'right' }
  if (card.x + card.width <= area.x) return { from: { x: area.x, y: anchorY }, to: { x: card.x + card.width, y: cardY }, side: 'left' }
  if (card.y >= area.y + area.height) return { from: { x: lineX, y: area.y + area.height }, to: { x: cardX, y: card.y }, side: 'below' }
  if (card.y + card.height <= area.y) return { from: { x: lineX, y: area.y }, to: { x: cardX, y: card.y + card.height }, side: 'above' }
  return null
}
