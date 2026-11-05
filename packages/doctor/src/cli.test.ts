import { describe, expect, it } from 'vitest'
import type { DoctorReport } from './index.js'
import { formatDoctorReport, runDoctorCli } from './cli.js'

const report: DoctorReport = {
  checkedAt: '2026-11-05T12:00:00.000Z',
  checks: [
    { id: 'node', label: 'Node.js', status: 'ok', detail: 'Node.js v22.13.1 meets the >=22.13 requirement.' },
    {
      id: 'claude-cli',
      label: 'Claude Code',
      status: 'missing',
      detail: 'Claude Code is not available or its check failed.',
      repair: 'Install Claude Code and ensure its command is available on PATH.',
    },
    {
      id: 'codex-cli',
      label: 'Codex CLI',
      status: 'untested',
      detail: 'Joy has no verified supported-version range.',
    },
  ],
}

describe('joy doctor CLI', () => {
  it('prints each status and actionable repair guidance', () => {
    expect(formatDoctorReport(report)).toBe(
      [
        'OK       Node.js: Node.js v22.13.1 meets the >=22.13 requirement.',
        'MISSING  Claude Code: Claude Code is not available or its check failed.',
        '         Repair: Install Claude Code and ensure its command is available on PATH.',
        'UNTESTED Codex CLI: Joy has no verified supported-version range.',
      ].join('\n'),
    )
  })

  it('accepts only `joy doctor`, prints a useful usage string otherwise', async () => {
    const errors: string[] = []
    const code = await runDoctorCli([], { stderr: (text) => errors.push(text) })
    expect(code).toBe(2)
    expect(errors).toEqual(['Usage: joy doctor'])
  })

  it('returns a nonzero result for missing checks and does not fail on untested versions alone', async () => {
    const output: string[] = []
    const missingCode = await runDoctorCli(['doctor'], {
      stdout: (text) => output.push(text),
      now: () => new Date(report.checkedAt),
      home: '/tmp/joy-doctor-cli-test-home',
      dataDirectoryProbe: async () => {},
      keychainProbe: async () => {},
      commandRunner: async (command, args) => ({
        code: command === 'claude' && args[0] === '--version' ? 127 : 0,
        stdout: command === 'git' ? 'git version 2.49.1' : '',
        timedOut: false,
        failedToStart: false,
      }),
    })
    expect(missingCode).toBe(1)
    expect(output[0]).toContain('MISSING  Claude Code')
  })
})
