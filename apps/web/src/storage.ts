// Per-viewer conveniences kept in localStorage: unsent drafts, archived tasks, theme, layout. Storage can be missing
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

/*
 * 封存 (archive) is client-side only for now: the ids live in this browser's localStorage and the task stays on the
 * server. Replace with a server-side archive flag once the backend has one.
 */
const ARCHIVED_KEY = 'joy.archivedTasks'

export function readArchivedTaskIds(): string[] {
  try {
    const parsed: unknown = JSON.parse(readStorage(ARCHIVED_KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

export function writeArchivedTaskIds(ids: readonly string[]): void {
  writeStorage(ARCHIVED_KEY, JSON.stringify(ids))
}

export function useArchivedTasks(): {
  archived: ReadonlySet<string>
  archive: (id: string) => void
  restore: (id: string) => void
} {
  const [ids, setIds] = useState<string[]>(readArchivedTaskIds)
  const archive = useCallback((id: string) => {
    setIds((current) => {
      const next = current.includes(id) ? current : [...current, id]
      writeArchivedTaskIds(next)
      return next
    })
  }, [])
  const restore = useCallback((id: string) => {
    setIds((current) => {
      const next = current.filter((existing) => existing !== id)
      writeArchivedTaskIds(next)
      return next
    })
  }, [])
  return { archived: new Set(ids), archive, restore }
}
