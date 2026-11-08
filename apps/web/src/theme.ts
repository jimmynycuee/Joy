import { readStorage, writeStorage } from './storage.js'

export type ThemePreference = 'system' | 'light' | 'dark'

export const THEME_LABELS: Record<ThemePreference, string> = {
  system: '系統',
  light: '淺色',
  dark: '深色',
}

const THEME_KEY = 'joy.theme'

export function parseTheme(value: string | null | undefined): ThemePreference {
  return value === 'light' || value === 'dark' ? value : 'system'
}

export function readTheme(): ThemePreference {
  return parseTheme(readStorage(THEME_KEY))
}

/** `data-theme` on <html>: absent means follow the system, which the CSS handles with prefers-color-scheme. */
export function applyTheme(theme: ThemePreference): void {
  const root = document.documentElement
  if (theme === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', theme)
}

export function saveTheme(theme: ThemePreference): void {
  writeStorage(THEME_KEY, theme === 'system' ? null : theme)
  applyTheme(theme)
}

export function nextTheme(theme: ThemePreference): ThemePreference {
  return theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system'
}
