/** The message box grows to at most this many lines… */
export const MAX_COMPOSER_LINES = 12
/** …and never past this share of the window's height; then it scrolls. */
export const MAX_COMPOSER_VIEWPORT_SHARE = 0.4

/** The tallest the box may get, in pixels: 12 lines or 40 % of the window, whichever is smaller. */
export function composerMaxHeight(lineHeight: number, paddingY: number, viewportHeight: number): number {
  const byLines = lineHeight * MAX_COMPOSER_LINES + paddingY
  const byViewport = Math.floor(viewportHeight * MAX_COMPOSER_VIEWPORT_SHARE)
  // A window too short for even one line still shows one.
  return Math.max(lineHeight + paddingY, Math.min(byLines, byViewport))
}

/**
 * The box's height for its content. Below the limit it fits the text exactly and never shows a scrollbar (one
 * appearing and disappearing would rewrap the text and make the box jump); at the limit it scrolls.
 */
export function composerHeight(
  scrollHeight: number,
  maxHeight: number,
): { height: number; overflowY: 'hidden' | 'auto' } {
  return scrollHeight > maxHeight
    ? { height: maxHeight, overflowY: 'auto' }
    : { height: scrollHeight, overflowY: 'hidden' }
}
