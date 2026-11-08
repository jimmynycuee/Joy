import { describe, expect, it } from 'vitest'
import { formatCheckCommand, parseCheckCommand, shellCharactersIn } from './check-command.js'

describe('parseCheckCommand', () => {
  it('splits on any whitespace', () => {
    expect(parseCheckCommand('pnpm check')).toEqual(['pnpm', 'check'])
    expect(parseCheckCommand('  npm   run\ttest  ')).toEqual(['npm', 'run', 'test'])
  })

  it('treats empty text as no command', () => {
    expect(parseCheckCommand('')).toBeNull()
    expect(parseCheckCommand('   ')).toBeNull()
  })

  it('does not interpret quotes: they stay in the argument', () => {
    expect(parseCheckCommand('echo "a b"')).toEqual(['echo', '"a', 'b"'])
  })
})

describe('formatCheckCommand', () => {
  it('joins argv back into the line the owner types', () => {
    expect(formatCheckCommand(['pnpm', 'check'])).toBe('pnpm check')
    expect(formatCheckCommand(undefined)).toBe('')
  })
})

describe('shellCharactersIn', () => {
  it('finds characters a shell would act on', () => {
    expect(shellCharactersIn('pnpm check && pnpm build')).toBe('&')
    expect(shellCharactersIn('pnpm check')).toBeUndefined()
  })
})
