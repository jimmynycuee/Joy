import { describe, expect, it } from 'vitest'
import { MENU_GAP, MENU_MARGIN, MENU_PADDING, placeFloating } from './menu-position.js'

const viewport = { width: 1000, height: 800 }
const size = { width: 250, height: 300 }

describe('placeFloating above or below a trigger', () => {
  it('sits 4px under the trigger, left edges lined up', () => {
    const anchor = { left: 100, top: 100, width: 120, height: 34 }
    const placed = placeFloating({ anchor, size, viewport })
    expect(placed).toMatchObject({ left: 100, top: 100 + 34 + MENU_GAP, side: 'bottom' })
  })

  it('goes above, 4px away, when asked and there is room', () => {
    const anchor = { left: 100, top: 500, width: 120, height: 34 }
    const placed = placeFloating({ anchor, size, viewport, side: 'top' })
    expect(placed).toMatchObject({ top: 500 - MENU_GAP - 300, side: 'top' })
  })

  it('flips to the other side when the preferred one is too short and the other has more room', () => {
    const nearBottom = { left: 100, top: 700, width: 120, height: 34 }
    expect(placeFloating({ anchor: nearBottom, size, viewport, side: 'bottom' }).side).toBe('top')
    const nearTop = { left: 100, top: 40, width: 120, height: 34 }
    expect(placeFloating({ anchor: nearTop, size, viewport, side: 'top' }).side).toBe('bottom')
  })

  it('stays on its side, limited to the room left, when the other side is no better', () => {
    const short = { width: 1000, height: 200 }
    const anchor = { left: 100, top: 40, width: 120, height: 34 }
    const placed = placeFloating({ anchor, size, viewport: short, side: 'bottom' })
    expect(placed.side).toBe('bottom')
    expect(placed.maxHeight).toBe(200 - MENU_MARGIN - (40 + 34 + MENU_GAP))
  })

  it('aligns to the trigger end and is kept inside the window', () => {
    const anchor = { left: 800, top: 100, width: 150, height: 34 }
    expect(placeFloating({ anchor, size, viewport, align: 'end' }).left).toBe(800 + 150 - 250)
    const far = { left: 900, top: 100, width: 80, height: 34 }
    expect(placeFloating({ anchor: far, size, viewport }).left).toBe(1000 - MENU_MARGIN - 250)
    const edge = { left: 2, top: 100, width: 40, height: 34 }
    expect(placeFloating({ anchor: edge, size, viewport, align: 'end' }).left).toBe(MENU_MARGIN)
  })
})

describe('placeFloating beside a row (sub-menus)', () => {
  it('opens to the right with its first row level with the trigger', () => {
    const anchor = { left: 300, top: 200, width: 248, height: 32 }
    const placed = placeFloating({ anchor, size, viewport, side: 'right' })
    expect(placed).toMatchObject({ left: 300 + 248 + MENU_GAP, top: 200 - MENU_PADDING, side: 'right' })
  })

  it('falls back to the left when the right is cut off', () => {
    const anchor = { left: 700, top: 200, width: 248, height: 32 }
    const placed = placeFloating({ anchor, size, viewport, side: 'right' })
    expect(placed.side).toBe('left')
    expect(placed.left).toBe(700 - MENU_GAP - 250)
  })

  it('overlaps, inside the window, on a narrow screen where neither side fits', () => {
    const phone = { width: 375, height: 700 }
    const anchor = { left: 60, top: 200, width: 260, height: 32 }
    const placed = placeFloating({
      anchor,
      size: { width: 280, height: 150 },
      viewport: phone,
      side: 'right',
    })
    expect(placed.left).toBeGreaterThanOrEqual(MENU_MARGIN)
    expect(placed.left + 280).toBeLessThanOrEqual(375 - MENU_MARGIN)
  })

  it('keeps a tall sub-menu inside the window vertically', () => {
    const anchor = { left: 300, top: 700, width: 248, height: 32 }
    const placed = placeFloating({ anchor, size, viewport, side: 'right' })
    expect(placed.top + 300).toBeLessThanOrEqual(800 - MENU_MARGIN)
    const high = placeFloating({ anchor: { ...anchor, top: 2 }, size, viewport, side: 'right' })
    expect(high.top).toBe(MENU_MARGIN)
  })
})
