import { useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { shortTitle } from '../labels.js'

/** The box that renames. Enter or leaving it saves, Esc cancels; it is mounted only while renaming. */
function TitleInput({
  title,
  onRename,
  onDone,
}: {
  title: string
  onRename: (title: string) => Promise<boolean>
  onDone: () => void
}) {
  const [value, setValue] = useState(title)
  const [saving, setSaving] = useState(false)
  // Escape also blurs the box; this keeps that blur from saving what was just cancelled.
  const cancelled = useRef(false)

  async function commit() {
    if (cancelled.current || saving) return
    const next = value.trim()
    if (!next || next === title) {
      onDone()
      return
    }
    setSaving(true)
    const ok = await onRename(next)
    setSaving(false)
    // A refused rename keeps the box open with the text, so nothing typed is lost.
    if (ok) onDone()
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (event.key === 'Enter') {
      event.preventDefault()
      void commit()
    } else if (event.key === 'Escape') {
      cancelled.current = true
      onDone()
    }
  }

  return (
    <input
      className="title-input"
      aria-label="任務標題"
      value={value}
      maxLength={500}
      autoFocus
      disabled={saving}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={onKeyDown}
      onBlur={() => void commit()}
    />
  )
}

/**
 * The thread title on one line (cut with "…" when long). Double-click it, or pick 改名 in the ⋯ menu, to rename.
 * Whether the box is open is the page's to say, so the menu can open it too.
 */
export function TitleEditor({
  title,
  onRename,
  editing,
  onEditingChange,
}: {
  title: string
  /** Resolves true when the server accepted the new title. */
  onRename: (title: string) => Promise<boolean>
  editing: boolean
  onEditingChange: (editing: boolean) => void
}) {
  if (editing) {
    return <TitleInput title={title} onRename={onRename} onDone={() => onEditingChange(false)} />
  }
  const short = shortTitle(title)
  return (
    <h1
      className="title-text"
      onDoubleClick={() => onEditingChange(true)}
      title={short === title ? undefined : title}
    >
      {short}
    </h1>
  )
}
