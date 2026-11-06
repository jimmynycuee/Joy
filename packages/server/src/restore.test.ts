import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { RepoId, TaskId } from '@joy/core'
import { createRepo, createTask, listTasks, openDatabase } from '@joy/db'
import { backupNow, restoreFromBackup, serverRunning } from './restore.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('joy backup / restore', () => {
  it('restores a day from the backups folder, refusing while Joy runs', async () => {
    const home = mkdtempSync(join(tmpdir(), 'joy-restore-'))
    dirs.push(home)
    const db = openDatabase(join(home, 'joy.sqlite'))
    createRepo(db, { id: 'r' as RepoId, path: '/r', defaultBranch: 'main' })
    createTask(db, { id: 'a' as TaskId, repoId: 'r' as RepoId, title: 'a', prompt: 'p', mode: 'single' })
    db.close()
    const created = await backupNow(home)
    expect(created).toMatch(/joy-\d{4}-\d{2}-\d{2}\.sqlite$/)
    expect(await backupNow(home)).toMatch(/already exists/)

    const later = openDatabase(join(home, 'joy.sqlite'))
    createTask(later, { id: 'b' as TaskId, repoId: 'r' as RepoId, title: 'b', prompt: 'p', mode: 'single' })
    later.close()

    writeFileSync(join(home, 'server.pid'), String(process.pid))
    expect(serverRunning(home)).toBe(process.pid)
    const day = new Date().toISOString().slice(0, 10)
    await expect(restoreFromBackup(home, day)).rejects.toThrow(/Joy is running/)
    // A stale pid file (no such process) does not block the restore.
    writeFileSync(join(home, 'server.pid'), '999999999')
    expect(serverRunning(home)).toBeUndefined()
    expect(await restoreFromBackup(home, day)).toMatch(
      /^Restored [\s\S]*\nThe database it replaced was saved as /,
    )
    const restored = openDatabase(join(home, 'joy.sqlite'))
    expect(listTasks(restored).map((t) => t.id)).toEqual(['a'])
    restored.close()
    await expect(restoreFromBackup(home, '2000-01-01')).rejects.toThrow(/No backup from 2000-01-01/)
  })
})
