// Backups (T4.7): a daily copy of the database, the last seven kept, and a restore that checks the file first and
// keeps a copy of what it replaces.
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Database } from './database.js'
import { schemaVersion } from './database.js'
import { LATEST_VERSION } from './migrations.js'

export const BACKUPS_KEPT = 7
const DAILY = /^joy-(\d{4}-\d{2}-\d{2})\.sqlite$/

export interface BackupFile {
  path: string
  /** UTC day the backup was taken (YYYY-MM-DD). */
  day: string
  bytes: number
}

/** Writes a consistent copy of the open database to `path` (which must not exist yet). */
export function backupDatabase(db: Database, path: string): void {
  if (existsSync(path)) throw new Error(`${path} already exists`)
  db.prepare('VACUUM INTO ?').run(path)
}

/** The daily backups in `dir`, newest first. */
export async function listBackups(dir: string): Promise<BackupFile[]> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const files: BackupFile[] = []
  for (const name of names) {
    const day = DAILY.exec(name)?.[1]
    if (!day) continue
    const path = join(dir, name)
    files.push({ path, day, bytes: (await stat(path)).size })
  }
  return files.sort((a, b) => b.day.localeCompare(a.day))
}

/**
 * Takes today's backup unless it exists, then keeps only the newest `keep`. Returns the new backup's path, or
 * undefined when today's was already there.
 */
export async function dailyBackup(
  db: Database,
  dir: string,
  now: Date = new Date(),
  keep: number = BACKUPS_KEPT,
): Promise<string | undefined> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, `joy-${now.toISOString().slice(0, 10)}.sqlite`)
  let created: string | undefined
  if (!existsSync(path)) {
    // Written under a temporary name first, so a crash never leaves a half-written file that looks like a backup.
    const partial = `${path}.partial`
    await rm(partial, { force: true })
    backupDatabase(db, partial)
    await rename(partial, path)
    created = path
  }
  for (const old of (await listBackups(dir)).slice(keep)) await rm(old.path, { force: true })
  return created
}

/** Checks that `path` is a readable, intact Joy database this version can open. Returns its schema version. */
export function verifyBackup(path: string): number {
  if (!existsSync(path)) throw new Error(`${path} does not exist`)
  let db: DatabaseSync
  try {
    db = new DatabaseSync(path, { readOnly: true })
  } catch (error) {
    throw new Error(`${path} is not a SQLite database: ${(error as Error).message}`, { cause: error })
  }
  try {
    const integrity = db.prepare('PRAGMA integrity_check').get() as { integrity_check?: string } | undefined
    if (integrity?.integrity_check !== 'ok') throw new Error(`${path} is damaged (integrity check failed)`)
    const version = schemaVersion(db)
    const hasTasks = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tasks'").get()
    if (version === 0 || !hasTasks) throw new Error(`${path} is not a Joy database`)
    if (version > LATEST_VERSION)
      throw new Error(
        `${path} was written by a newer Joy (schema ${version}); update Joy before restoring it`,
      )
    return version
  } catch (error) {
    if (error instanceof Error && error.message.includes(path)) throw error
    throw new Error(`${path} is not a Joy database: ${(error as Error).message}`, { cause: error })
  } finally {
    db.close()
  }
}

/**
 * Replaces the database at `target` with `backup`. Joy must not be running. The current database is first saved as
 * `<target>.before-restore-<time>.sqlite`; the restored copy is migrated to the latest schema when Joy next opens it.
 * Returns the path of that safety copy (undefined when there was no database yet).
 */
export async function restoreDatabase(
  backup: string,
  target: string,
  now: Date = new Date(),
): Promise<string | undefined> {
  verifyBackup(backup)
  await mkdir(dirname(target), { recursive: true })
  let safety: string | undefined
  if (existsSync(target)) {
    safety = join(
      dirname(target),
      `${basename(target)}.before-restore-${now.toISOString().replace(/[:.]/g, '-')}.sqlite`,
    )
    // VACUUM INTO also folds in anything still in the write-ahead log.
    const current = new DatabaseSync(target)
    try {
      current.prepare('VACUUM INTO ?').run(safety)
    } finally {
      current.close()
    }
  }
  const staged = `${target}.restoring`
  await copyFile(backup, staged)
  // A leftover write-ahead log belongs to the old file and would be replayed onto the restored one.
  for (const suffix of ['-wal', '-shm']) await rm(`${target}${suffix}`, { force: true })
  await rename(staged, target)
  return safety
}
