import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { browserCommand, handoffPage, openJoy, signedInUrl } from './open-joy.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('pnpm joy open', () => {
  it('puts the token in the fragment, which never reaches a server', () => {
    expect(signedInUrl(4317, 'abc-DEF_123')).toBe('http://127.0.0.1:4317/#token=abc-DEF_123')
  })

  it('writes a page that goes on to Joy without leaving a script-breaking string in it', () => {
    const page = handoffPage('http://127.0.0.1:1/#token=x</script><b>')
    expect(page).toContain('location.replace("http://127.0.0.1:1/#token=x\\u003c/script>\\u003cb>")')
    expect(page).toContain('no-referrer')
  })

  it('opens the default browser without a shell on every platform', () => {
    expect(browserCommand('darwin', '/p.html')).toEqual({ command: 'open', args: ['/p.html'] })
    expect(browserCommand('win32', 'C:\\p.html')).toEqual({
      command: 'rundll32',
      args: ['url.dll,FileProtocolHandler', 'C:\\p.html'],
    })
    expect(browserCommand('linux', '/p.html')).toEqual({ command: 'xdg-open', args: ['/p.html'] })
  })

  it('hands the token over through an owner-only page and removes it afterwards', async () => {
    const home = mkdtempSync(join(tmpdir(), 'joy-open-'))
    dirs.push(home)
    const launched: string[][] = []
    let seen = ''
    await openJoy(home, 4317, {
      readToken: async () => 'a'.repeat(43),
      platform: 'linux',
      launch: async (command, args) => {
        launched.push([command, ...args])
        const page = args[0] as string
        seen = readFileSync(page, 'utf8')
        if (process.platform !== 'win32') expect(statSync(page).mode & 0o777).toBe(0o600)
      },
      wait: async () => undefined,
    })
    expect(launched).toHaveLength(1)
    expect(launched[0]?.[0]).toBe('xdg-open')
    // The token is in the page, never in the command line.
    expect(launched[0]?.join(' ')).not.toContain('a'.repeat(43))
    expect(seen).toContain(`#token=${'a'.repeat(43)}`)
    expect(existsSync(launched[0]?.[1] as string)).toBe(false)
    expect(readdirSync(home)).toEqual([])
  })

  it('removes the page even when the browser could not start', async () => {
    const home = mkdtempSync(join(tmpdir(), 'joy-open-'))
    dirs.push(home)
    await expect(
      openJoy(home, 4317, {
        readToken: async () => 'b'.repeat(43),
        platform: 'darwin',
        launch: async () => {
          throw new Error('no browser')
        },
        wait: async () => undefined,
      }),
    ).rejects.toThrow('no browser')
    expect(readdirSync(home)).toEqual([])
  })
})
