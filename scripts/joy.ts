import { join } from 'node:path'
import { ConfigStore, joyHome } from '../packages/config/src/index.js'
import { runDoctor } from '../packages/server/src/doctor.js'
import { backupNow, restoreFromBackup } from '../packages/server/src/restore.js'
import { createJoyServer } from '../packages/server/src/server.js'

const [command, ...args] = process.argv.slice(2)

const USAGE = [
  'Usage:',
  '  pnpm joy start [--port N]   start Joy on 127.0.0.1 (default port 4317); then run `pnpm web`',
  '  pnpm joy doctor             check the CLIs, keychain and data folder',
  '  pnpm joy backup             back up the database now (one per day, the last 7 are kept)',
  '  pnpm joy restore <file|day> restore a backup, e.g. 2026-11-06 (stop Joy first)',
].join('\n')

if (command === '--help' || args.includes('--help')) {
  console.log(USAGE)
} else if (command === 'start') {
  const portArg = args.indexOf('--port')
  const port = portArg >= 0 ? Number(args[portArg + 1]) : 4317
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error('--port must be a number from 0 to 65535')
    process.exitCode = 2
  } else {
    const server = await createJoyServer()
    const address = await server.listen(port)
    console.log(`Joy is running on http://127.0.0.1:${address.port} (data in ${joyHome()}).`)
    console.log(
      'Open the app with `pnpm web` in another terminal, then go to http://localhost:5173. Ctrl+C stops Joy.',
    )
    let stopping = false
    const stop = () => {
      if (stopping) return
      stopping = true
      console.log('Stopping Joy…')
      void server.close().then(() => process.exit(0))
    }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
  }
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
