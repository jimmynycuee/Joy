import { useCallback, useEffect, useState } from 'react'
import { parseStoredComments } from '../diff-comments.js'
import type { DiffComment } from '../diff-comments.js'
import { readStorage, writeStorage } from '../storage.js'

const key = (taskId: string) => `joy.diffComments.${taskId}`

/** Unsent diff comments of one task, kept in this browser like a draft so a reload or page switch loses nothing. */
export function useDiffComments(taskId: string) {
  const [items, setItems] = useState<DiffComment[]>(() => parseStoredComments(readStorage(key(taskId))))
  useEffect(() => {
    setItems(parseStoredComments(readStorage(key(taskId))))
  }, [taskId])
  const save = useCallback(
    (next: DiffComment[]) => {
      setItems(next)
      writeStorage(key(taskId), next.length ? JSON.stringify(next) : null)
    },
    [taskId],
  )
  const add = useCallback(
    // Not crypto.randomUUID: it is missing on plain-http origins (remote access by Tailscale IP).
    (comment: Omit<DiffComment, 'id'>) =>
      save([
        ...items,
        { ...comment, id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}` },
      ]),
    [items, save],
  )
  const remove = useCallback((id: string) => save(items.filter((c) => c.id !== id)), [items, save])
  const clear = useCallback(() => save([]), [save])
  return { items, add, remove, clear }
}
