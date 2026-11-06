// Project memory (T3.5): Joy proposes a note for a repository's AGENTS.md and the owner confirms it as a diff.
// Nothing is written to a repository until the owner applies the proposal, and an apply never overwrites a change
// someone else made to the file after the proposal was drawn up. Owner review required: these rules decide what
// Joy writes into your repositories.
import { createHash, randomUUID } from 'node:crypto'
import { link, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { Redactor } from '@joy/secrets'
import { isSensitive } from './index.js'

export const PROJECT_FILE = 'AGENTS.md'
export const NOTES_HEADING = '## Notes from Joy'
export const MAX_NOTE_LENGTH = 300

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * Turns a proposed note into a single safe Markdown bullet. Throws when it must not be written: empty, too long, or
 * sensitive. Line breaks and leading Markdown are flattened so a note cannot add headings or rewrite other sections.
 */
export function cleanNote(note: string, redactor: Redactor): string {
  const flat = note
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[#>*\-+\s]+/, '')
  if (!flat) throw new Error('The note is empty')
  if (flat.length > MAX_NOTE_LENGTH)
    throw new Error(`Keep a project note under ${MAX_NOTE_LENGTH} characters`)
  if (isSensitive(flat, redactor))
    throw new Error('Project notes must not contain secrets or personal details')
  return flat
}

/** The file with the note added as a bullet at the end of the "Notes from Joy" section (created when missing). */
export function addProjectNote(current: string | null, note: string): string {
  const bullet = `- ${note}`
  const text = current ?? ''
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.length ? text.split(/\r?\n/) : []
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  const start = lines.findIndex((line) => line.trim() === NOTES_HEADING)
  if (start === -1) {
    const prefix = lines.length ? [...lines, ''] : []
    return [...prefix, NOTES_HEADING, '', bullet, ''].join(eol)
  }
  let end = lines.findIndex((line, index) => index > start && /^#{1,2} /.test(line))
  if (end === -1) end = lines.length
  // Insert after the section's last non-blank line.
  let at = end
  while (at > start + 1 && lines[at - 1]?.trim() === '') at--
  const next = [...lines.slice(0, at), ...(at === start + 1 ? [''] : []), bullet, ...lines.slice(at)]
  return [...next, ''].join(eol)
}

export interface DiffLine {
  kind: 'same' | 'add' | 'remove'
  text: string
}

/** A line diff (longest common subsequence), enough to show the owner exactly what will change. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before ? before.split(/\r?\n/) : []
  const b = after ? after.split(/\r?\n/) : []
  const width = b.length + 1
  // lcs[i * width + j] = length of the longest common subsequence of a[i..] and b[j..].
  const lcs = new Uint32Array((a.length + 1) * width)
  const at = (i: number, j: number) => lcs[i * width + j] ?? 0
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      lcs[i * width + j] = a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1))
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    const left = a[i]
    const right = b[j]
    if (left !== undefined && right !== undefined && left === right) {
      out.push({ kind: 'same', text: left })
      i++
      j++
    } else if (left !== undefined && (right === undefined || at(i + 1, j) >= at(i, j + 1))) {
      out.push({ kind: 'remove', text: left })
      i++
    } else if (right !== undefined) {
      out.push({ kind: 'add', text: right })
      j++
    }
  }
  return out
}

export async function readProjectFile(repoPath: string): Promise<string | null> {
  try {
    return await readFile(join(repoPath, PROJECT_FILE), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export type ApplyOutcome = { ok: true } | { ok: false; reason: 'conflict'; message: string }

/**
 * Writes `content` to the repository's AGENTS.md only if the file is still exactly what the proposal was based on
 * (`baseHash`, or null when the file did not exist).
 *
 * The old file is first moved aside with an atomic rename, then checked: an edit that landed before the move is
 * detected there and the file is put back untouched. The new file is then linked into place, which fails instead of
 * replacing a file someone created in the meantime. Either way a concurrent edit is reported as a conflict, never
 * overwritten.
 */
export async function applyProjectFile(
  repoPath: string,
  baseHash: string | null,
  content: string,
  /** Runs between the first check and the swap (tests use it to edit the file at the worst moment). */
  hooks: { afterCheck?: () => Promise<void> } = {},
): Promise<ApplyOutcome> {
  const target = join(repoPath, PROJECT_FILE)
  const conflict: ApplyOutcome = {
    ok: false,
    reason: 'conflict',
    message: `${PROJECT_FILE} changed after Joy proposed this note. Nothing was written; ask Joy to propose it again.`,
  }
  const tag = randomUUID()
  const staged = join(dirname(target), `.${basename(target)}.joy-${tag}.new`)
  const aside = join(dirname(target), `.${basename(target)}.joy-${tag}.old`)
  await writeFile(staged, content, { flag: 'wx' })
  try {
    if (baseHash === null) {
      if ((await readProjectFile(repoPath)) !== null) return conflict
      await hooks.afterCheck?.()
    } else {
      const before = await readProjectFile(repoPath)
      if (before === null || sha256(before) !== baseHash) return conflict
      await hooks.afterCheck?.()
      try {
        await rename(target, aside)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return conflict
        throw error
      }
      const moved = await readFile(aside, 'utf8')
      if (sha256(moved) !== baseHash) {
        await restore(aside, target)
        return conflict
      }
    }
    try {
      await link(staged, target)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        if (baseHash !== null) await restore(aside, target)
        throw error
      }
      // Someone created the file while ours was being swapped in: keep theirs. The old copy stays next to it so
      // nothing is lost.
      return conflict
    }
    if (baseHash !== null) await rm(aside, { force: true })
    return { ok: true }
  } finally {
    await rm(staged, { force: true })
  }
}

/** Puts the moved-aside file back unless something now exists at the target; then the copy is left for the owner. */
async function restore(aside: string, target: string): Promise<void> {
  try {
    await link(aside, target)
    await rm(aside, { force: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
}
