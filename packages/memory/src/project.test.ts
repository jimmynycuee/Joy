import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Redactor } from '@joy/secrets'
import { addProjectNote, applyProjectFile, cleanNote, lineDiff, sha256 } from './project.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function repo(agents?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'joy-project-memory-'))
  dirs.push(dir)
  if (agents !== undefined) writeFileSync(join(dir, 'AGENTS.md'), agents)
  return dir
}

describe('project notes', () => {
  it('flattens a note into one bullet and refuses secrets', () => {
    const redactor = new Redactor()
    expect(cleanNote('## Use pnpm\n\nnot npm', redactor)).toBe('Use pnpm not npm')
    expect(() => cleanNote('   ', redactor)).toThrow(/empty/)
    expect(() => cleanNote('the deploy password is x', redactor)).toThrow(/secrets/)
    expect(() => cleanNote('x'.repeat(301), redactor)).toThrow(/under 300/)
  })

  it('adds notes under one section, creating it and the file when missing', () => {
    expect(addProjectNote(null, 'Use pnpm')).toBe('## Notes from Joy\n\n- Use pnpm\n')
    const once = addProjectNote('# Rules\n\nBe nice.\n', 'Use pnpm')
    expect(once).toBe('# Rules\n\nBe nice.\n\n## Notes from Joy\n\n- Use pnpm\n')
    expect(addProjectNote(once, 'Run pnpm check')).toBe(
      '# Rules\n\nBe nice.\n\n## Notes from Joy\n\n- Use pnpm\n- Run pnpm check\n',
    )
    // A later section stays after the notes.
    expect(addProjectNote('## Notes from Joy\n\n- a\n\n## Tests\n\nx\n', 'b')).toBe(
      '## Notes from Joy\n\n- a\n- b\n\n## Tests\n\nx\n',
    )
    expect(addProjectNote('a\r\nb\r\n', 'c')).toBe('a\r\nb\r\n\r\n## Notes from Joy\r\n\r\n- c\r\n')
  })

  it('shows the change as a line diff', () => {
    expect(lineDiff('a\nb', 'a\nx\nb')).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'add', text: 'x' },
      { kind: 'same', text: 'b' },
    ])
    expect(lineDiff('a', '')).toEqual([{ kind: 'remove', text: 'a' }])
  })
})

describe('applying to the repository', () => {
  it('writes the file when it is unchanged since the proposal', async () => {
    const dir = repo('old\n')
    expect(await applyProjectFile(dir, sha256('old\n'), 'new\n')).toEqual({ ok: true })
    expect(readFileSync(join(dir, 'AGENTS.md'), 'utf8')).toBe('new\n')
    expect(readdirSync(dir)).toEqual(['AGENTS.md'])
  })

  it('creates the file when the proposal was made without one', async () => {
    const dir = repo()
    expect(await applyProjectFile(dir, null, 'new\n')).toEqual({ ok: true })
    expect(readFileSync(join(dir, 'AGENTS.md'), 'utf8')).toBe('new\n')
  })

  it('never overwrites an edit made after the proposal', async () => {
    const dir = repo('edited by the owner\n')
    const outcome = await applyProjectFile(dir, sha256('old\n'), 'new\n')
    expect(outcome).toMatchObject({ ok: false, reason: 'conflict' })
    expect(readFileSync(join(dir, 'AGENTS.md'), 'utf8')).toBe('edited by the owner\n')
    expect(readdirSync(dir)).toEqual(['AGENTS.md'])
  })

  it('catches an editor that saves between the check and the swap', async () => {
    const dir = repo('old\n')
    const outcome = await applyProjectFile(dir, sha256('old\n'), 'new\n', {
      afterCheck: async () => writeFileSync(join(dir, 'AGENTS.md'), 'saved by an editor\n'),
    })
    expect(outcome).toMatchObject({ ok: false, reason: 'conflict' })
    expect(readFileSync(join(dir, 'AGENTS.md'), 'utf8')).toBe('saved by an editor\n')
    expect(readdirSync(dir)).toEqual(['AGENTS.md'])
  })

  it('does not replace a file created between the check and the swap', async () => {
    const dir = repo()
    const outcome = await applyProjectFile(dir, null, 'new\n', {
      afterCheck: async () => writeFileSync(join(dir, 'AGENTS.md'), 'created by an editor\n'),
    })
    expect(outcome).toMatchObject({ ok: false, reason: 'conflict' })
    expect(readFileSync(join(dir, 'AGENTS.md'), 'utf8')).toBe('created by an editor\n')
  })

  it('never replaces a file created after a proposal made without one', async () => {
    const dir = repo('someone wrote this\n')
    expect(await applyProjectFile(dir, null, 'new\n')).toMatchObject({ ok: false })
    expect(readFileSync(join(dir, 'AGENTS.md'), 'utf8')).toBe('someone wrote this\n')
  })

  it('reports a conflict when the file was deleted after the proposal', async () => {
    const dir = repo()
    expect(await applyProjectFile(dir, sha256('old\n'), 'new\n')).toMatchObject({ ok: false })
    expect(readdirSync(dir)).toEqual([])
  })
})
