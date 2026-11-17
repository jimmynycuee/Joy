import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { discoverSkills, parseFrontmatter, skillInstruction } from './skills.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'joy-skills-test-'))
  dirs.push(dir)
  return dir
}
function write(path: string, text: string) {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}
const skill = (name: string, description: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\nBODY THAT MUST NOT BE READ ${name}\n`

describe('parseFrontmatter', () => {
  it('reads plain, quoted and block values and ignores the rest', () => {
    expect(parseFrontmatter(skill('a', 'Plain text: with a colon # comment'))).toEqual({
      name: 'a',
      description: 'Plain text: with a colon',
    })
    expect(parseFrontmatter(`---\nname: "q-1"\ndescription: 'It''s'\nlicense: MIT\n---\n`)).toEqual({
      name: 'q-1',
      description: "It's",
    })
    expect(
      parseFrontmatter('---\nname: b # trailing\ndescription: >\n  one\n  two\n\nother: x\n---'),
    ).toEqual({
      name: 'b',
      description: 'one two',
    })
    expect(parseFrontmatter('---\ndescription: |\n  line 1\n  line 2\n---')).toEqual({
      description: 'line 1 line 2',
    })
    expect(parseFrontmatter('no frontmatter\nname: x')).toEqual({})
    expect(parseFrontmatter('---\nname: unterminated\n')).toEqual({})
  })
})

describe('discoverSkills', () => {
  it('finds user and project skills for each CLI, plus Claude commands, by frontmatter only', async () => {
    const home = temp()
    const project = temp()
    write(join(home, '.claude', 'skills', 'review', 'SKILL.md'), skill('review', 'Review the diff'))
    write(
      join(home, '.claude', 'skills', 'dirname-only', 'SKILL.md'),
      '---\ndescription: Uses the folder\n---\n',
    )
    write(join(home, '.claude', 'skills', 'no-skill-file', 'README.md'), 'x')
    write(join(home, '.claude', 'skills', '.hidden', 'SKILL.md'), skill('hidden', 'h'))
    write(join(home, '.claude', 'commands', 'ship.md'), '---\ndescription: Ship it\n---\nBody')
    write(join(home, '.claude', 'commands', 'group', 'nested.md'), 'No frontmatter at all')
    write(join(project, '.claude', 'skills', 'local', 'SKILL.md'), skill('local', 'Project skill'))
    write(join(project, '.claude', 'skills', 'review', 'SKILL.md'), skill('review', 'Duplicate name'))
    write(join(project, '.agents', 'skills', 'deploy', 'SKILL.md'), skill('deploy', 'Codex project'))
    write(join(home, '.agents', 'skills', 'review', 'SKILL.md'), skill('review', 'Codex review'))
    write(join(home, '.codex', 'skills', 'legacy', 'SKILL.md'), skill('legacy', 'Old Codex folder'))
    write(join(home, '.codex', 'prompts', 'tui-only.md'), '---\ndescription: TUI prompt\n---\n')
    write(join(home, '.claude', 'skills', 'bad', 'SKILL.md'), skill('has space', 'invalid name'))

    const found = await discoverSkills({ userHome: home, projectDir: project, env: {} })
    const summary = found.map((s) => [s.cli, s.scope, s.kind, s.name, s.description ?? null])
    expect(summary).toEqual([
      ['claude-cli', 'user', 'skill', 'dirname-only', 'Uses the folder'],
      ['claude-cli', 'user', 'skill', 'review', 'Review the diff'],
      ['claude-cli', 'project', 'skill', 'local', 'Project skill'],
      ['claude-cli', 'user', 'command', 'nested', null],
      ['claude-cli', 'user', 'command', 'ship', 'Ship it'],
      ['codex-cli', 'project', 'skill', 'deploy', 'Codex project'],
      ['codex-cli', 'user', 'skill', 'review', 'Codex review'],
      ['codex-cli', 'user', 'skill', 'legacy', 'Old Codex folder'],
    ])
    expect(JSON.stringify(found)).not.toContain('BODY THAT MUST NOT BE READ')
    expect(found.find((s) => s.name === 'deploy')?.path).toBe(
      join(project, '.agents', 'skills', 'deploy', 'SKILL.md'),
    )
  })

  it('follows CLAUDE_CONFIG_DIR and CODEX_HOME, follows a linked skill, and is empty when nothing exists', async () => {
    const home = temp()
    const elsewhere = temp()
    write(join(elsewhere, 'claude', 'skills', 'moved', 'SKILL.md'), skill('moved', 'm'))
    write(join(elsewhere, 'codex', 'skills', 'moved-codex', 'SKILL.md'), skill('moved-codex', 'c'))
    write(join(elsewhere, 'linked-src', 'SKILL.md'), skill('linked', 'l'))
    mkdirSync(join(home, '.agents', 'skills'), { recursive: true })
    symlinkSync(join(elsewhere, 'linked-src'), join(home, '.agents', 'skills', 'linked'), 'junction')
    const found = await discoverSkills({
      userHome: home,
      env: { CLAUDE_CONFIG_DIR: join(elsewhere, 'claude'), CODEX_HOME: join(elsewhere, 'codex') },
    })
    expect(found.map((s) => s.name)).toEqual(['moved', 'linked', 'moved-codex'])
    expect(await discoverSkills({ userHome: temp(), env: {} })).toEqual([])
  })
})

describe('skillInstruction', () => {
  it('names the way each CLI loads a skill', () => {
    expect(
      skillInstruction({ name: 'review', cli: 'claude-cli', kind: 'skill', path: '/x/SKILL.md' }),
    ).toMatch(/"review" skill .*Skill tool/)
    expect(
      skillInstruction({ name: 'ship', cli: 'claude-cli', kind: 'command', path: '/x/ship.md' }),
    ).toMatch(/\/ship command/)
    expect(skillInstruction({ name: 'deploy', cli: 'codex-cli', kind: 'skill', path: '/p/SKILL.md' })).toBe(
      'The owner invoked the $deploy skill for this message: follow its instructions in /p/SKILL.md.',
    )
  })
})
