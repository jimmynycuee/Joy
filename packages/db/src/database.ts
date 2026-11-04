import { DatabaseSync } from 'node:sqlite'
import type { Migration } from './migrations.js'
import { MIGRATIONS } from './migrations.js'

export type Database = DatabaseSync

export interface OpenOptions {
  /** Defaults to the shipped migrations; tests may pass their own. */
  migrations?: readonly Migration[]
}

/** Opens (or creates) a database at `path` (use ":memory:" in tests) and migrates it to the latest version. */
export function openDatabase(path: string, options: OpenOptions = {}): Database {
  const db = new DatabaseSync(path)
  try {
    db.exec('PRAGMA foreign_keys = ON')
    db.exec('PRAGMA busy_timeout = 5000')
    if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL')
    migrate(db, options.migrations ?? MIGRATIONS)
    return db
  } catch (err) {
    db.close()
    throw err
  }
}

export function schemaVersion(db: Database): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined
  return row?.user_version ?? 0
}

/** Applies every migration newer than the current version, each in its own transaction. Returns versions applied. */
export function migrate(db: Database, migrations: readonly Migration[]): number[] {
  const sorted = [...migrations].sort((a, b) => a.version - b.version)
  sorted.forEach((m, i) => {
    if (m.version !== i + 1)
      throw new Error(`Migrations must be numbered 1..n without gaps; found ${m.version} at ${i + 1}`)
  })
  const current = schemaVersion(db)
  const latest = sorted.at(-1)?.version ?? 0
  if (current > latest) {
    throw new Error(
      `Database schema is version ${current} but this Joy only knows up to ${latest}. Update Joy, or restore an older backup.`,
    )
  }
  const applied: number[] = []
  for (const m of sorted) {
    if (m.version <= current) continue
    db.exec('BEGIN')
    try {
      db.exec(m.sql)
      // PRAGMA cannot take bound parameters; version is a validated integer.
      db.exec(`PRAGMA user_version = ${m.version}`)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw new Error(`Migration ${m.version} (${m.name}) failed: ${(err as Error).message}`, { cause: err })
    }
    applied.push(m.version)
  }
  return applied
}
