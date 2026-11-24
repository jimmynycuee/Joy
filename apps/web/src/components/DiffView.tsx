import { useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  buildFileTree,
  classifyDiffLine,
  diffTotals,
  FILE_PAGE_LINES,
  formatSize,
  numberDiffLines,
  planDiff,
} from '../diff.js'
import type { DiffFileView, FileTreeNode } from '../diff.js'
import { commentTarget, sameTarget } from '../diff-comments.js'
import type { DiffComment, DiffCommentTarget } from '../diff-comments.js'
import type { WorkspaceDiff } from '../types.js'
import { Button, Icon, IconButton } from './ui.js'

/** Comments the owner leaves on diff lines; they go to the agent together when sent. */
export interface DiffCommentControls {
  items: DiffComment[]
  onAdd: (comment: Omit<DiffComment, 'id'>) => void
  onRemove: (id: string) => void
  onSend: () => void
  sending: boolean
}

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

/** One diff line with its number, a button to comment on it, its comments and the open comment box. */
function DiffLineRow({
  text,
  kind,
  number,
  target,
  comments,
  editing,
  onEdit,
}: {
  text: string
  kind: string
  number: number | undefined
  target: DiffCommentTarget | undefined
  comments: DiffCommentControls | undefined
  editing: boolean
  onEdit: (target: DiffCommentTarget | null) => void
}) {
  const here = target && comments ? comments.items.filter((c) => sameTarget(c, target)) : []
  return (
    <>
      <span className={`diff-line ${kind}`} {...(number !== undefined ? { 'data-line': number } : {})}>
        {target ? (
          <button
            type="button"
            className="diff-comment-add"
            aria-label={`在第 ${target.line} 行留言`}
            onClick={() => onEdit(target)}
          >
            <Icon name="plus" size={12} />
          </button>
        ) : null}
        {text || ' '}
      </span>
      {here.map((comment) => (
        <span className="diff-comment" key={comment.id} data-testid="diff-comment">
          <span className="diff-comment-text">{comment.text}</span>
          <IconButton icon="x" label="刪除留言" onClick={() => comments?.onRemove(comment.id)} />
        </span>
      ))}
      {editing && target && comments ? (
        <CommentForm
          onCancel={() => onEdit(null)}
          onSave={(body) => {
            comments.onAdd({ ...target, code: text, text: body })
            onEdit(null)
          }}
        />
      ) : null}
    </>
  )
}

function CommentForm({ onSave, onCancel }: { onSave: (text: string) => void; onCancel: () => void }) {
  const [text, setText] = useState('')
  const save = () => {
    if (text.trim()) onSave(text.trim())
  }
  return (
    <span className="diff-comment-form">
      <textarea
        aria-label="留言"
        autoFocus
        rows={3}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onCancel()
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            save()
          }
        }}
      />
      <span className="diff-comment-actions">
        <Button variant="ghost" onClick={onCancel}>
          取消
        </Button>
        <Button variant="primary" disabled={!text.trim()} onClick={save}>
          留言
        </Button>
      </span>
    </span>
  )
}

/** One file's diff: a header that folds it, and its lines drawn a page at a time. */
function DiffFileSection({
  view,
  open,
  active,
  onToggle,
  sectionRef,
  comments,
  editing,
  onEdit,
}: {
  view: DiffFileView
  open: boolean
  active: boolean
  onToggle: () => void
  sectionRef: (element: HTMLElement | null) => void
  comments?: DiffCommentControls | undefined
  editing: DiffCommentTarget | null
  onEdit: (target: DiffCommentTarget | null) => void
}) {
  const [shown, setShown] = useState(FILE_PAGE_LINES)
  const { file, lines } = view
  const numbered = useMemo(() => numberDiffLines(lines), [lines])
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
          {numbered.slice(0, shown).map((line, index) => {
            const target = commentTarget(file.path, line)
            const number = line.kind === 'removed' ? line.oldLine : line.newLine
            return (
              <DiffLineRow
                key={index}
                text={line.text}
                kind={line.kind}
                number={number}
                target={comments ? target : undefined}
                comments={comments}
                editing={Boolean(target && editing && sameTarget(target, editing))}
                onEdit={onEdit}
              />
            )
          })}
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
export function DiffBrowser({
  diff,
  actions,
  comments,
}: {
  diff: WorkspaceDiff
  actions?: ReactNode
  /** Leave out when the task cannot take a message: lines then have no comment button. */
  comments?: DiffCommentControls
}) {
  const plan = useMemo(() => planDiff(diff), [diff])
  const tree = useMemo(() => buildFileTree(diff.files), [diff.files])
  // The owner's own folding wins over the default; it survives new events re-planning the same files.
  const [toggled, setToggled] = useState<Map<string, boolean>>(() => new Map())
  const [active, setActive] = useState('')
  const [editing, setEditing] = useState<DiffCommentTarget | null>(null)
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
      {comments?.items.length ? (
        <div className="diff-comments-bar" data-testid="diff-comments-bar">
          <Icon name="chat" size={14} />
          <span>{comments.items.length} 則留言</span>
          <Button variant="primary" disabled={comments.sending} onClick={comments.onSend}>
            送出留言
          </Button>
        </div>
      ) : null}
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
              comments={comments}
              editing={editing}
              onEdit={setEditing}
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
