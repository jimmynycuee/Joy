export interface Box {
  left: number
  top: number
  width: number
  height: number
}

export interface Size {
  width: number
  height: number
}

export type Side = 'top' | 'bottom' | 'right' | 'left'
export type Align = 'start' | 'end'

export interface Placement {
  left: number
  top: number
  /** Room left on the chosen side, for the panel's own scrolling when it is taller than that. */
  maxHeight: number
  side: Side
}

/** Space between the trigger and the menu, and the least distance kept from the window edge. */
export const MENU_GAP = 4
export const MENU_MARGIN = 8
/** The menu's own padding: a sideways menu starts this far above its trigger so the first items line up. */
export const MENU_PADDING = 6

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, Math.max(min, max)))
}

/**
 * Where a floating panel goes (fixed positioning, window coordinates). Above or below the trigger it prefers `side`
 * and flips when that side is too short and the other has more room; beside it (sub-menus) it prefers the right and
 * falls back to the left, then to overlapping when neither fits. Always kept inside the window.
 */
export function placeFloating({
  anchor,
  size,
  viewport,
  side = 'bottom',
  align = 'start',
  gap = MENU_GAP,
  margin = MENU_MARGIN,
}: {
  anchor: Box
  size: Size
  viewport: Size
  side?: Side
  align?: Align
  gap?: number
  margin?: number
}): Placement {
  if (side === 'left' || side === 'right') {
    const roomRight = viewport.width - margin - (anchor.left + anchor.width + gap)
    const roomLeft = anchor.left - gap - margin
    const fits = { right: roomRight >= size.width, left: roomLeft >= size.width }
    const other: Side = side === 'right' ? 'left' : 'right'
    const preferred: Side = fits[side] ? side : fits[other] ? other : side
    const raw = preferred === 'right' ? anchor.left + anchor.width + gap : anchor.left - gap - size.width
    const maxHeight = viewport.height - margin * 2
    const top = clamp(
      anchor.top - MENU_PADDING,
      margin,
      viewport.height - margin - Math.min(size.height, maxHeight),
    )
    return {
      left: clamp(raw, margin, viewport.width - margin - size.width),
      top,
      maxHeight,
      side: preferred,
    }
  }

  const roomAbove = anchor.top - gap - margin
  const roomBelow = viewport.height - margin - (anchor.top + anchor.height + gap)
  const preferredRoom = side === 'top' ? roomAbove : roomBelow
  const otherRoom = side === 'top' ? roomBelow : roomAbove
  const flip = size.height > preferredRoom && otherRoom > preferredRoom
  const chosen: Side = flip ? (side === 'top' ? 'bottom' : 'top') : side
  const room = Math.max(0, chosen === 'top' ? roomAbove : roomBelow)
  const height = Math.min(size.height, room)
  const top = chosen === 'top' ? anchor.top - gap - height : anchor.top + anchor.height + gap
  const rawLeft = align === 'end' ? anchor.left + anchor.width - size.width : anchor.left
  return {
    left: clamp(rawLeft, margin, viewport.width - margin - size.width),
    top,
    maxHeight: room,
    side: chosen,
  }
}
