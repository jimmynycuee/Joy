import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runDoctor } from './index.js'
import type { DoctorOptions, DoctorReport } from './index.js'

export interface DoctorCliOutput {
  stdout?: (text: string) => void
  stderr?: (text: string) => void
}

export function formatDoctorReport(report: DoctorReport): string {
  return report.checks
    .flatMap((check) => [
      `${check.status.toUpperCase().padEnd(8)} ${check.label}: ${check.detail}`,
      ...(check.repair ? [`         Repair: ${check.repair}`] : []),
    ])
    .join('\n')
}

export async function runDoctorCli(
  args: readonly string[],
  options: DoctorOptions & DoctorCliOutput = {},
): Promise<number> {
  const stdout = options.stdout ?? ((text: string) => console.log(text))
  const stderr = options.stderr ?? ((text: string) => console.error(text))
  if (args.length !== 1 || args[0] !== 'doctor') {
    stderr('Usage: joy doctor')
    return 2
  }

  const report = await runDoctor(options)
  stdout(formatDoctorReport(report))
  return report.checks.some((check) => check.status === 'missing') ? 1 : 0
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await runDoctorCli(process.argv.slice(2))
}
