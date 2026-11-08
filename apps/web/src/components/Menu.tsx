import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode, RefObject } from 'react'
import { createPortal } from 'react-dom'
import { placeFloating } from '../menu-position.js'
import type { Align, Placement, Side } from '../menu-position.js'
import { Icon } from './ui.js'
import type { IconName } from './ui.js'

/*
 * One menu for the whole app: a trigger button, a floating panel, items that can be checked, carry a second line, a
 * shortcut hint or a reason they are off, and sub-menus. Keyboard: arrows move, Enter or Space picks, a digit picks the
 * item that shows that digit, Right opens a sub-menu, Left or Esc closes it (Esc on the top level closes the menu and
 * puts focus back on the trigger). Panels are fixed-position in <body>, so no parent's overflow can clip them.
 */

interface RootContextValue {
  id: string
  close: (restoreFocus?: boolean) => void
}
const RootContext = createContext<RootContextValue | null>(null)

interface PanelContextValue {
  panelRef: RefObject<HTMLDivElement | null>
  activeSub: string | null
  setActiveSub: (id: string | null) => void
}
const PanelContext = createContext<PanelContextValue | null>(null)

const ITEM_SELECTOR = '[role^="menuitem"]'
const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [tabindex="0"], input:not([disabled]), select:not([disabled])'

/** The items that belong to this panel itself, not to a menu nested inside it. */
function panelItems(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>(ITEM_SELECTOR)).filter(
    (item) => item.closest('[role="menu"]') === panel,
  )
}

function isOff(item: Element): boolean {
  return item.getAttribute('aria-disabled') === 'true'
}

function focusItem(item: HTMLElement | undefined): void {
  item?.focus({ preventScroll: false })
}

/** Measures the panel against its trigger and keeps it placed while the window changes. */
function useFloating(
  anchor: HTMLElement | null,
  side: Side,
  align: Align,
): [RefObject<HTMLDivElement | null>, Placement | null] {
  const ref = useRef<HTMLDivElement | null>(null)
  const [placement, setPlacement] = useState<Placement | null>(null)
  useLayoutEffect(() => {
    const panel = ref.current
    if (!anchor || !panel) return
    const update = () => {
      const rect = anchor.getBoundingClientRect()
      const next = placeFloating({
        anchor: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
        size: { width: panel.offsetWidth, height: panel.scrollHeight },
        viewport: { width: window.innerWidth, height: window.innerHeight },
        side,
        align,
      })
      setPlacement((previous) =>
        previous &&
        previous.left === next.left &&
        previous.top === next.top &&
        previous.maxHeight === next.maxHeight
          ? previous
          : next,
      )
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [anchor, side, align])
  return [ref, placement]
}

interface PanelProps {
  anchor: HTMLElement | null
  side: Side
  align: Align
  label: string
  /** `menu` holds items; `dialog` holds anything (the effort slider) and only handles Esc itself. */
  kind: 'menu' | 'dialog'
  /** Esc, or Left in a sub-menu. */
  onDismiss: () => void
  /** Tab leaves the menu; also closes it. */
  onLeave: () => void
  nested: boolean
  className?: string
  children: ReactNode
}

function Panel({
  anchor,
  side,
  align,
  label,
  kind,
  onDismiss,
  onLeave,
  nested,
  className,
  children,
}: PanelProps) {
  const root = useContext(RootContext)
  const [ref, placement] = useFloating(anchor, side, align)
  const [activeSub, setActiveSub] = useState<string | null>(null)

  // Focus moves in once the panel is placed (a hidden panel cannot take focus): the checked item, else the first.
  const focused = useRef(false)
  useEffect(() => {
    const panel = ref.current
    if (!placement || !panel || focused.current) return
    focused.current = true
    if (kind === 'menu') {
      const items = panelItems(panel)
      focusItem(
        items.find((item) => item.getAttribute('aria-checked') === 'true' && !isOff(item)) ??
          items.find((item) => !isOff(item)) ??
          items[0],
      )
    } else {
      const target =
        panel.querySelector<HTMLElement>('[data-autofocus]') ??
        panel.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)
      target?.focus()
    }
  }, [placement, kind, ref])

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const panel = ref.current
    if (!panel) return
    // A nested panel is a React child of its parent item, so its keys would bubble up and be handled twice.
    if (nested) event.stopPropagation()
    if (event.key === 'Escape') {
      event.preventDefault()
      onDismiss()
      return
    }
    if (event.key === 'Tab') {
      if (kind === 'menu') {
        event.preventDefault()
        onLeave()
        return
      }
      // A dialog keeps Tab inside itself: the panel lives at the end of <body>, so it would otherwise leave the page.
      const controls = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
      const first = controls[0]
      const last = controls.at(-1)
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
      return
    }
    if (kind !== 'menu' || event.ctrlKey || event.metaKey || event.altKey) return
    const items = panelItems(panel)
    const index = items.indexOf(document.activeElement as HTMLElement)
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (items.length === 0) return
      const step = event.key === 'ArrowDown' ? 1 : -1
      focusItem(
        items[index < 0 ? (step === 1 ? 0 : items.length - 1) : (index + step + items.length) % items.length],
      )
    } else if (event.key === 'Home') {
      event.preventDefault()
      focusItem(items[0])
    } else if (event.key === 'End') {
      event.preventDefault()
      focusItem(items.at(-1))
    } else if (event.key === 'ArrowLeft' && nested) {
      event.preventDefault()
      onDismiss()
    } else if (/^[1-9]$/.test(event.key)) {
      const item = items.find((candidate) => candidate.dataset.shortcut === event.key)
      if (item) {
        event.preventDefault()
        if (!isOff(item)) item.click()
      }
    }
  }

  return createPortal(
    <PanelContext.Provider value={{ panelRef: ref, activeSub, setActiveSub }}>
      <div
        ref={ref}
        role={kind === 'menu' ? 'menu' : 'dialog'}
        aria-label={label}
        aria-orientation={kind === 'menu' ? 'vertical' : undefined}
        data-menu-root={root?.id}
        className={`menu-panel${kind === 'dialog' ? ' menu-panel-dialog' : ''}${className ? ` ${className}` : ''}`}
        style={{
          left: placement?.left ?? 0,
          top: placement?.top ?? 0,
          maxHeight: placement?.maxHeight,
          visibility: placement ? 'visible' : 'hidden',
        }}
        onKeyDown={onKeyDown}
      >
        {children}
      </div>
    </PanelContext.Provider>,
    document.body,
  )
}

/** A trigger button with a menu under (or over) it. Menu content is MenuItem, MenuGroup, MenuSeparator and SubMenu. */
export function Menu({
  label,
  triggerLabel,
  triggerClassName = 'btn btn-ghost composer-trigger',
  triggerTitle,
  trigger,
  disabled = false,
  side = 'bottom',
  align = 'start',
  onOpenChange,
  children,
}: {
  /** Accessible name of the menu itself. */
  label: string
  /** Accessible name of the trigger button; defaults to its visible text. */
  triggerLabel?: string | undefined
  triggerClassName?: string
  triggerTitle?: string | undefined
  /** The trigger's visible content. */
  trigger: ReactNode
  disabled?: boolean
  /** Which side of the trigger the menu prefers; it flips when there is no room. */
  side?: 'top' | 'bottom'
  align?: Align
  onOpenChange?: (open: boolean) => void
  children: ReactNode
}) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const setTrigger = useCallback((element: HTMLButtonElement | null) => {
    triggerRef.current = element
    setAnchor(element)
  }, [])

  const change = useCallback(
    (next: boolean) => {
      setOpen(next)
      onOpenChange?.(next)
    },
    [onOpenChange],
  )
  const close = useCallback(
    (restoreFocus = true) => {
      change(false)
      if (restoreFocus) triggerRef.current?.focus()
    },
    [change],
  )

  // A menu whose trigger turns off while open (the mode changed under it) must not stay open.
  useEffect(() => {
    if (disabled && open) change(false)
  }, [disabled, open, change])

  useEffect(() => {
    if (!open) return
    const onPointer = (event: Event) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (triggerRef.current?.contains(target)) return
      const layer =
        target instanceof Element
          ? target.closest('[data-menu-root]')
          : target.parentElement?.closest('[data-menu-root]')
      if (layer?.getAttribute('data-menu-root') === id) return
      close(false)
    }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('touchstart', onPointer)
    return () => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('touchstart', onPointer)
    }
  }, [open, id, close])

  return (
    <>
      <button
        ref={setTrigger}
        type="button"
        className={triggerClassName}
        aria-label={triggerLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        title={triggerTitle}
        disabled={disabled}
        onClick={() => change(!open)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            change(true)
          }
        }}
      >
        {trigger}
      </button>
      {open ? (
        <RootContext.Provider value={{ id, close }}>
          <Panel
            anchor={anchor}
            side={side}
            align={align}
            label={label}
            kind="menu"
            nested={false}
            onDismiss={() => close(true)}
            onLeave={() => close(true)}
          >
            {children}
          </Panel>
        </RootContext.Provider>
      ) : null}
    </>
  )
}

export function MenuGroup({
  label,
  hideLabel = false,
  children,
}: {
  label: string
  /** Keep the name for assistive technology but draw no heading (the first group of a menu needs none). */
  hideLabel?: boolean
  children: ReactNode
}) {
  return (
    <div role="group" aria-label={label}>
      {hideLabel ? null : (
        <div className="menu-group-label" aria-hidden="true">
          {label}
        </div>
      )}
      {children}
    </div>
  )
}

export function MenuSeparator() {
  return <div role="separator" className="menu-separator" />
}

/**
 * One row. `menuitemradio` and `menuitemcheckbox` show a check on the right when `checked`. A row that is off stays
 * focusable (so the keyboard can reach the reason) but does nothing; `disabledReason` is its tooltip and second line.
 */
export function MenuItem({
  children,
  role = 'menuitem',
  checked,
  description,
  hint,
  shortcut,
  icon,
  disabled = false,
  disabledReason,
  keepOpen,
  onSelect,
}: {
  children: ReactNode
  role?: 'menuitem' | 'menuitemradio' | 'menuitemcheckbox'
  checked?: boolean | undefined
  /** Small grey second line. */
  description?: ReactNode | undefined
  /** Small grey text on the same line, after the name. */
  hint?: string | undefined
  /** One digit, shown on the right and pressed to pick this row. */
  shortcut?: string | undefined
  icon?: IconName | undefined
  disabled?: boolean
  disabledReason?: string | undefined
  /** Stay open after picking; the default for a checkbox. */
  keepOpen?: boolean | undefined
  onSelect?: (() => void) | undefined
}) {
  const root = useContext(RootContext)
  const hasCheck = role !== 'menuitem'
  const secondLine = disabled && disabledReason ? disabledReason : description
  return (
    <button
      type="button"
      role={role}
      aria-checked={hasCheck ? Boolean(checked) : undefined}
      aria-disabled={disabled || undefined}
      title={disabled ? disabledReason : undefined}
      tabIndex={-1}
      data-shortcut={shortcut}
      className="menu-item"
      onMouseEnter={(event) => event.currentTarget.focus({ preventScroll: true })}
      onClick={() => {
        if (disabled) return
        onSelect?.()
        if (!(keepOpen ?? role === 'menuitemcheckbox')) root?.close(true)
      }}
    >
      {icon ? <Icon name={icon} size={14} /> : null}
      <span className="menu-item-text">
        <span className="menu-item-label">
          {children}
          {hint ? <span className="menu-item-hint">{hint}</span> : null}
        </span>
        {secondLine ? <span className="menu-item-desc">{secondLine}</span> : null}
      </span>
      {shortcut ? (
        <span className="menu-shortcut" aria-hidden="true">
          {shortcut}
        </span>
      ) : null}
      {hasCheck ? (
        <span className="menu-check" aria-hidden="true">
          {checked ? <Icon name="check" size={14} /> : null}
        </span>
      ) : null}
    </button>
  )
}

export interface SubMenuApi {
  /** Closes the sub-menu and puts focus back on its row. */
  close: () => void
  /** Closes the sub-menu and puts focus on the checked row of the menu it came from. */
  backToList: () => void
}

/** A row that opens a second panel beside it: a menu of rows (`kind="menu"`) or free content (`kind="dialog"`). */
export function SubMenu({
  label,
  value,
  description,
  kind = 'menu',
  disabled = false,
  disabledReason,
  children,
}: {
  label: string
  /** Current value, shown grey on the right. */
  value?: string | undefined
  description?: string | undefined
  kind?: 'menu' | 'dialog'
  disabled?: boolean
  disabledReason?: string | undefined
  children: ReactNode | ((api: SubMenuApi) => ReactNode)
}) {
  const parent = useContext(PanelContext)
  const id = useId()
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null)
  const anchorRef = useRef<HTMLButtonElement | null>(null)
  const setTrigger = useCallback((element: HTMLButtonElement | null) => {
    anchorRef.current = element
    setAnchor(element)
  }, [])
  const open = parent?.activeSub === id && !disabled
  const secondLine = disabled && disabledReason ? disabledReason : description

  const close = useCallback(() => {
    parent?.setActiveSub(null)
    anchorRef.current?.focus()
  }, [parent])
  const backToList = useCallback(() => {
    parent?.setActiveSub(null)
    const panel = parent?.panelRef.current
    if (!panel) return
    const items = panelItems(panel)
    focusItem(items.find((item) => item.getAttribute('aria-checked') === 'true') ?? items[0])
  }, [parent])
  const api: SubMenuApi = { close, backToList }
  const root = useContext(RootContext)

  return (
    <>
      <button
        ref={setTrigger}
        type="button"
        role="menuitem"
        aria-haspopup={kind === 'menu' ? 'menu' : 'dialog'}
        aria-expanded={open}
        aria-disabled={disabled || undefined}
        title={disabled ? disabledReason : undefined}
        tabIndex={-1}
        className="menu-item"
        onMouseEnter={(event) => event.currentTarget.focus({ preventScroll: true })}
        onClick={() => {
          if (disabled) return
          parent?.setActiveSub(open ? null : id)
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowRight' && !disabled) {
            event.preventDefault()
            parent?.setActiveSub(id)
          }
        }}
      >
        <span className="menu-item-text">
          <span className="menu-item-label">{label}</span>
          {secondLine ? <span className="menu-item-desc">{secondLine}</span> : null}
        </span>
        {value ? <span className="menu-value">{value}</span> : null}
        <span className="menu-check" aria-hidden="true">
          <Icon name="chevron-right" size={14} />
        </span>
      </button>
      {open ? (
        <Panel
          anchor={anchor}
          side="right"
          align="start"
          label={label}
          kind={kind}
          nested
          onDismiss={close}
          onLeave={() => root?.close(true)}
        >
          {typeof children === 'function' ? children(api) : children}
        </Panel>
      ) : null}
    </>
  )
}
