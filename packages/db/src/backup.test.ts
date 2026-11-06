import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { RepoId, TaskId } from '@joy/core'
import { dailyBackup, listBackups, restoreDatabase, verifyBackup } from './backup.js'
import type { Database } from './database.js'
import { openDatabase } from './database.js'
import { createRepo, createTask, getTask, listTasks } from './repositories.js'

const dirs: string[] = []
const databases: Database[] = []
afterEach(() => {
  for (const db of databases.splice(0)) if (db.isOpen) db.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function temp() {
  const dir = mkdtempSync(join(tmpdir(), 'joy-backup-'))
  dirs.push(dir)
  return dir
}
function open(path: string) {
  const db = openDatabase(path)
  databases.push(db)
  return db
}

describe('backups', () => {
  it('takes one backup a day and keeps the newest seven', async () => {
    const dir = temp()
    const db = open(join(dir, 'joy.sqlite'))
    const backups = join(dir, 'backups')
    for (let day = 1; day <= 9; day++) {
      const created = await dailyBackup(db, backups, new Date(Date.UTC(2026, 10, day, 12)))
      expect(created).toBe(join(backups, `joy-2026-11-0${day}.sqlite`))
    }
    expect(await dailyBackup(db, backups, new Date(Date.UTC(2026, 10, 9, 18)))).toBeUndefined()
    const kept = await listBackups(backups)
    expect(kept.map((b) => b.day)).toEqual(
      ['09', '08', '07', '06', '05', '04', '03'].map((d) => `2026-11-${d}`),
    )
    expect(readdirSync(backups).some((name) => name.endsWith('.partial'))).toBe(false)
  })

  it('restores a backup with all its data and keeps a copy of what it replaced', async () => {
    const dir = temp()
    const path = join(dir, 'joy.sqlite')
    const db = open(path)
    createRepo(db, { id: 'r' as RepoId, path: '/r', defaultBranch: 'main' })
    createTask(db, {
      id: 'kept' as TaskId,
      repoId: 'r' as RepoId,
      title: 'Before backup',
      prompt: 'p',
      mode: 'single',
    })
    const backup = (await dailyBackup(db, join(dir, 'backups'))) as string
    createTask(db, {
      id: 'later' as TaskId,
      repoId: 'r' as RepoId,
      title: 'After backup',
      prompt: 'p',
      mode: 'single',
    })
    db.close()

    const safety = await restoreDatabase(backup, path, new Date(Date.UTC(2026, 10, 6)))
    const restored = open(path)
    expect(listTasks(restored).map((t) => t.id)).toEqual(['kept'])
    expect(getTask(restored, 'kept' as TaskId)?.title).toBe('Before backup')
    // The database that was replaced is still there, including the task added after the backup.
    expect(safety && existsSync(safety)).toBe(true)
    const before = open(safety as string)
    expect(
      listTasks(before)
        .map((t) => t.id)
        .sort(),
    ).toEqual(['kept', 'later'])
  })

  it('refuses files that are not intact Joy databases', async () => {
    const dir = temp()
    const junk = join(dir, 'junk.sqlite')
    writeFileSync(junk, 'not a database')
    expect(() => verifyBackup(junk)).toThrow(/not a .*database/)
    expect(() => verifyBackup(join(dir, 'missing.sqlite'))).toThrow(/does not exist/)
    const empty = join(dir, 'empty.sqlite')
    open(empty).close()
    // An opened Joy database is fine; a plain SQLite file without Joy's tables is not.
    expect(verifyBackup(empty)).toBeGreaterThan(0)
    const { DatabaseSync } = await import('node:sqlite')
    const other = new DatabaseSync(join(dir, 'other.sqlite'))
    other.exec('CREATE TABLE x (y)')
    other.close()
    expect(() => verifyBackup(join(dir, 'other.sqlite'))).toThrow(/not a Joy database/)
    await expect(restoreDatabase(junk, join(dir, 'joy.sqlite'))).rejects.toThrow()
    expect(existsSync(join(dir, 'joy.sqlite'))).toBe(false)
  })
})
