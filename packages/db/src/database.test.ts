import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Database } from './database.js'
import { migrate, openDatabase, schemaVersion } from './database.js'
import { LATEST_VERSION } from './migrations.js'

const open: Database[] = []
const dirs: string[] = []
function fresh(): Database {
  const db = openDatabase(':memory:')
  open.push(db)
  return db
}
afterEach(() => {
  for (const db of open.splice(0)) if (db.isOpen) db.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const tables = (db: Database) =>
  (
    db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table') ORDER BY name").all() as {
      name: string
    }[]
  ).map((r) => r.name)

function seedTask(db: Database) {
  db.prepare("INSERT INTO repos (id, path, default_branch) VALUES ('r1', '/repo', 'main')").run()
  db.prepare(
    "INSERT INTO tasks (id, repo_id, title, prompt, mode, status) VALUES ('t1', 'r1', 'Fix', 'fix it', 'review_loop', 'queued')",
  ).run()
}

describe('openDatabase', () => {
  it('creates an empty database and migrates it to the latest version', () => {
    const db = fresh()
    expect(schemaVersion(db)).toBe(LATEST_VERSION)
    expect(tables(db)).toEqual(
      expect.arrayContaining([
        'approvals',
        'attempts',
        'conversations',
        'events',
        'memories',
        'memories_fts',
        'messages',
        'repos',
        'reviews',
        'schedules',
        'tasks',
        'usage',
      ]),
    )
  })

  it('reopens a file database without re-running migrations', () => {
    const dir = mkdtempSync(join(tmpdir(), 'joy-db-'))
    dirs.push(dir)
    const path = join(dir, 'joy.sqlite')
    const first = openDatabase(path)
    seedTask(first)
    first.close()
    const second = openDatabase(path)
    open.push(second)
    expect(schemaVersion(second)).toBe(LATEST_VERSION)
    expect(second.prepare('SELECT count(*) AS n FROM tasks').get()).toEqual({ n: 1 })
  })

  it('refuses a database from a newer Joy', () => {
    const dir = mkdtempSync(join(tmpdir(), 'joy-db-'))
    dirs.push(dir)
    const path = join(dir, 'joy.sqlite')
    openDatabase(path, {
      migrations: [
        { version: 1, name: 'a', sql: 'CREATE TABLE a (x)' },
        { version: 2, name: 'b', sql: 'CREATE TABLE b (x)' },
      ],
    }).close()
    expect(() =>
      openDatabase(path, { migrations: [{ version: 1, name: 'a', sql: 'CREATE TABLE a (x)' }] }),
    ).toThrow(/version 2 but this Joy only knows up to 1/)
  })
})

describe('migrate', () => {
  it('rolls back a failing migration and keeps the previous version', () => {
    const db = fresh()
    const before = schemaVersion(db)
    expect(() =>
      migrate(db, [
        { version: 1, name: 'x', sql: '' },
        { version: 2, name: 'broken', sql: 'CREATE TABLE ok_table (x); THIS IS NOT SQL' },
      ]),
    ).toThrow(/Migration 2 \(broken\) failed/)
    expect(schemaVersion(db)).toBe(before)
    expect(tables(db)).not.toContain('ok_table')
  })

  it('rejects gaps in migration numbers', () => {
    const db = fresh()
    expect(() => migrate(db, [{ version: 2, name: 'x', sql: '' }])).toThrow(/without gaps/)
  })
})

describe('schema', () => {
  it('enforces foreign keys and cascades deletes', () => {
    const db = fresh()
    expect(() =>
      db
        .prepare(
          "INSERT INTO tasks (id, repo_id, title, prompt, mode, status) VALUES ('t', 'missing', 'x', 'x', 'single', 'queued')",
        )
        .run(),
    ).toThrow(/FOREIGN KEY/)
    seedTask(db)
    db.prepare(
      "INSERT INTO attempts (id, task_id, provider, model, status) VALUES ('a1', 't1', 'claude-cli', 'opus', 'running')",
    ).run()
    db.prepare(
      "INSERT INTO events (attempt_id, seq, type, payload) VALUES ('a1', 1, 'message', '{\"text\":\"hi\"}')",
    ).run()
    db.prepare("DELETE FROM repos WHERE id = 'r1'").run()
    expect(db.prepare('SELECT count(*) AS n FROM events').get()).toEqual({ n: 0 })
  })

  it('rejects invalid enum values and invalid JSON', () => {
    const db = fresh()
    seedTask(db)
    expect(() => db.prepare("UPDATE tasks SET status = 'bogus' WHERE id = 't1'").run()).toThrow(/CHECK/)
    expect(() => db.prepare("UPDATE tasks SET role_overrides = 'not json' WHERE id = 't1'").run()).toThrow(
      /CHECK/,
    )
  })

  it('keeps the memory full-text index in sync', () => {
    const db = fresh()
    const search = (q: string) =>
      (
        db
          .prepare(
            'SELECT m.id FROM memories_fts f JOIN memories m ON m.rowid = f.rowid WHERE memories_fts MATCH ?',
          )
          .all(q) as {
          id: string
        }[]
      ).map((r) => r.id)
    db.prepare(
      "INSERT INTO memories (id, scope, content, source) VALUES ('m1', 'user', 'prefers small pull requests', 'user_utterance')",
    ).run()
    expect(search('pull')).toEqual(['m1'])
    db.prepare("UPDATE memories SET content = 'prefers squash merges' WHERE id = 'm1'").run()
    expect(search('pull')).toEqual([])
    expect(search('squash')).toEqual(['m1'])
    db.prepare("DELETE FROM memories WHERE id = 'm1'").run()
    expect(search('squash')).toEqual([])
  })

  it('keeps FTS rows associated after VACUUM and excludes sensitive memories', () => {
    const dir = mkdtempSync(join(tmpdir(), 'joy-db-'))
    dirs.push(dir)
    const db = openDatabase(join(dir, 'joy.sqlite'))
    open.push(db)
    const insert = db.prepare(
      "INSERT INTO memories (id, scope, content, source, sensitive) VALUES (?, 'user', ?, 'user_utterance', ?)",
    )
    insert.run('m1', 'shared target alpha', 0)
    insert.run('m2', 'deleted filler', 0)
    insert.run('m3', 'shared target beta', 0)
    insert.run('m4', 'unrelated gamma', 0)
    insert.run('ms', 'private sensitive phrase', 1)
    expect(() => insert.run(null, 'missing id', 0)).toThrow(/NOT NULL/)
    expect(() => insert.run('m1', 'duplicate id', 0)).toThrow(/UNIQUE/)
    db.prepare("DELETE FROM memories WHERE id = 'm2'").run()
    const keysBeforeVacuum = db.prepare('SELECT id, memory_id FROM memories ORDER BY id').all()
    db.exec('VACUUM')
    expect(db.prepare('SELECT id, memory_id FROM memories ORDER BY id').all()).toEqual(keysBeforeVacuum)

    const search = (query: string) =>
      (
        db
          .prepare(
            'SELECT m.id FROM memories_fts f JOIN memories m ON m.memory_id = f.rowid WHERE memories_fts MATCH ? ORDER BY m.id',
          )
          .all(query) as { id: string }[]
      ).map((row) => row.id)

    expect(search('target')).toEqual(['m1', 'm3'])
    expect(search('sensitive')).toEqual([])

    db.prepare("UPDATE memories SET content = 'replaced banana' WHERE id = 'm3'").run()
    expect(search('target')).toEqual(['m1'])
    expect(search('replaced')).toEqual(['m3'])

    db.prepare("UPDATE memories SET sensitive = 0 WHERE id = 'ms'").run()
    expect(search('sensitive')).toEqual(['ms'])
    db.prepare("UPDATE memories SET sensitive = 1 WHERE id = 'ms'").run()
    expect(search('sensitive')).toEqual([])

    db.prepare("DELETE FROM memories WHERE id = 'm3'").run()
    expect(search('replaced')).toEqual([])
    insert.run('m5', 'shared target cherry', 0)
    expect(search('target')).toEqual(['m1', 'm5'])
  })

  it('requires exactly one of cron or run_at on schedules', () => {
    const db = fresh()
    expect(() => db.prepare("INSERT INTO schedules (id, payload) VALUES ('s', '{}')").run()).toThrow(/CHECK/)
    db.prepare("INSERT INTO schedules (id, cron, payload) VALUES ('s', '0 9 * * 1-5', '{}')").run()
  })
})
