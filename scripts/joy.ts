import { join } from 'node:path'
import { ConfigStore, joyHome } from '../packages/config/src/index.js'
import { runDoctor } from '../packages/server/src/doctor.js'

const [command, ...args] = process.argv.slice(2)

if (command === '--help' || (command === 'doctor' && args.includes('--help'))) {
  console.log('Usage: pnpm joy doctor')
} else if (command !== 'doctor') {
  console.error('Usage: pnpm joy doctor')
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
