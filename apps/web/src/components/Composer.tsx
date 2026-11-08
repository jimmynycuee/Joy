import { useEffect, useRef } from 'react'
import type { FormEvent, KeyboardEvent, ReactNode, RefObject } from 'react'
import { Icon, Spinner } from './ui.js'

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
}) {
  const ownRef = useRef<HTMLTextAreaElement | null>(null)
  const ref = textareaRef ?? ownRef

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
    if (busy || disabled || !value.trim()) return
    event.currentTarget.form?.requestSubmit()
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy || disabled || !value.trim()) return
    void onSubmit(new FormData(event.currentTarget))
  }

  return (
    <form className={`composer${className ? ` ${className}` : ''}`} onSubmit={submit}>
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
      />
      <div className="composer-bar">
        {bar}
        <span className="composer-spacer" />
        {trailing}
        <button
          type="submit"
          className="send-btn"
          aria-label={sendLabel}
          title={sendLabel}
          disabled={busy || disabled}
        >
          {busy ? <Spinner /> : <Icon name="arrow-up" size={18} />}
        </button>
      </div>
      {advanced}
    </form>
  )
}
