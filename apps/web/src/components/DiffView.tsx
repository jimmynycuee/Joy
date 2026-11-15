import { useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  buildFileTree,
  classifyDiffLine,
  diffTotals,
  FILE_PAGE_LINES,
  formatSize,
  planDiff,
} from '../diff.js'
import type { DiffFileView, FileTreeNode } from '../diff.js'
import type { WorkspaceDiff } from '../types.js'
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

/** One file's diff: a header that folds it, and its lines drawn a page at a time. */
function DiffFileSection({
  view,
  open,
  active,
  onToggle,
  sectionRef,
}: {
  view: DiffFileView
  open: boolean
  active: boolean
  onToggle: () => void
  sectionRef: (element: HTMLElement | null) => void
}) {
  const [shown, setShown] = useState(FILE_PAGE_LINES)
  const { file, lines } = view
  const rest = lines.length - shown
  return (
    <section className={`diff-file${active ? ' active' : ''}`} ref={sectionRef} aria-label={file.path}>
      <button type="button" className="diff-file-header" aria-expanded={open} onClick={onToggle}>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} />
        <span className="diff-file-path" title={file.path}>
          {file.oldPath && file.oldPath !== file.path ? `${file.oldPath} → ${file.path}` : file.path}
        </span>
        <DiffStat additions={file.additions} deletions={file.deletions} />
      </button>
      {open && lines.length > 0 ? (
        <pre className="diff-code diff-file-code">
          {lines.slice(0, shown).map((line, index) => (
            <span className={`diff-line ${classifyDiffLine(line)}`} key={index}>
              {line || ' '}
            </span>
          ))}
        </pre>
      ) : null}
      {open && rest > 0 ? (
        <button
          type="button"
          className="diff-more"
          onClick={() => setShown((current) => current + FILE_PAGE_LINES * 4)}
        >
          顯示其餘 {rest} 行
        </button>
      ) : null}
    </section>
  )
}

/** The changed files grouped by directory, then every file's diff, each one foldable. */
export function DiffBrowser({ diff, actions }: { diff: WorkspaceDiff; actions?: ReactNode }) {
  const plan = useMemo(() => planDiff(diff), [diff])
  const tree = useMemo(() => buildFileTree(diff.files), [diff.files])
  // The owner's own folding wins over the default; it survives new events re-planning the same files.
  const [toggled, setToggled] = useState<Map<string, boolean>>(() => new Map())
  const [active, setActive] = useState('')
  const sections = useRef(new Map<string, HTMLElement>())
  const totals = diffTotals(diff.files)
  const isOpen = (view: DiffFileView) => !plan.tooLarge && (toggled.get(view.file.path) ?? view.open)
  const setOpen = (path: string, open: boolean) => setToggled((current) => new Map(current).set(path, open))
  const allOpen = plan.files.every((view) => view.lines.length === 0 || isOpen(view))

  function select(path: string) {
    setActive(path)
    if (!plan.tooLarge) setOpen(path, true)
    sections.current.get(path)?.scrollIntoView?.({ block: 'start', behavior: 'smooth' })
  }

  return (
    <>
      {actions}
      <div className="diff-summary">
        <span>{diff.files.length} 個檔案</span>
        <DiffStat {...totals} />
        {plan.tooLarge ? null : (
          <button
            type="button"
            className="diff-fold-all"
            onClick={() => setToggled(new Map(plan.files.map((view) => [view.file.path, !allOpen] as const)))}
          >
            {allOpen ? '全部收合' : '全部展開'}
          </button>
        )}
      </div>
      {plan.tooLarge ? (
        <p className="notice-line" role="status">
          diff 太大（{formatSize(diff.patch.length)}），只列出檔案
        </p>
      ) : null}
      <div className="file-tree" role="group" aria-label="變更的檔案">
        {tree.map((node) => (
          <TreeNode key={node.path + node.name} node={node} depth={0} active={active} onSelect={select} />
        ))}
      </div>
      {plan.tooLarge ? null : (
        <div className="diff-files" data-testid="diff-patch">
          {plan.files.map((view) => (
            <DiffFileSection
              key={view.file.path}
              view={view}
              open={isOpen(view)}
              active={active === view.file.path}
              onToggle={() => setOpen(view.file.path, !isOpen(view))}
              sectionRef={(element) => {
                if (element) sections.current.set(view.file.path, element)
                else sections.current.delete(view.file.path)
              }}
            />
          ))}
        </div>
      )}
    </>
  )
}
