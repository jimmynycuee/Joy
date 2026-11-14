import { useEffect, useState } from 'react'
import type { ButtonHTMLAttributes, ReactNode } from 'react'

// One inline line-icon set (24px grid, 1.75 stroke, currentColor). Paths follow the Lucide style.
const ICONS = {
  plus: 'M12 5v14M5 12h14',
  x: 'M18 6 6 18M6 6l12 12',
  check: 'M20 6 9 17l-5-5',
  'chevron-down': 'm6 9 6 6 6-6',
  'chevron-right': 'm9 18 6-6-6-6',
  search: 'm21 21-4.3-4.3M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z',
  'arrow-up': 'M12 19V5M5 12l7-7 7 7',
  'arrow-left': 'M19 12H5M12 19l-7-7 7-7',
  menu: 'M4 6h16M4 12h16M4 18h16',
  chat: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  settings:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 12a7 7 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2-1.2L14 3h-4l-.5 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7 7 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 2 1.2L10 21h4l.5-2.6a7 7 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2z',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  copy: 'M8 8h11a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1zM5 16H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h11a1 1 0 0 1 1 1v1',
  stop: 'M6 6h12v12H6z',
  retry: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  repeat: 'M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3',
  external: 'M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6',
  'panel-right': 'M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM15 4v16',
  'panel-left': 'M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM9 4v16',
  trash: 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6',
  branch: 'M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9',
  terminal: 'm4 17 6-6-6-6M12 19h8',
  file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6',
  pencil: 'M17 3a2.8 2.8 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5z',
  bell: 'M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0',
  archive: 'M21 8v13H3V8M1 3h22v5H1zM10 12h4',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
  moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
  monitor: 'M2 4h20v12H2zM8 20h8M12 16v4',
  alert: 'M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  book: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20V2H6.5A2.5 2.5 0 0 0 4 4.5zM20 17v5H6.5A2.5 2.5 0 0 1 4 19.5',
  'git-pr':
    'M18 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM13 6h3a2 2 0 0 1 2 2v7M6 9v12',
  command: 'M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3',
  bolt: 'M13 2 3 14h9l-1 8 10-12h-9z',
  paperclip:
    'm21.4 11.1-9.2 9.2a6 6 0 0 1-8.5-8.5l8.6-8.6a4 4 0 0 1 5.7 5.7l-8.6 8.6a2 2 0 0 1-2.8-2.8l8.5-8.5',
} as const

export type IconName = keyof typeof ICONS

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={ICONS[name]} />
    </svg>
  )
}

/** The small dot in a project's colour; the project's name is always next to it, so it is hidden from screen readers. */
export function ProjectDot({ color, className }: { color: { hex: string } | undefined; className?: string }) {
  if (!color) return null
  return (
    <span
      className={`project-dot${className ? ` ${className}` : ''}`}
      style={{ background: color.hex }}
      aria-hidden="true"
    />
  )
}

export function Spinner() {
  return <span className="spinner" aria-hidden="true" />
}

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'

export function buttonClass(variant: ButtonVariant, large = false): string {
  return `btn btn-${variant}${large ? ' btn-lg' : ''}`
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant
  large?: boolean
  icon?: IconName
}

/** The four button variants share one height, radius and padding; see `.btn` in styles.css. */
export function Button({
  variant = 'secondary',
  large,
  icon,
  className,
  children,
  type,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type ?? 'button'}
      className={`${buttonClass(variant, large)}${className ? ` ${className}` : ''}`}
      {...rest}
    >
      {icon ? <Icon name={icon} /> : null}
      {children}
    </button>
  )
}

/** A link that looks like a button, for destinations outside Joy (opens in a new tab). */
export function ButtonLink({
  href,
  variant = 'secondary',
  icon,
  children,
}: {
  href: string
  variant?: ButtonVariant
  icon?: IconName
  children: ReactNode
}) {
  return (
    <a className={buttonClass(variant)} href={href} target="_blank" rel="noreferrer noopener">
      {icon ? <Icon name={icon} /> : null}
      {children}
    </a>
  )
}

/** A square icon-only button. `label` is the accessible name and the tooltip. */
export function IconButton({
  icon,
  label,
  className,
  type,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { icon: IconName; label: string }) {
  return (
    <button
      type={type ?? 'button'}
      className={`icon-btn${className ? ` ${className}` : ''}`}
      aria-label={label}
      title={label}
      {...rest}
    >
      <Icon name={icon} />
    </button>
  )
}

/** A show/hide section. Content stays mounted (hidden) so form values survive closing it. */
export function Disclosure({
  label,
  children,
  open,
  onToggle,
  className,
}: {
  label: string
  children: ReactNode
  open: boolean
  onToggle: () => void
  className?: string
}) {
  return (
    <div className={className}>
      <button type="button" className="disclosure-toggle" aria-expanded={open} onClick={onToggle}>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} />
        {label}
      </button>
      <div hidden={!open}>{children}</div>
    </div>
  )
}

/** Copies text and shows a check for a moment. */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1500)
    return () => window.clearTimeout(timer)
  }, [copied])
  return (
    <IconButton
      icon={copied ? 'check' : 'copy'}
      label={copied ? '已複製' : label}
      className="icon-btn-sm"
      onClick={() => {
        void navigator.clipboard
          ?.writeText(text)
          .then(() => setCopied(true))
          .catch(() => undefined)
      }}
    />
  )
}
