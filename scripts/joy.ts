import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { ConfigStore, joyHome } from '../packages/config/src/index.js'
import { NO_ACTION_NEEDED, runDoctor } from '../packages/server/src/doctor.js'
import { backupNow, restoreFromBackup } from '../packages/server/src/restore.js'
import { createJoyServer } from '../packages/server/src/server.js'
import {
  DEFAULT_SERVICE_PORT,
  realServiceDeps,
  runService,
  type ServiceAction,
} from '../packages/server/src/service.js'
import { uiBuildState } from '../packages/server/src/ui-build.js'

const [command, ...args] = process.argv.slice(2)
const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))

const USAGE = [
  'Usage:',
  '  pnpm joy start [--port N]   start Joy on 127.0.0.1 (default port 4317); open it at that address after `build-ui`, or run `pnpm web`',
  '  pnpm joy build-ui           build the web app that `start` serves (run again after `git pull`)',
  '  pnpm joy service <install|uninstall|status> [--node <path>] [--port N] [--dry-run]',
  '                              run Joy in the background at login, without a terminal (needs a Node 22)',
  '  pnpm joy doctor             check the CLIs, keychain and data folder',
  '  pnpm joy container-build    build the agent image for untrusted repositories',
  '  pnpm joy container-login <claude|codex>  log a CLI in inside the agent container (once)',
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
    const ui = uiBuildState(repoRoot)
    if (ui === 'fresh')
      console.log(`Open http://127.0.0.1:${address.port} in your browser. Ctrl+C stops Joy.`)
    else
      console.log(
        `The web app is ${ui === 'missing' ? 'not built yet' : 'older than its source'}: run \`pnpm joy build-ui\`, then open http://127.0.0.1:${address.port}. ` +
          'For development, run `pnpm web` in another terminal and open http://localhost:5173. Ctrl+C stops Joy.',
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
} else if (command === 'build-ui') {
  // Run Vite with this Node directly: `pnpm` is a .cmd shim on Windows and Joy never spawns through a shell.
  const web = join(repoRoot, 'apps', 'web')
  let viteBin: string
  try {
    viteBin = join(
      dirname(createRequire(join(web, 'package.json')).resolve('vite/package.json')),
      'bin',
      'vite.js',
    )
  } catch {
    console.error('Cannot find Vite. Run `pnpm install` in the Joy folder first.')
    process.exit(1)
  }
  const result = spawnSync(process.execPath, [viteBin, 'build'], { cwd: web, stdio: 'inherit', shell: false })
  if (result.error) console.error(`Could not run the build: ${result.error.message}`)
  else if (result.status === 0)
    console.log(
      'Built. `pnpm joy start` (or the background service) now serves it; restart Joy if it is running.',
    )
  process.exitCode = result.status ?? 1
} else if (command === 'service') {
  const action = args[0]
  const flags = args.slice(1)
  const valueOf = (flag: string): string | undefined => {
    const index = flags.indexOf(flag)
    return index >= 0 ? flags[index + 1] : undefined
  }
  const known = new Set(['--port', '--node', '--dry-run'])
  const unknown = flags.filter(
    (flag, index) =>
      flag.startsWith('-') && !known.has(flag) && !(index > 0 && flags[index - 1] === '--node'),
  )
  const port = valueOf('--port') === undefined ? DEFAULT_SERVICE_PORT : Number(valueOf('--port'))
  if (
    (action !== 'install' && action !== 'uninstall' && action !== 'status') ||
    unknown.length > 0 ||
    (flags.includes('--node') && !valueOf('--node')) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    console.error(USAGE)
    process.exitCode = 2
  } else {
    const node = valueOf('--node')
    process.exitCode = await runService(
      action as ServiceAction,
      {
        platform: process.platform,
        userHome: homedir(),
        joyHome: joyHome(),
        repoRoot,
        port,
        dryRun: flags.includes('--dry-run'),
        ...(node ? { node } : {}),
        ...(typeof process.getuid === 'function' ? { uid: process.getuid() } : {}),
        execPath: process.execPath,
        execVersion: process.version,
        env: process.env,
      },
      realServiceDeps((line) => console.log(line), uiBuildState),
    )
  }
} else if (command === 'container-build' || command === 'container-login') {
  const home = joyHome()
  const config = await new ConfigStore(join(home, 'config.yaml')).get()
  const image = config.container.image
  let dockerArgs: string[] | undefined
  if (command === 'container-build') {
    const dockerDir = fileURLToPath(new URL('../docker/', import.meta.url))
    dockerArgs = ['build', '-t', image, '-f', join(dockerDir, 'agent.Dockerfile'), dockerDir]
  } else if (args[0] === 'claude' || args[0] === 'codex') {
    const loginHome = join(home, 'container-home', args[0])
    mkdirSync(loginHome, { recursive: true, mode: 0o700 })
    // Interactive: the CLI shows its own login. The login is stored in loginHome, not in your home directory.
    dockerArgs = [
      'run',
      '--rm',
      '-it',
      '--network',
      'host',
      '--mount',
      `type=bind,source=${loginHome},target=/joy-home`,
      '--env',
      'HOME=/joy-home',
      ...(typeof process.getuid === 'function' && typeof process.getgid === 'function'
        ? ['--user', `${process.getuid()}:${process.getgid()}`]
        : []),
      image,
      ...(args[0] === 'claude' ? ['claude'] : ['codex', 'login']),
    ]
  }
  if (!dockerArgs) {
    console.error(USAGE)
    process.exitCode = 2
  } else {
    const result = spawnSync('docker', dockerArgs, { stdio: 'inherit', shell: false })
    if (result.error)
      console.error(`Could not run docker: ${result.error.message}. Install Docker and start it.`)
    process.exitCode = result.status ?? 1
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
    if (check.repair !== NO_ACTION_NEEDED) console.log(`  修復：${check.repair}`)
  }
  if (report.checks.some((check) => check.status !== 'ok')) process.exitCode = 1
}
