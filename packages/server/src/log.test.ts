import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Redactor } from '@joy/secrets'
import { createFileLogger, listLogFiles } from './log.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('debug log', () => {
  it('writes JSON lines with no known secret, anywhere in the entry', () => {
    const dir = mkdtempSync(join(tmpdir(), 'joy-log-'))
    dirs.push(dir)
    const redactor = new Redactor()
    redactor.add('log-secret-value-42')
    const log = createFileLogger({
      dir,
      redactor,
      now: () => new Date('2026-11-06T10:00:00Z'),
      console: false,
    })
    log.info('started with log-secret-value-42', {
      nested: { token: 'log-secret-value-42' },
      list: ['log-secret-value-42'],
    })
    log.warn('OpenAI said: invalid key sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCD')
    const text = readFileSync(join(dir, 'joy-2026-11-06.log'), 'utf8')
    expect(text).not.toContain('log-secret-value-42')
    expect(text).not.toContain('sk-proj-abcdefghijklmnopqrstuvwxyz')
    const lines = text
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { level: string; ts: string })
    expect(lines.map((l) => l.level)).toEqual(['info', 'warn'])
    expect(lines[0]?.ts).toBe('2026-11-06T10:00:00.000Z')
  })

  it('starts a new file each day and keeps 14 days', () => {
    const dir = mkdtempSync(join(tmpdir(), 'joy-log-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'joy-2026-10-01.log'), 'old\n')
    writeFileSync(join(dir, 'notes.txt'), 'not a log\n')
    let now = new Date('2026-11-01T12:00:00Z')
    const log = createFileLogger({ dir, redactor: new Redactor(), now: () => now, console: false })
    for (let day = 1; day <= 16; day++) {
      now = new Date(Date.UTC(2026, 10, day, 12))
      log.info(`day ${day}`)
    }
    const files = listLogFiles(dir)
    expect(files).toHaveLength(14)
    expect(files[0]?.day).toBe('2026-11-16')
    expect(files.at(-1)?.day).toBe('2026-11-03')
    expect(readFileSync(join(dir, 'notes.txt'), 'utf8')).toBe('not a log\n')
  })
})
