import { describe, expect, it } from 'vitest'
import {
  buildFileTree,
  classifyDiffLine,
  diffTotals,
  formatSize,
  LONG_FILE_LINES,
  MAX_DIFF_CHARS,
  OPEN_BUDGET_LINES,
  planDiff,
  withoutFileHeader,
  splitDiff,
} from './diff.js'
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

const chunk = (path: string, lines: number) =>
  [
    `diff --git a/${path} b/${path}`,
    '@@ -1 +1 @@',
    ...Array.from({ length: lines }, (_, i) => `+line ${i}`),
  ].join('\n')

describe('planDiff', () => {
  it('lists every file in the tree order with its own lines, short files open', () => {
    const plan = planDiff({
      files: [file('src/b.ts'), file('README.md'), file('src/a.ts')],
      patch: [chunk('src/b.ts', 2), chunk('README.md', 1), chunk('src/a.ts', 3)].join('\n'),
    })
    expect(plan.tooLarge).toBe(false)
    expect(plan.files.map((view) => view.file.path)).toEqual(['src/a.ts', 'src/b.ts', 'README.md'])
    expect(plan.files.map((view) => view.open)).toEqual([true, true, true])
    expect(plan.files[0]?.lines).toEqual(['@@ -1 +1 @@', '+line 0', '+line 1', '+line 2'])
  })

  it('keeps long files collapsed until opened, and stops opening files once the budget is spent', () => {
    const long = LONG_FILE_LINES + 10
    const medium = LONG_FILE_LINES - 10
    const count = Math.ceil(OPEN_BUDGET_LINES / medium) + 2
    const names = Array.from({ length: count }, (_, i) => `f${String(i).padStart(2, '0')}.ts`)
    const plan = planDiff({
      files: [file('a-lock.json'), ...names.map((name) => file(name))],
      patch: [chunk('a-lock.json', long), ...names.map((name) => chunk(name, medium))].join('\n'),
    })
    expect(plan.files[0]).toMatchObject({ open: false })
    expect(plan.files[0]?.lines.length).toBe(long + 1)
    const open = plan.files.filter((view) => view.open)
    expect(open.length).toBeGreaterThan(0)
    expect(open.reduce((total, view) => total + view.lines.length, 0)).toBeLessThanOrEqual(OPEN_BUDGET_LINES)
    expect(plan.files.at(-1)?.open).toBe(false)
  })

  it('does not draw a diff over the limit, and a file without a patch has no lines', () => {
    const big = planDiff({ files: [file('a.ts')], patch: chunk('a.ts', 1) + 'x'.repeat(MAX_DIFF_CHARS) })
    expect(big.tooLarge).toBe(true)
    expect(big.files).toEqual([{ file: file('a.ts'), lines: [], open: false }])
    expect(planDiff({ files: [file('image.png')], patch: '' }).files[0]).toMatchObject({
      lines: [],
      open: false,
    })
    expect(formatSize(2_400_000)).toBe('2.4 MB')
    expect(formatSize(12_000)).toBe('12 KB')
  })
})

describe('withoutFileHeader', () => {
  it("drops git's header lines before the first hunk and keeps the code", () => {
    expect(
      withoutFileHeader([
        'diff --git a/old.ts b/new.ts',
        'similarity index 90%',
        'rename from old.ts',
        'rename to new.ts',
        'index 1a2b3c..4d5e6f 100644',
        '--- a/old.ts',
        '+++ b/new.ts',
        '@@ -1,2 +1,2 @@',
        '--- a comment that starts with dashes',
        '+++counter',
        ' same',
      ]),
    ).toEqual(['@@ -1,2 +1,2 @@', '--- a comment that starts with dashes', '+++counter', ' same'])
  })

  it('keeps what only the header says: a mode change, a binary file', () => {
    expect(withoutFileHeader(['diff --git a/run.sh b/run.sh', 'old mode 100644', 'new mode 100755'])).toEqual(
      ['old mode 100644', 'new mode 100755'],
    )
    expect(
      withoutFileHeader([
        'diff --git a/logo.png b/logo.png',
        'new file mode 100644',
        'index 0000000..1a2b3c4',
        'Binary files /dev/null and b/logo.png differ',
      ]),
    ).toEqual(['Binary files /dev/null and b/logo.png differ'])
  })
})
