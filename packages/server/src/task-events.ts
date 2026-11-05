import type { AttemptId } from '@joy/core'
import { appendTaskEvent, getAttempt } from '@joy/db'
import type { Database } from '@joy/db'

/** Persist task events only when their attempt anchor exists. */
export function appendTaskEventIfAttemptExists(
  db: Database,
  attemptId: AttemptId,
  type: string,
  payload: unknown,
) {
  if (!getAttempt(db, attemptId)) return undefined
  return appendTaskEvent(db, attemptId, type, payload)
}
