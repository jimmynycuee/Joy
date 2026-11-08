// Per-viewer conveniences kept in localStorage: unsent drafts, theme, layout. Storage can be missing
// or throw (private windows, blocked site data), so every access is guarded and the UI works without it.

import { useCallback, useEffect, useState } from 'react'

export function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

export function writeStorage(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, value)
  } catch {
    // Nothing to do: the value just won't survive a reload.
  }
}

const DRAFT_PREFIX = 'joy.draft.'

export function readDraft(context: string): string {
  return readStorage(`${DRAFT_PREFIX}${context}`) ?? ''
}

export function writeDraft(context: string, text: string): void {
  writeStorage(`${DRAFT_PREFIX}${context}`, text.length > 0 ? text : null)
}

/** Text of an unsent message, remembered per context (new task, each conversation) so switching pages loses nothing. */
export function useDraft(context: string): [string, (text: string) => void, () => void] {
  const [text, setText] = useState(() => readDraft(context))
  // Switching context loads that context's draft.
  useEffect(() => {
    setText(readDraft(context))
  }, [context])
  const update = useCallback(
    (next: string) => {
      setText(next)
      writeDraft(context, next)
    },
    [context],
  )
  const clear = useCallback(() => {
    setText('')
    writeDraft(context, '')
  }, [context])
  return [text, update, clear]
}

// Before the server had an archive flag, 封存 lived in this key. It is only read once, to move old choices to the
// server (see `migrateLegacyArchive` in Workspace), and then deleted.
const LEGACY_ARCHIVED_KEY = 'joy.archivedTasks'

/** Task ids from the old localStorage archive; anything that is not a list of strings counts as empty. */
export function parseLegacyArchivedIds(raw: string | null): string[] {
  try {
    const parsed: unknown = JSON.parse(raw ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

export function readLegacyArchivedIds(): string[] {
  return parseLegacyArchivedIds(readStorage(LEGACY_ARCHIVED_KEY))
}

export function clearLegacyArchivedIds(): void {
  writeStorage(LEGACY_ARCHIVED_KEY, null)
}
