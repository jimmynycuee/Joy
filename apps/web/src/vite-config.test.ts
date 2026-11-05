import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readApiToken } from '../vite.config.js'

const token = 'vite-config-test-token-1234567890'
const originalJoyHome = process.env.JOY_HOME
const originalApiToken = process.env.JOY_API_TOKEN
const originalApiTokenFile = process.env.JOY_API_TOKEN_FILE
const directories: string[] = []

afterEach(() => {
  if (originalJoyHome === undefined) delete process.env.JOY_HOME
  else process.env.JOY_HOME = originalJoyHome
  if (originalApiToken === undefined) delete process.env.JOY_API_TOKEN
  else process.env.JOY_API_TOKEN = originalApiToken
  if (originalApiTokenFile === undefined) delete process.env.JOY_API_TOKEN_FILE
  else process.env.JOY_API_TOKEN_FILE = originalApiTokenFile
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'joy-vite-config-test-'))
  directories.push(directory)
  return directory
}

describe('Vite API token configuration', () => {
  it('reads and trims the token from JOY_HOME to match the server path', () => {
    const home = temporaryDirectory()
    writeFileSync(join(home, 'api-token'), `${token}\n`, { mode: 0o600 })
    process.env.JOY_HOME = home
    delete process.env.JOY_API_TOKEN
    delete process.env.JOY_API_TOKEN_FILE

    expect(readApiToken('serve')).toBe(token)
  })

  it('requires an absolute JOY_HOME to keep server and UI token paths consistent', () => {
    process.env.JOY_HOME = 'relative-joy-home'
    delete process.env.JOY_API_TOKEN
    delete process.env.JOY_API_TOKEN_FILE

    expect(() => readApiToken('serve')).toThrow(/JOY_HOME must be an absolute path/)
  })

  it('supports an explicit token file and gives an environment token precedence', () => {
    const directory = temporaryDirectory()
    const tokenFile = join(directory, 'api-token')
    writeFileSync(tokenFile, 'file-token-1234567890\n', { mode: 0o600 })
    chmodSync(tokenFile, 0o600)
    process.env.JOY_API_TOKEN_FILE = tokenFile
    delete process.env.JOY_API_TOKEN
    expect(readApiToken('serve')).toBe('file-token-1234567890')

    process.env.JOY_API_TOKEN = token
    expect(readApiToken('serve')).toBe(token)
  })

  it.skipIf(process.platform === 'win32')('rejects a token file with group or world permissions', () => {
    const directory = temporaryDirectory()
    const tokenFile = join(directory, 'api-token')
    writeFileSync(tokenFile, token, { mode: 0o644 })
    chmodSync(tokenFile, 0o644)
    process.env.JOY_API_TOKEN_FILE = tokenFile
    delete process.env.JOY_API_TOKEN

    expect(() => readApiToken('serve')).toThrow(/permissions must restrict access to its owner/)
  })

  it.skipIf(process.platform === 'win32')('rejects a symbolic token file', () => {
    const directory = temporaryDirectory()
    const target = join(directory, 'target')
    const tokenFile = join(directory, 'api-token')
    writeFileSync(target, token, { mode: 0o600 })
    symlinkSync(target, tokenFile)
    process.env.JOY_API_TOKEN_FILE = tokenFile
    delete process.env.JOY_API_TOKEN

    expect(() => readApiToken('serve')).toThrow(/must not be a symbolic link/)
  })

  it('does not inject tokens into production builds or Vite preview', () => {
    process.env.JOY_API_TOKEN = 'not a valid token'

    expect(readApiToken('build')).toBe('')
    expect(readApiToken('serve', true)).toBe('')
  })

  it('rejects missing or malformed development tokens with actionable errors', () => {
    const home = temporaryDirectory()
    process.env.JOY_HOME = home
    delete process.env.JOY_API_TOKEN
    delete process.env.JOY_API_TOKEN_FILE
    expect(() => readApiToken('serve')).toThrow(/API token is required/)

    process.env.JOY_API_TOKEN = 'bad token'
    expect(() => readApiToken('serve')).toThrow(/at least 16 URL-safe characters/)
  })
})
