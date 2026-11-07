import { describe, expect, it } from 'vitest'
import { THEME_LABELS, nextTheme, parseTheme } from './theme.js'

describe('theme preference', () => {
  it('accepts only light and dark, everything else follows the system', () => {
    expect(parseTheme('light')).toBe('light')
    expect(parseTheme('dark')).toBe('dark')
    expect(parseTheme('system')).toBe('system')
    expect(parseTheme('purple')).toBe('system')
    expect(parseTheme(null)).toBe('system')
    expect(parseTheme(undefined)).toBe('system')
  })

  it('cycles 系統 → 淺色 → 深色 → 系統', () => {
    expect(nextTheme('system')).toBe('light')
    expect(nextTheme('light')).toBe('dark')
    expect(nextTheme('dark')).toBe('system')
    expect(THEME_LABELS.system).toBe('系統')
  })
})
