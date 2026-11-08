import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from './ui.js'
import type { IconName } from './ui.js'

/** A header button that opens a small panel under it; closes on Escape or a click outside. */
export function Popover({
  icon,
  label,
  buttonLabel,
  children,
  onOpenChange,
}: {
  icon: IconName
  /** Accessible name of the panel and of the button. */
  label: string
  /** Visible text on the button; defaults to the label. */
  buttonLabel?: ReactNode
  children: ReactNode
  onOpenChange?: (open: boolean) => void
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement | null>(null)

  function change(next: boolean) {
    setOpen(next)
    onOpenChange?.(next)
  }

  useEffect(() => {
    if (!open) return
    const onPointer = (event: MouseEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) {
        setOpen(false)
        onOpenChange?.(false)
      }
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false)
        onOpenChange?.(false)
      }
    }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
    // onOpenChange is only a notification; reattaching listeners on its identity would add nothing.
  }, [open])

  return (
    <div className="popover-root" ref={root}>
      <Button icon={icon} aria-expanded={open} aria-haspopup="dialog" onClick={() => change(!open)}>
        {buttonLabel ?? label}
      </Button>
      {open ? (
        <div className="popover-panel card" role="dialog" aria-label={label}>
          {children}
        </div>
      ) : null}
    </div>
  )
}
