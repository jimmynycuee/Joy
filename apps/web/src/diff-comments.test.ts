import { describe, expect, it } from 'vitest'
import { numberDiffLines } from './diff.js'
import { commentTarget, diffCommentsMessage, parseStoredComments, sameTarget } from './diff-comments.js'
import type { DiffComment } from './diff-comments.js'

const fileDiff = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1..2 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -3,3 +3,3 @@ function a() {',
  ' keep',
  '-old line',
  '+new line',
  '\\ No newline at end of file',
]

describe('numberDiffLines', () => {
  it('numbers lines from the hunk header, old for removed and new for added', () => {
    const lines = numberDiffLines(fileDiff)
    expect(lines.slice(0, 5).every((line) => line.oldLine === undefined && line.newLine === undefined)).toBe(
      true,
    )
    expect(lines[5]).toMatchObject({ kind: 'context', oldLine: 3, newLine: 3 })
    expect(lines[6]).toMatchObject({ kind: 'removed', oldLine: 4 })
    expect(lines[6]?.newLine).toBeUndefined()
    expect(lines[7]).toMatchObject({ kind: 'added', newLine: 4 })
    expect(lines[7]?.oldLine).toBeUndefined()
    expect(lines[8]?.newLine).toBeUndefined()
  })

  it('restarts at every hunk', () => {
    const lines = numberDiffLines(['@@ -1 +1 @@', '+a', '@@ -10,2 +11,2 @@', ' b'])
    expect(lines[1]?.newLine).toBe(1)
    expect(lines[3]).toMatchObject({ oldLine: 10, newLine: 11 })
  })
})

describe('diff comments', () => {
  const numbered = numberDiffLines(fileDiff)
  const line = (index: number) => {
    const found = numbered[index]
    if (!found) throw new Error(`no line ${index}`)
    return found
  }

  it('targets the new file for added and unchanged lines, the old file for removed ones, nothing for headers', () => {
    expect(commentTarget('src/a.ts', line(0))).toBeUndefined()
    expect(commentTarget('src/a.ts', line(4))).toBeUndefined()
    expect(commentTarget('src/a.ts', line(5))).toEqual({ path: 'src/a.ts', side: 'new', line: 3 })
    expect(commentTarget('src/a.ts', line(6))).toEqual({ path: 'src/a.ts', side: 'old', line: 4 })
    expect(commentTarget('src/a.ts', line(7))).toEqual({ path: 'src/a.ts', side: 'new', line: 4 })
    expect(sameTarget({ path: 'a', side: 'old', line: 4 }, { path: 'a', side: 'new', line: 4 })).toBe(false)
  })

  it('writes one message with every comment in file and line order', () => {
    const comments: DiffComment[] = [
      { id: '1', path: 'src/b.ts', side: 'new', line: 2, code: '+b()', text: 'Rename this' },
      { id: '2', path: 'src/a.ts', side: 'old', line: 4, code: '-old line', text: '  Keep this line  ' },
      { id: '3', path: 'src/a.ts', side: 'new', line: 3, code: ' keep', text: 'Needs a test' },
    ]
    expect(diffCommentsMessage(comments)).toBe(
      [
        '我在變更上留了 3 則意見，請逐一處理：',
        '',
        'src/a.ts 第 3 行',
        '>  keep',
        'Needs a test',
        '',
        'src/a.ts 舊版第 4 行（已刪除）',
        '> -old line',
        'Keep this line',
        '',
        'src/b.ts 第 2 行',
        '> +b()',
        'Rename this',
      ].join('\n'),
    )
  })

  it('keeps only well-formed stored comments', () => {
    const good = { id: '1', path: 'a', side: 'new', line: 1, code: '+x', text: 'ok' }
    expect(
      parseStoredComments(JSON.stringify([good, { ...good, side: 'left' }, { ...good, text: ' ' }, 3])),
    ).toEqual([good])
    expect(parseStoredComments('not json')).toEqual([])
    expect(parseStoredComments(null)).toEqual([])
    expect(parseStoredComments('{}')).toEqual([])
  })
})
