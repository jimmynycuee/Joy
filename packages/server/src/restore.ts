// `pnpm joy backup` and `pnpm joy restore <file>` (T4.7). Restoring replaces the database file, so it refuses while a
// Joy server is using it.
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { ConfigStore, resolvePaths } from '@joy/config'
import { dailyBackup, listBackups, openDatabase, restoreDatabase } from '@joy/db'

/** True when the pid file names a process that is still alive. */
export function serverRunning(home: string): number | undefined {
  const pidFile = join(home, 'server.pid')
  if (!existsSync(pidFile)) return undefined
  const pid = Number(readFileSync(pidFile, 'utf8').trim())
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined
  try {
    process.kill(pid, 0)
    return pid
  } catch (error) {
    // EPERM: the process exists but belongs to someone else; treat it as running to be safe.
    return (error as NodeJS.ErrnoException).code === 'EPERM' ? pid : undefined
  }
}

async function databasePath(home: string): Promise<string> {
  const config = await new ConfigStore(join(home, 'config.yaml')).get()
  return resolvePaths(config, home).database
}

export async function backupNow(home: string): Promise<string> {
  const db = openDatabase(await databasePath(home))
  try {
    const created = await dailyBackup(db, join(home, 'backups'))
    return created ?? `Today's backup already exists in ${join(home, 'backups')}`
  } finally {
    db.close()
  }
}

/** Restores `file` (a path, or a day like 2026-11-06 from the backups folder) over Joy's database. */
export async function restoreFromBackup(home: string, file: string): Promise<string> {
  const pid = serverRunning(home)
  if (pid) throw new Error(`Joy is running (process ${pid}). Stop it first, then run the restore again.`)
  let backup = resolve(file)
  if (/^\d{4}-\d{2}-\d{2}$/.test(file)) {
    const found = (await listBackups(join(home, 'backups'))).find((b) => b.day === file)
    if (!found) throw new Error(`No backup from ${file} in ${join(home, 'backups')}`)
    backup = found.path
  }
  const target = await databasePath(home)
  const safety = await restoreDatabase(backup, target)
  return [
    `Restored ${backup} to ${target}.`,
    ...(safety ? [`The database it replaced was saved as ${safety}.`] : []),
  ].join('\n')
}
