import { useEffect, useRef, useState } from 'react'
import type { ClipboardEvent, DragEvent, FormEvent, KeyboardEvent, ReactNode, RefObject } from 'react'
import type { PendingAttachment } from '../attachments.js'
import { pastedFiles, sendableAttachments } from '../attachments.js'
import { AttachmentTray } from './Attachments.js'
import { Icon, IconButton, Spinner } from './ui.js'

/** Files for the box: pasted (⌘V), dropped on it, or picked with the paperclip. */
export interface ComposerAttachments {
  items: readonly PendingAttachment[]
  onAdd: (files: File[]) => void
  onRemove: (key: string) => void
  /** A message may be only files (a task's first prompt still needs words). */
  allowWithoutText?: boolean
}

/**
 * The one message box: used for starting a task and for chatting with the assistant.
 * Enter sends, Shift+Enter adds a line. While an input method (注音, 拼音, 日文…) is composing, Enter belongs to it.
 */
export function Composer({
  className,
  value,
  onChange,
  onSubmit,
  placeholder,
  textareaLabel,
  sendLabel,
  busy = false,
  disabled = false,
  autoFocus = false,
  rows = 2,
  bar,
  trailing,
  advanced,
  textareaRef,
  onStop,
  stopLabel = '停止',
  stopping = false,
  attachments,
}: {
  className?: string
  value: string
  onChange: (text: string) => void
  /** Called with the form (for extra fields) when the message is sent. */
  onSubmit: (form: FormData) => void | Promise<void>
  placeholder?: string
  textareaLabel: string
  sendLabel: string
  busy?: boolean
  /** Turns the box off (no typing, no sending); the page says why. */
  disabled?: boolean
  autoFocus?: boolean
  rows?: number
  /** Controls on the left of the bottom bar (selects, chips). */
  bar?: ReactNode
  /** Controls on the right of the bottom bar, next to the send button (the model entry). */
  trailing?: ReactNode
  /** Extra content under the bar, for example the 進階 fields. */
  advanced?: ReactNode
  textareaRef?: RefObject<HTMLTextAreaElement | null>
  /** While the agent works and the box is empty, the send button becomes a stop button that calls this. */
  onStop?: () => void
  stopLabel?: string
  stopping?: boolean
  attachments?: ComposerAttachments
}) {
  const ownRef = useRef<HTMLTextAreaElement | null>(null)
  const ref = textareaRef ?? ownRef
  const pickerRef = useRef<HTMLInputElement | null>(null)
  const [dragging, setDragging] = useState(false)
  const files = attachments ? sendableAttachments(attachments.items) : { ids: [], blocked: false }
  const hasContent = Boolean(value.trim()) || Boolean(attachments?.allowWithoutText && files.ids.length)
  // An upload still running or a file that failed must not be left out silently.
  const canSend = hasContent && !files.blocked

  // Grow with the text up to a limit, then scroll.
  useEffect(() => {
    const element = ref.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, 260)}px`
  }, [value, ref])

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey) return
    // keyCode 229 is how Safari reports the Enter that confirms an IME candidate.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    event.preventDefault()
    if (busy || disabled || !canSend) return
    event.currentTarget.form?.requestSubmit()
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy || disabled || !canSend) return
    void onSubmit(new FormData(event.currentTarget))
  }

  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    if (!attachments || disabled) return
    const pasted = pastedFiles(event.clipboardData)
    if (!pasted.length) return
    event.preventDefault()
    attachments.onAdd(pasted)
  }

  const carriesFiles = (event: DragEvent) => Array.from(event.dataTransfer.types).includes('Files')
  const dropHandlers = attachments
    ? {
        onDragOver: (event: DragEvent<HTMLFormElement>) => {
          if (!carriesFiles(event) || disabled) return
          event.preventDefault()
          event.dataTransfer.dropEffect = 'copy'
          setDragging(true)
        },
        onDragLeave: (event: DragEvent<HTMLFormElement>) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false)
        },
        onDrop: (event: DragEvent<HTMLFormElement>) => {
          setDragging(false)
          if (!carriesFiles(event) || disabled) return
          event.preventDefault()
          attachments.onAdd(Array.from(event.dataTransfer.files))
        },
      }
    : {}

  return (
    <form
      className={`composer${className ? ` ${className}` : ''}${dragging ? ' composer-dragging' : ''}`}
      onSubmit={submit}
      {...dropHandlers}
    >
      {attachments ? <AttachmentTray items={attachments.items} onRemove={attachments.onRemove} /> : null}
      <textarea
        ref={ref}
        name="message"
        aria-label={textareaLabel}
        placeholder={placeholder}
        rows={rows}
        value={value}
        autoFocus={autoFocus}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
      />
      <div className="composer-bar">
        {attachments ? (
          <>
            <IconButton
              icon="paperclip"
              label="附加檔案"
              className="composer-attach"
              disabled={disabled}
              onClick={() => pickerRef.current?.click()}
            />
            <input
              ref={pickerRef}
              type="file"
              multiple
              hidden
              data-testid="attachment-input"
              onChange={(event) => {
                const picked = Array.from(event.target.files ?? [])
                // Cleared so the same file can be picked again after removing it.
                event.target.value = ''
                if (picked.length) attachments.onAdd(picked)
              }}
            />
          </>
        ) : null}
        {bar}
        <span className="composer-spacer" />
        {trailing}
        {onStop && !hasContent && !attachments?.items.length ? (
          <button
            type="button"
            className="send-btn stop-btn"
            aria-label={stopLabel}
            title={stopLabel}
            disabled={stopping}
            onClick={onStop}
          >
            {stopping ? <Spinner /> : <Icon name="stop" size={16} />}
          </button>
        ) : (
          <button
            type="submit"
            className="send-btn"
            aria-label={sendLabel}
            title={sendLabel}
            disabled={busy || disabled || files.blocked}
          >
            {busy ? <Spinner /> : <Icon name="arrow-up" size={18} />}
          </button>
        )}
      </div>
      {advanced}
    </form>
  )
}
