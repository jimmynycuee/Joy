// CLI versions Joy was tested with (T4.6). Each range is the span of versions the contract fixtures in
// tests/fixtures/cli-events were recorded with; a test keeps it in step with those recordings. A version outside the
// range may still work, but Joy warns, because the CLIs change their output without notice.

export type CliName = 'claude' | 'codex'

export interface TestedRange {
  /** Oldest recorded version. */
  from: string
  /** Newest recorded version. */
  through: string
}

export const TESTED_CLI_VERSIONS: Record<CliName, TestedRange> = {
  claude: { from: '2.1.317', through: '2.1.317' },
  // Only a sandbox recording without a login exists so far (T0.4 is open); real runs are not contract-tested yet.
  codex: { from: '0.166.0', through: '0.166.0' },
}

export const RECORD_COMMAND: Record<CliName, string> = {
  claude: 'node scripts/record-fixtures.mjs claude',
  codex: 'node scripts/record-fixtures.mjs codex',
}

/** The x.y.z part of `--version` output such as "2.1.317 (Claude Code)" or "codex-cli 0.166.0". */
export function parseCliVersion(output: string): string | undefined {
  return /(?:^|[\s(v])(\d+\.\d+\.\d+)(?:[-+][\w.-]+)?(?=$|[\s)])/m.exec(output)?.[1]
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

export type VersionCheck =
  | { status: 'tested'; version: string; message: string }
  | { status: 'untested'; version: string; message: string; repair: string }
  | { status: 'unknown'; message: string }

/** Whether this CLI version is inside the tested range, with a message the owner can act on. */
export function checkCliVersion(cli: CliName, versionOutput: string): VersionCheck {
  const label = cli === 'claude' ? 'Claude Code' : 'Codex'
  const version = parseCliVersion(versionOutput)
  if (!version) return { status: 'unknown', message: `${label} CLI version could not be read.` }
  const range = TESTED_CLI_VERSIONS[cli]
  const span = range.from === range.through ? range.from : `${range.from}–${range.through}`
  if (compareVersions(version, range.from) >= 0 && compareVersions(version, range.through) <= 0)
    return { status: 'tested', version, message: `${label} CLI ${version} is a tested version (${span}).` }
  return {
    status: 'untested',
    version,
    message: `${label} CLI ${version} has not been tested with Joy (tested: ${span}); its output format may have changed.`,
    repair: `Re-record the contract fixtures with \`${RECORD_COMMAND[cli]}\`, run \`pnpm test\`, and update TESTED_CLI_VERSIONS; or install a tested version.`,
  }
}
