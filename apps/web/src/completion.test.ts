import { describe, expect, it } from 'vitest'
import type { SkillItem } from './completion.js'
import { applyCompletion, findTrigger, mentionItems, removeTrigger, slashItems } from './completion.js'

describe('findTrigger', () => {
  it('opens / only at the start of the message, while the caret is in its first word', () => {
    expect(findTrigger('/', 1)).toEqual({ kind: '/', start: 0, end: 1, query: '' })
    expect(findTrigger('/rev', 4)).toEqual({ kind: '/', start: 0, end: 4, query: 'rev' })
    expect(findTrigger('/rev more', 3)).toEqual({ kind: '/', start: 0, end: 4, query: 're' })
    expect(findTrigger('/review now', 11)).toBeUndefined()
    expect(findTrigger('see /rev', 8)).toBeUndefined()
    expect(findTrigger('/', 0)).toBeUndefined()
  })

  it('opens @ at the start or after a space, not inside a word like an email address', () => {
    expect(findTrigger('@', 1)).toEqual({ kind: '@', start: 0, end: 1, query: '' })
    expect(findTrigger('look at @src/lo', 15)).toEqual({ kind: '@', start: 8, end: 15, query: 'src/lo' })
    expect(findTrigger('mail me@host', 12)).toBeUndefined()
    expect(findTrigger('@a b', 4)).toBeUndefined()
    expect(findTrigger('/x @fi', 6)).toEqual({ kind: '@', start: 3, end: 6, query: 'fi' })
  })
})

describe('applyCompletion and removeTrigger', () => {
  it('replaces the typed word and leaves one space after it', () => {
    const at = findTrigger('read @sr then', 8)
    expect(at && applyCompletion('read @sr then', at, 'src/a.ts')).toEqual({
      value: 'read src/a.ts then',
      caret: 14,
    })
    const slash = findTrigger('/re', 3)
    expect(slash && applyCompletion('/re', slash, '/review')).toEqual({ value: '/review ', caret: 8 })
    expect(slash && removeTrigger('/re', slash)).toBe('')
    const command = findTrigger('/se rest', 3)
    expect(command && removeTrigger('/se rest', command)).toBe('rest')
  })
})

const skills: SkillItem[] = [
  { name: 'review', description: 'Review the diff', cli: 'claude-cli', scope: 'user', kind: 'skill' },
  { name: 'release', cli: 'codex-cli', scope: 'project', kind: 'skill' },
  { name: 'preview', cli: 'claude-cli', scope: 'project', kind: 'command' },
]
const commands = [{ name: 'settings', label: '設定', run: () => {} }]

describe('slashItems', () => {
  it("lists only the implementer CLI's skills, best match first, then Joy's commands", () => {
    expect(slashItems('re', skills, commands, 'claude-cli').map((i) => i.label)).toEqual([
      '/review',
      '/preview',
    ])
    expect(slashItems('', skills, commands, 'codex-cli').map((i) => i.label)).toEqual([
      '/release',
      '/settings',
    ])
    expect(slashItems('set', skills, commands, 'claude-cli').map((i) => i.type)).toEqual(['command'])
  })

  it('names the CLI of each skill when the implementer is not a CLI', () => {
    const items = slashItems('re', skills, [], 'openai-api')
    expect(items.map((i) => (i.type === 'skill' ? `${i.label}:${i.tag}` : i.label))).toEqual([
      '/release:Codex',
      '/review:Claude',
      '/preview:Claude',
    ])
  })

  it('is empty when nothing matches or nothing exists', () => {
    expect(slashItems('zzz', skills, commands, 'claude-cli')).toEqual([])
    expect(slashItems('', [], [], undefined)).toEqual([])
  })
})

describe('mentionItems', () => {
  const servers = [
    { id: '1', name: 'files', enabled: true },
    { id: '2', name: 'off', enabled: false },
    { id: '3', name: 'fixtures', enabled: true, repoIds: ['r2'] },
  ]
  it("lists the project's enabled MCP servers, then files", () => {
    expect(mentionItems('fi', ['src/file.ts'], servers, 'r1').map((i) => i.label)).toEqual([
      '@files',
      'src/file.ts',
    ])
    expect(mentionItems('fi', [], servers, 'r2').map((i) => i.label)).toEqual(['@files', '@fixtures'])
    expect(mentionItems('', [], [], undefined)).toEqual([])
  })
})
