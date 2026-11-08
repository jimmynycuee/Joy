import { useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { IconButton } from './ui.js'

/** The thread title. Double-click it, or press the pencil, to rename; Enter or leaving the box saves, Esc cancels. */
export function TitleEditor({
  title,
  onRename,
}: {
  title: string
  /** Resolves true when the server accepted the new title. */
  onRename: (title: string) => Promise<boolean>
}) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(title)
  const [saving, setSaving] = useState(false)
  // Escape also blurs the box; this keeps that blur from saving what was just cancelled.
  const cancelled = useRef(false)

  function start() {
    cancelled.current = false
    setValue(title)
    setEditing(true)
  }

  async function commit() {
    if (cancelled.current || saving) return
    const next = value.trim()
    if (!next || next === title) {
      setEditing(false)
      return
    }
    setSaving(true)
    const ok = await onRename(next)
    setSaving(false)
    // A refused rename keeps the box open with the text, so nothing typed is lost.
    if (ok) setEditing(false)
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (event.key === 'Enter') {
      event.preventDefault()
      void commit()
    } else if (event.key === 'Escape') {
      cancelled.current = true
      setEditing(false)
    }
  }

  if (editing) {
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
  return (
    <div className="title-row">
      <h1 onDoubleClick={start} title="連點兩下可以重新命名">
        {title}
      </h1>
      <IconButton icon="pencil" label="重新命名" className="icon-btn-sm title-edit" onClick={start} />
    </div>
  )
}
