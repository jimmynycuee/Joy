import { describe, expect, it } from 'vitest'
import { CodexAppServerParser } from './app-server-parse.js'
import { CodexStreamParser } from './parse.js'

const WARNING =
  'Codex is ignoring 1 unrecognized configuration setting. Check for typos or deprecated settings. user (/home/me/.codex/config.toml): `features.goal` is ignored.'

describe('codex config warnings', () => {
  it('exec: reports the warning once per run as a status, not an error', () => {
    const parser = new CodexStreamParser({ cwd: '/work' })
    const events = [
      ...parser.push({ type: 'error', message: WARNING }),
      ...parser.push({ type: 'item.completed', item: { id: 'i1', type: 'error', message: WARNING } }),
      ...parser.push({ type: 'error', message: WARNING }),
    ]
    expect(events).toEqual([{ type: 'status', text: WARNING }])
  })

  it('exec: other errors are still recoverable errors', () => {
    const parser = new CodexStreamParser({ cwd: '/work' })
    expect(parser.push({ type: 'error', message: 'Reconnecting... 2/5' })).toEqual([
      { type: 'error', message: 'Reconnecting... 2/5', recoverable: true },
    ])
  })

  it('app-server: reports the warning once per run as a status', () => {
    const parser = new CodexAppServerParser({ cwd: '/work', structured: false })
    const events = [
      ...parser.notification('configWarning', { summary: WARNING }),
      ...parser.notification('warning', { message: WARNING }),
      ...parser.notification('error', { error: { message: WARNING } }),
    ]
    expect(events).toEqual([{ type: 'status', text: WARNING }])
  })
})
