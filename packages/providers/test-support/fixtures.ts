import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
export const fakeCli = join(dirname(fileURLToPath(import.meta.url)), 'fake-cli.mjs')
export const fakeWsl = join(dirname(fileURLToPath(import.meta.url)), 'fake-wsl.mjs')

export function fixturePath(cli: 'claude' | 'codex', name: string): string {
  return join(repoRoot, 'tests', 'fixtures', 'cli-events', cli, `${name}.jsonl`)
}

/** Absolute stand-in for the sanitized `<WORKDIR>` placeholder, so path handling is exercised for real. */
export const FIXTURE_WORKDIR = join(tmpdir(), 'joy-fixture-workdir')

export function readFixture(cli: 'claude' | 'codex', name: string): unknown[] {
  return readFileSync(fixturePath(cli, name), 'utf8')
    .split('<WORKDIR>')
    .join(FIXTURE_WORKDIR.split('\\').join('\\\\'))
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as unknown)
}
