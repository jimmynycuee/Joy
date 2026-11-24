// The owner's comments on lines of a task's diff, sent to the agent together as one message.
import type { NumberedDiffLine } from './diff.js'

export interface DiffCommentTarget {
  path: string
  /** `old` for a removed line (numbered in the old file), `new` for added and unchanged lines. */
  side: 'old' | 'new'
  line: number
}

export interface DiffComment extends DiffCommentTarget {
  id: string
  /** The diff line as shown, so the agent sees what the comment is about even if the file moves on. */
  code: string
  text: string
}

/** Where a comment on this line points; undefined for headers and hunk lines. */
export function commentTarget(path: string, line: NumberedDiffLine): DiffCommentTarget | undefined {
  if (line.kind === 'removed' && line.oldLine !== undefined) return { path, side: 'old', line: line.oldLine }
  if (line.newLine !== undefined) return { path, side: 'new', line: line.newLine }
  return undefined
}

export function sameTarget(a: DiffCommentTarget, b: DiffCommentTarget): boolean {
  return a.path === b.path && a.side === b.side && a.line === b.line
}

/** The message the agent gets: every comment with its file, line and the line itself, in file order. */
export function diffCommentsMessage(comments: readonly DiffComment[]): string {
  const sorted = [...comments].sort(
    (a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.side.localeCompare(b.side),
  )
  return [
    `我在變更上留了 ${sorted.length} 則意見，請逐一處理：`,
    ...sorted.map((comment) =>
      [
        '',
        `${comment.path} ${comment.side === 'old' ? `舊版第 ${comment.line} 行（已刪除）` : `第 ${comment.line} 行`}`,
        `> ${comment.code}`,
        comment.text.trim(),
      ].join('\n'),
    ),
  ].join('\n')
}

/** Comments saved in this browser; anything malformed is dropped. */
export function parseStoredComments(raw: string | null): DiffComment[] {
  if (!raw) return []
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(value)) return []
  return value.flatMap((item): DiffComment[] => {
    if (typeof item !== 'object' || item === null) return []
    const c = item as Record<string, unknown>
    if (
      typeof c.id !== 'string' ||
      typeof c.path !== 'string' ||
      (c.side !== 'old' && c.side !== 'new') ||
      typeof c.line !== 'number' ||
      !Number.isInteger(c.line) ||
      typeof c.code !== 'string' ||
      typeof c.text !== 'string' ||
      !c.text.trim()
    )
      return []
    return [{ id: c.id, path: c.path, side: c.side, line: c.line, code: c.code, text: c.text }]
  })
}
