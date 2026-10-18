import { describe, expect, it } from 'vitest'
import { arrowTo, intersects, placeCard } from './layout'

const view = { width: 1920, height: 1080 }
const card = { width: 380, height: 300 }

describe('placeCard', () => {
  it('puts the card to the right of the code when there is room', () => {
    const p = placeCard({ x: 40, y: 40, width: 600, height: 500 }, card, view, null, 200)
    expect(p.side).toBe('right')
    expect(p.card.x).toBe(40 + 600 + 36)
    expect(p.arrow?.from).toEqual({ x: 640, y: 200 })
  })

  it('moves to the left when the panel is on the right', () => {
    const panel = { x: 1470, y: 16, width: 440, height: 720 }
    const p = placeCard({ x: 600, y: 100, width: 800, height: 400 }, card, view, panel, 300)
    expect(p.side).toBe('left')
    expect(intersects(p.card, panel)).toBe(false)
  })

  it('goes below code that spans the whole width', () => {
    const p = placeCard({ x: 0, y: 0, width: 1920, height: 600 }, card, view, null, 100)
    expect(p.side).toBe('below')
    expect(p.card.y).toBe(636)
  })

  it('floats inside the code, without an arrow, when the code fills the screen', () => {
    const p = placeCard({ x: 0, y: 0, width: 1920, height: 1080 }, card, view, null, 500)
    expect(p.side).toBe('inside')
    expect(p.arrow).toBeNull()
    expect(p.card.x + p.card.width).toBeLessThanOrEqual(1920)
  })
})

describe('arrowTo', () => {
  const area = { x: 100, y: 200, width: 400, height: 200 }
  it('points from the line to the near edge of a card on the right, at the line\'s height', () => {
    expect(arrowTo(area, 250, { x: 600, y: 100, width: 300, height: 400 })).toEqual({
      from: { x: 500, y: 250 },
      to: { x: 600, y: 250 },
      side: 'right'
    })
  })
  it('stays on the card when the line is above it, and works on the left and below', () => {
    expect(arrowTo(area, 210, { x: 600, y: 300, width: 300, height: 200 })?.to).toEqual({ x: 600, y: 318 })
    expect(arrowTo(area, 250, { x: 0, y: 200, width: 80, height: 100 })?.side).toBe('left')
    expect(arrowTo(area, 250, { x: 150, y: 450, width: 200, height: 100 })?.side).toBe('below')
  })
  it('no arrow when the card sits on the code', () => {
    expect(arrowTo(area, 250, { x: 200, y: 250, width: 100, height: 100 })).toBeNull()
  })
})
