import { REPO_COLORS as STORED_COLORS } from '@joy/db'
import { describe, expect, it } from 'vitest'
import { REPO_COLORS, repoColor } from './repo-colors.js'
import type { Repo } from './types.js'

const repoAt = (id: string, extra: Partial<Repo> = {}): Repo => ({
  id,
  path: `/work/${id}`,
  defaultBranch: 'main',
  ...extra,
})

describe('project colours', () => {
  it('are the six muted colours, in the order the owner approved', () => {
    expect(REPO_COLORS.map((color) => color.hex)).toEqual([
      '#7C93B5',
      '#7FA58E',
      '#9A8BB8',
      '#C39A74',
      '#BE8E9E',
      '#6FA6A8',
    ])
    expect(REPO_COLORS.map((color) => color.label)).toEqual(['灰藍', '灰綠', '灰紫', '灰橘', '灰粉', '灰青'])
  })

  it('use the same ids the database accepts', () => {
    expect(REPO_COLORS.map((color) => color.id)).toEqual([...STORED_COLORS])
  })

  it('go round by the project’s place in the list, so a project keeps its colour', () => {
    const repos = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((id) => repoAt(id))
    const hexes = repos.map((repo) => repoColor(repo.id, repos)?.hex)
    expect(hexes.slice(0, 6)).toEqual(REPO_COLORS.map((color) => color.hex))
    expect(hexes[6]).toBe(hexes[0])
    expect(hexes[7]).toBe(hexes[1])
    // Adding a project later never recolours the ones before it.
    const more = [...repos, repoAt('i')]
    expect(repos.map((repo) => repoColor(repo.id, more)?.hex)).toEqual(hexes)
  })

  it('prefer the colour the owner picked, and leave the others where they were', () => {
    const repos = [repoAt('a'), repoAt('b', { color: 'teal' }), repoAt('c')]
    expect(repoColor('b', repos)?.id).toBe('teal')
    expect(repoColor('a', repos)?.id).toBe('blue')
    expect(repoColor('c', repos)?.id).toBe('purple')
  })

  it('ignores a colour this build does not know and falls back to the automatic one', () => {
    const repos = [repoAt('a', { color: 'chartreuse' as never })]
    expect(repoColor('a', repos)?.id).toBe('blue')
  })

  it('has none for a project that is not in the list', () => {
    expect(repoColor('missing', [repoAt('a')])).toBeUndefined()
    expect(repoColor(undefined, [repoAt('a')])).toBeUndefined()
    expect(repoColor('a', [])).toBeUndefined()
  })
})
