import { join } from 'node:path'
import { ConfigStore, joyHome } from '../packages/config/src/index.js'
import { runDoctor } from '../packages/server/src/doctor.js'
import { backupNow, restoreFromBackup } from '../packages/server/src/restore.js'

const [command, ...args] = process.argv.slice(2)

const USAGE = [
  'Usage:',
  '  pnpm joy doctor             check the CLIs, keychain and data folder',
  '  pnpm joy backup             back up the database now (one per day, the last 7 are kept)',
  '  pnpm joy restore <file|day> restore a backup, e.g. 2026-11-06 (stop Joy first)',
].join('\n')

if (command === '--help' || args.includes('--help')) {
  console.log(USAGE)
} else if (command === 'backup' || command === 'restore') {
  try {
    if (command === 'backup') console.log(await backupNow(joyHome()))
    else if (!args[0]) {
      console.error(USAGE)
      process.exitCode = 2
    } else console.log(await restoreFromBackup(joyHome(), args[0]))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
} else if (command !== 'doctor') {
  console.error(USAGE)
  process.exitCode = 2
} else {
  const home = joyHome()
  let commands: { claude?: string; codex?: string } | undefined
  try {
    const config = await new ConfigStore(join(home, 'config.yaml')).get()
    commands = {
      ...(config.providers.claude.command ? { claude: config.providers.claude.command } : {}),
      ...(config.providers.codex.command ? { codex: config.providers.codex.command } : {}),
    }
  } catch {
    // Doctor should still be useful when the optional configuration file is invalid.
  }
  const report = await runDoctor({ home, ...(commands ? { commands } : {}) })
  for (const check of report.checks) {
    console.log(`${check.status.toUpperCase()}: ${check.label} — ${check.summary}`)
    if (check.repair !== 'No action needed.') console.log(`  Repair: ${check.repair}`)
  }
  if (report.checks.some((check) => check.status !== 'ok')) process.exitCode = 1
}
