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
