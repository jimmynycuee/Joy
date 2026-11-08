import { describe, expect, it } from 'vitest'
import { shortcutFor } from './shortcuts.js'

const press = (key: string, extra: Partial<Parameters<typeof shortcutFor>[0]> = {}) => ({
  key,
  metaKey: false,
  ctrlKey: true,
  altKey: false,
  shiftKey: false,
  ...extra,
})

describe('shortcutFor', () => {
  it('maps the four app shortcuts with ⌘ or Ctrl', () => {
    expect(shortcutFor(press('k'), false)).toBe('palette')
    expect(shortcutFor(press('K', { metaKey: true, ctrlKey: false }), false)).toBe('palette')
    expect(shortcutFor(press('n'), false)).toBe('new-task')
    expect(shortcutFor(press('b'), false)).toBe('toggle-sidebar')
    expect(shortcutFor(press('\\'), false)).toBe('toggle-changes')
  })

  it('ignores keys without the modifier and other combinations', () => {
    expect(shortcutFor(press('k', { ctrlKey: false }), false)).toBeUndefined()
    expect(shortcutFor(press('k', { altKey: true }), false)).toBeUndefined()
    expect(shortcutFor(press('n', { shiftKey: true }), false)).toBeUndefined()
    expect(shortcutFor(press('x'), false)).toBeUndefined()
  })

  it('only lets the command palette through while typing', () => {
    expect(shortcutFor(press('k'), true)).toBe('palette')
    expect(shortcutFor(press('n'), true)).toBeUndefined()
    expect(shortcutFor(press('b'), true)).toBeUndefined()
    expect(shortcutFor(press('\\'), true)).toBeUndefined()
  })
})
