/** True for ⌘ on macOS, Ctrl elsewhere. */
export function isMac(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
}

export function modLabel(): string {
  return isMac() ? '⌘' : 'Ctrl'
}

export const SHORTCUTS = [
  { keys: 'K', label: '命令面板' },
  { keys: 'N', label: '新任務' },
  { keys: 'B', label: '收合或展開側邊欄' },
  { keys: '\\', label: '顯示或隱藏變更面板' },
] as const

export type ShortcutAction = 'palette' | 'new-task' | 'toggle-sidebar' | 'toggle-changes'

/** True when the event target is somewhere the owner is typing, where plain shortcuts must not fire. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

/**
 * Which app shortcut a key event is, if any. ⌘/Ctrl+K works everywhere; the others stay out of the way while typing.
 * Pure over a few event fields so it can be tested without a DOM.
 */
export function shortcutFor(
  event: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean },
  typing: boolean,
): ShortcutAction | undefined {
  if (!(event.metaKey || event.ctrlKey) || event.altKey) return undefined
  const key = event.key.toLowerCase()
  if (key === 'k' && !event.shiftKey) return 'palette'
  if (typing || event.shiftKey) return undefined
  if (key === 'n') return 'new-task'
  if (key === 'b') return 'toggle-sidebar'
  if (key === '\\') return 'toggle-changes'
  return undefined
}

/**
 * Whether Esc should take the owner back out of 設定. Not while typing (Esc belongs to the field), while something
 * else is open on top (palette, dialog, menu, drawer), or when another handler already used the key.
 */
export function escapeLeavesSettings(
  event: { key: string; defaultPrevented: boolean; isComposing: boolean },
  state: { onSettings: boolean; typing: boolean; overlayOpen: boolean },
): boolean {
  return (
    event.key === 'Escape' &&
    !event.defaultPrevented &&
    !event.isComposing &&
    state.onSettings &&
    !state.typing &&
    !state.overlayOpen
  )
}
