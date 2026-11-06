// Compares installed (or, with --latest, the newest published) Claude Code and Codex CLI versions with the versions
// Joy's contract fixtures were recorded with. Runs only `--version`: never a model call. Untested versions are reported
// as GitHub Actions warnings, not failures: re-recording needs a logged-in machine (see docs/cli-versions.md).
import { execFileSync } from 'node:child_process'
import { checkCliVersion } from '../packages/providers/src/versions.js'
import type { CliName } from '../packages/providers/src/versions.js'

const latest = process.argv.includes('--latest')
const packages: Record<CliName, string> = { claude: '@anthropic-ai/claude-code', codex: '@openai/codex' }
const inCi = process.env.GITHUB_ACTIONS === 'true'

for (const cli of ['claude', 'codex'] as CliName[]) {
  let output: string
  try {
    output = latest
      ? execFileSync('pnpm', ['dlx', `${packages[cli]}@latest`, '--version'], {
          encoding: 'utf8',
          shell: false,
        })
      : execFileSync(cli, ['--version'], { encoding: 'utf8', shell: false })
  } catch (error) {
    console.log(`${cli}: could not run --version (${error instanceof Error ? error.message : String(error)})`)
    continue
  }
  const check = checkCliVersion(cli, output)
  if (check.status === 'untested') {
    console.log(
      inCi
        ? `::warning title=${cli} CLI untested::${check.message} ${check.repair}`
        : `${check.message}\n  ${check.repair}`,
    )
  } else {
    console.log(check.message)
  }
}
