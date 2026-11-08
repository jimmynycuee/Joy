import { describe, expect, it } from 'vitest'
import { buildFileTree, classifyDiffLine, diffTotals, splitDiff } from './diff.js'
import type { DiffFile } from './types.js'

const file = (path: string, additions = 1, deletions = 0): DiffFile => ({
  path,
  status: 'modified',
  additions,
  deletions,
})

describe('classifyDiffLine', () => {
  it('colours added, removed, hunk and metadata lines', () => {
    expect(classifyDiffLine('+const a = 1')).toBe('added')
    expect(classifyDiffLine('-const a = 0')).toBe('removed')
    expect(classifyDiffLine('@@ -1 +1 @@')).toBe('hunk')
    expect(classifyDiffLine('--- a/src/a.ts')).toBe('meta')
    expect(classifyDiffLine('+++ b/src/a.ts')).toBe('meta')
    expect(classifyDiffLine('diff --git a/x b/x')).toBe('meta')
    expect(classifyDiffLine('index 0f0..a1b 100644')).toBe('meta')
    expect(classifyDiffLine(' unchanged')).toBe('context')
    expect(classifyDiffLine('')).toBe('context')
  })
})

describe('splitDiff', () => {
  it('splits a patch into one chunk per file', () => {
    const patch = ['diff --git a/a.ts b/a.ts', '+1', 'diff --git a/dir/b.ts b/dir/b.ts', '-2'].join('\n')
    const chunks = splitDiff(patch)
    expect([...chunks.keys()]).toEqual(['a.ts', 'dir/b.ts'])
    expect(chunks.get('dir/b.ts')).toContain('-2')
    expect(splitDiff('').size).toBe(0)
  })
})

describe('buildFileTree', () => {
  it('groups files by directory, directories first', () => {
    const tree = buildFileTree([file('README.md'), file('src/a.ts'), file('src/b.ts'), file('docs/x.md')])
    expect(tree.map((node) => node.name)).toEqual(['docs', 'src', 'README.md'])
    expect(tree[1]?.children.map((node) => node.name)).toEqual(['a.ts', 'b.ts'])
    expect(tree[2]?.file?.path).toBe('README.md')
  })

  it('merges chains of single-child directories', () => {
    const tree = buildFileTree([file('apps/web/src/a.ts'), file('apps/web/src/b.ts')])
    expect(tree).toHaveLength(1)
    expect(tree[0]?.name).toBe('apps/web/src')
    expect(tree[0]?.children.map((node) => node.name)).toEqual(['a.ts', 'b.ts'])
  })

  it('keeps branching directories separate', () => {
    const tree = buildFileTree([file('apps/web/a.ts'), file('apps/server/b.ts')])
    expect(tree[0]?.name).toBe('apps')
    expect(tree[0]?.children.map((node) => node.name)).toEqual(['server', 'web'])
  })

  it('handles an empty list', () => {
    expect(buildFileTree([])).toEqual([])
  })
})

describe('diffTotals', () => {
  it('sums additions and deletions', () => {
    expect(diffTotals([file('a', 3, 1), file('b', 2, 4)])).toEqual({ additions: 5, deletions: 5 })
    expect(diffTotals([])).toEqual({ additions: 0, deletions: 0 })
  })
})
