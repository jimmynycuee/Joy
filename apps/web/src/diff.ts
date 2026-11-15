import type { DiffFile } from './types.js'

/** One chunk per file of a `git diff`, keyed by the file's new path. */
export function splitDiff(patch: string): Map<string, string> {
  const chunks = patch.split(/(?=^diff --git )/m).filter((chunk) => chunk.trim())
  return new Map(
    chunks.map((chunk, index) => {
      const filePath = /^diff --git a\/.+ b\/(.+)$/m.exec(chunk)?.[1] ?? `file-${index + 1}`
      return [filePath, chunk]
    }),
  )
}

export type DiffLineKind = 'added' | 'removed' | 'hunk' | 'meta' | 'context'

/** Colour class of one line of a unified diff. */
export function classifyDiffLine(line: string): DiffLineKind {
  if (line.startsWith('+++') || line.startsWith('---')) return 'meta'
  if (line.startsWith('diff --git') || line.startsWith('index ') || /^(new|deleted) file mode/.test(line))
    return 'meta'
  if (line.startsWith('@@')) return 'hunk'
  if (line.startsWith('+')) return 'added'
  if (line.startsWith('-')) return 'removed'
  return 'context'
}

export interface FileTreeNode {
  name: string
  /** Full path of a directory or file. */
  path: string
  file?: DiffFile
  children: FileTreeNode[]
}

/**
 * Groups changed files by directory. A directory with a single directory child is merged into one row
 * (`src/components`), the way editors show it, so deep trees don't waste indentation.
 */
export function buildFileTree(files: readonly DiffFile[]): FileTreeNode[] {
  const root: FileTreeNode = { name: '', path: '', children: [] }
  for (const file of files) {
    const parts = file.path.split('/').filter(Boolean)
    let node = root
    parts.forEach((part, index) => {
      const path = parts.slice(0, index + 1).join('/')
      const isFile = index === parts.length - 1
      let child = node.children.find(
        (candidate) => candidate.name === part && Boolean(candidate.file) === isFile,
      )
      if (!child) {
        child = { name: part, path, children: [], ...(isFile ? { file } : {}) }
        node.children.push(child)
      }
      node = child
    })
  }
  const compact = (node: FileTreeNode): FileTreeNode => {
    let current = node
    while (!current.file && current.children.length === 1 && !current.children[0]?.file) {
      const only = current.children[0] as FileTreeNode
      current = { name: `${current.name}/${only.name}`, path: only.path, children: only.children }
    }
    return { ...current, children: sortNodes(current.children.map(compact)) }
  }
  return sortNodes(root.children.map(compact))
}

function sortNodes(nodes: FileTreeNode[]): FileTreeNode[] {
  // Directories before files, each alphabetical.
  return [...nodes].sort((a, b) => {
    if (Boolean(a.file) !== Boolean(b.file)) return a.file ? 1 : -1
    return a.name.localeCompare(b.name)
  })
}

export function diffTotals(files: readonly DiffFile[]): { additions: number; deletions: number } {
  return files.reduce(
    (total, file) => ({
      additions: total.additions + file.additions,
      deletions: total.deletions + file.deletions,
    }),
    { additions: 0, deletions: 0 },
  )
}

/** Past this size the patch is not drawn at all, only the file list (the browser would choke on it). */
export const MAX_DIFF_CHARS = 2_000_000
/** A file longer than this starts collapsed, and is only drawn when the owner opens it. */
export const LONG_FILE_LINES = 400
/** Lines drawn when a file opens; the rest comes in pages of this size. */
export const FILE_PAGE_LINES = 500
/** Files open on their own until this many lines are on screen; the rest start collapsed. */
export const OPEN_BUDGET_LINES = 2_000

export interface DiffFileView {
  file: DiffFile
  /** The file's part of the unified diff, split into lines (empty when the patch has none for it). */
  lines: string[]
  /** Open when the pane first shows it. */
  open: boolean
}

/**
 * The files of a diff in display order (the file tree's), each with its lines and whether it starts open. Short files
 * open until the line budget is spent; long files always start collapsed, so a lockfile does not bury the rest.
 */
export function planDiff(diff: { files: readonly DiffFile[]; patch: string }): {
  files: DiffFileView[]
  tooLarge: boolean
} {
  const tooLarge = diff.patch.length > MAX_DIFF_CHARS
  const chunks = tooLarge ? new Map<string, string>() : splitDiff(diff.patch)
  let budget = OPEN_BUDGET_LINES
  const files = flattenTree(buildFileTree(diff.files)).map((file) => {
    const chunk = chunks.get(file.path)
    const lines = chunk ? chunk.replace(/\n$/, '').split('\n') : []
    const open = lines.length > 0 && lines.length <= LONG_FILE_LINES && lines.length <= budget
    if (open) budget -= lines.length
    return { file, lines, open }
  })
  return { files, tooLarge }
}

function flattenTree(nodes: readonly FileTreeNode[]): DiffFile[] {
  return nodes.flatMap((node) => (node.file ? [node.file] : flattenTree(node.children)))
}

/** How big a patch is, for the "too large" notice. */
export function formatSize(chars: number): string {
  return chars >= 1_000_000
    ? `${(chars / 1_000_000).toFixed(1)} MB`
    : `${Math.max(1, Math.round(chars / 1000))} KB`
}
