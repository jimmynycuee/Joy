import { useMemo, useState } from 'react'
import { buildFileTree, classifyDiffLine, diffTotals, splitDiff } from '../diff.js'
import type { FileTreeNode } from '../diff.js'
import type { DiffFile, WorkspaceDiff } from '../types.js'
import { Icon } from './ui.js'

/** A unified diff with added, removed, hunk and header lines coloured. */
export function DiffCode({
  patch,
  className,
  testId,
  label,
}: {
  patch: string
  className?: string
  testId?: string
  label?: string
}) {
  return (
    <pre
      className={`diff-code${className ? ` ${className}` : ''}`}
      {...(testId ? { 'data-testid': testId } : {})}
      {...(label ? { 'aria-label': label } : {})}
    >
      {patch.split('\n').map((line, index) => (
        <span className={`diff-line ${classifyDiffLine(line)}`} key={`${index}-${line}`}>
          {line || ' '}
        </span>
      ))}
    </pre>
  )
}

export function DiffStat({ additions, deletions }: { additions: number; deletions: number }) {
  if (additions === 0 && deletions === 0) return null
  return (
    <span className="diff-stat">
      <span className="additions">+{additions}</span> <span className="deletions">−{deletions}</span>
    </span>
  )
}

function TreeNode({
  node,
  depth,
  active,
  onSelect,
}: {
  node: FileTreeNode
  depth: number
  active: string
  onSelect: (path: string) => void
}) {
  const [open, setOpen] = useState(true)
  const indent = { paddingLeft: `${8 + depth * 14}px` }
  if (node.file) {
    return (
      <button
        type="button"
        className={`tree-row tree-file${active === node.file.path ? ' active' : ''}`}
        style={indent}
        title={node.file.path}
        onClick={() => onSelect(node.file?.path ?? '')}
      >
        <Icon name="file" size={14} />
        <span className="tree-name">{node.name}</span>
        <DiffStat additions={node.file.additions} deletions={node.file.deletions} />
      </button>
    )
  }
  return (
    <>
      <button
        type="button"
        className="tree-row tree-dir"
        style={indent}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} />
        <span className="tree-name">{node.name}</span>
      </button>
      {open
        ? node.children.map((child) => (
            <TreeNode
              key={child.path + child.name}
              node={child}
              depth={depth + 1}
              active={active}
              onSelect={onSelect}
            />
          ))
        : null}
    </>
  )
}

/** The changed files grouped by directory, above the patch of the selected file. */
export function DiffBrowser({ diff }: { diff: WorkspaceDiff }) {
  const [selected, setSelected] = useState('')
  const chunks = useMemo(() => splitDiff(diff.patch), [diff.patch])
  const tree = useMemo(() => buildFileTree(diff.files), [diff.files])
  const files: DiffFile[] = diff.files
  const active = chunks.has(selected) ? selected : (files[0]?.path ?? '')
  const patch = chunks.get(active) ?? chunks.values().next().value ?? ''
  const totals = diffTotals(files)
  return (
    <>
      <div className="diff-summary">
        <span>{files.length} 個檔案</span>
        <DiffStat {...totals} />
      </div>
      <div className="file-tree" role="group" aria-label="變更的檔案">
        {tree.map((node) => (
          <TreeNode
            key={node.path + node.name}
            node={node}
            depth={0}
            active={active}
            onSelect={setSelected}
          />
        ))}
      </div>
      <DiffCode patch={String(patch)} testId="diff-patch" />
    </>
  )
}
