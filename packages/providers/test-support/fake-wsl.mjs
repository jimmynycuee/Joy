// Fake wsl.exe for provider tests; never launches a real WSL distribution or Codex login.
import { readFileSync, writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
const execAt = args.indexOf('--exec')
const command = args[execAt + 1]
const commandArgs = args.slice(execAt + 2)

if (command === 'wslpath') {
  const hostPath = commandArgs.at(-1) ?? ''
  const drivePath = /^([a-z]):[\\/](.*)$/i.exec(hostPath)
  const linuxPath = drivePath
    ? `/mnt/${drivePath[1]?.toLowerCase()}/${drivePath[2]?.replaceAll('\\', '/')}`
    : hostPath
  process.stdout.write(`${linuxPath}\n`)
  process.exit(0)
}

if (command === 'codex') {
  if (process.env.FAKE_WSL_MODE === 'missing') {
    process.stderr.write('codex: command not found\n')
    process.exit(127)
  }
  if (commandArgs[0] === '--version') {
    process.stdout.write('codex fake-wsl 1.0.0\n')
    process.exit(0)
  }
  if (commandArgs[0] === 'exec' && commandArgs[1] === '--help') process.exit(0)

  if (process.env.FAKE_WSL_ARGS_OUT) {
    writeFileSync(
      process.env.FAKE_WSL_ARGS_OUT,
      JSON.stringify({ cwd: args[args.indexOf('--cd') + 1], args: commandArgs }),
    )
  }
  if (process.env.FAKE_REPLAY) process.stdout.write(readFileSync(process.env.FAKE_REPLAY, 'utf8'))
  process.exit(0)
}

process.stderr.write(`unsupported fake WSL invocation: ${args.join(' ')}\n`)
process.exit(2)
