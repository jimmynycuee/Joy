import { DatabaseSync } from 'node:sqlite'

export interface HomeLock {
  release(): void
}

/**
 * Takes `path` (a file in JOY_HOME) for this process alone, so a second Joy on the same home stops before it touches
 * anything (it would delete the first one's run files at start and race it on worktrees and tasks).
 *
 * An exclusive SQLite lock rather than a pid file: the operating system drops it when the process ends, however it
 * ends, so a crash never leaves a stale lock and a reused pid never blocks a start. It works the same on macOS,
 * Linux and Windows.
 */
export function lockHome(path: string): HomeLock {
  const db = new DatabaseSync(path, { timeout: 0 })
  try {
    db.exec('PRAGMA locking_mode = EXCLUSIVE')
    // In exclusive locking mode the lock taken by this write is kept until the connection closes.
    db.exec('BEGIN EXCLUSIVE')
    db.exec('CREATE TABLE IF NOT EXISTS holder (pid INTEGER NOT NULL) STRICT')
    db.exec('DELETE FROM holder')
    db.prepare('INSERT INTO holder (pid) VALUES (?)').run(process.pid)
    db.exec('COMMIT')
  } catch (error) {
    db.close()
    if (isBusy(error))
      throw new Error(
        `Another Joy is already running with this home folder (${path}). Stop it first, or set JOY_HOME to another folder.`,
        { cause: error },
      )
    throw error
  }
  return {
    release() {
      if (db.isOpen) db.close()
    },
  }
}

function isBusy(error: unknown): boolean {
  const code = (error as { errcode?: unknown }).errcode
  // SQLITE_BUSY (5) and SQLITE_LOCKED (6), including their extended codes.
  return typeof code === 'number' && ((code & 0xff) === 5 || (code & 0xff) === 6)
}
