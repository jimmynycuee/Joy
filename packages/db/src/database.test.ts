import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PROVIDER_KINDS } from '@joy/core'
import { afterEach, describe, expect, it } from 'vitest'
import type { Database } from './database.js'
import { migrate, openDatabase, schemaVersion } from './database.js'
import { LATEST_VERSION, MIGRATIONS } from './migrations.js'

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

  it('upgrades existing repositories with the default all-provider allowlist', () => {
    const db = openDatabase(':memory:', { migrations: MIGRATIONS.slice(0, 1) })
    open.push(db)
    db.prepare("INSERT INTO repos (id, path, default_branch) VALUES ('r1', '/repo', 'main')").run()
    migrate(db, MIGRATIONS)
    const row = db.prepare('SELECT allowed_providers FROM repos WHERE id = ?').get('r1') as {
      allowed_providers: string
    }
    expect(JSON.parse(row.allowed_providers) as string[]).toEqual([...PROVIDER_KINDS])
    for (const [index, provider] of PROVIDER_KINDS.entries()) {
      expect(() =>
        db
          .prepare('INSERT INTO repos (id, path, default_branch, allowed_providers) VALUES (?, ?, ?, ?)')
          .run(`provider-${index}`, `/provider-${index}`, 'main', JSON.stringify([provider])),
      ).not.toThrow()
      expect(() =>
        db
          .prepare('UPDATE repos SET allowed_providers = ? WHERE id = ?')
          .run(JSON.stringify([provider]), 'r1'),
      ).not.toThrow()
    }
    for (const [index, invalid] of [
      '[]',
      '["claude-cli","claude-cli"]',
      '["unknown"]',
      '{"provider":"claude-cli"}',
    ].entries()) {
      expect(() =>
        db.prepare('UPDATE repos SET allowed_providers = ? WHERE id = ?').run(invalid, 'r1'),
      ).toThrow(/allowed providers/)
      expect(() =>
        db
          .prepare('INSERT INTO repos (id, path, default_branch, allowed_providers) VALUES (?, ?, ?, ?)')
          .run(`bad-${index}`, `/bad-${index}`, 'main', invalid),
      ).toThrow(/allowed providers/)
    }
  })

  it('adds a safe user provenance default while retaining the new external_content marker', () => {
    const db = openDatabase(':memory:', { migrations: MIGRATIONS.slice(0, 4) })
    open.push(db)
    seedTask(db)
    migrate(db, MIGRATIONS)
    expect(db.prepare('SELECT provenance FROM tasks WHERE id = ?').get('t1')).toEqual({ provenance: 'user' })
    expect(() =>
      db.prepare("UPDATE tasks SET provenance = 'external_content' WHERE id = 't1'").run(),
    ).not.toThrow()
    expect(() => db.prepare("UPDATE tasks SET provenance = 'untrusted' WHERE id = 't1'").run()).toThrow(
      /CHECK/,
    )
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
    const db = openDatabase(':memory:', { migrations: MIGRATIONS.slice(0, 1) })
    open.push(db)
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

  it('requires exactly one of cron or run_at on schedules', () => {
    const db = fresh()
    expect(() => db.prepare("INSERT INTO schedules (id, payload) VALUES ('s', '{}')").run()).toThrow(/CHECK/)
    db.prepare("INSERT INTO schedules (id, cron, payload) VALUES ('s', '0 9 * * 1-5', '{}')").run()
  })
})
