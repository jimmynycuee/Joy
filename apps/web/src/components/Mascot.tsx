import { useId } from 'react'

// Joy's character, redrawn in SVG from the owner's approved reference (viewBox 0 0 200 200).
// The face colours stay the same in light and dark mode; only the flat mark follows the theme (see `.mascot-mark`).

export const MASCOT_MOODS = ['normal', 'thinking', 'happy', 'waiting', 'error', 'sleeping'] as const
export type MascotMood = (typeof MASCOT_MOODS)[number]

/** What a screen reader says when the character is the only thing showing the state. */
export const MASCOT_LABELS: Record<MascotMood, string> = {
  normal: 'Joy',
  thinking: 'Joy 思考中',
  happy: 'Joy 完成了',
  waiting: 'Joy 等你',
  error: 'Joy 出錯了',
  sleeping: 'Joy 休息中',
}

const EYE = '#4A4A4A'
const TEAL = '#2EE6D6'
const TEAL_DEEP = '#0E9C91'

function Face({ mood }: { mood: MascotMood }) {
  switch (mood) {
    case 'thinking':
      return (
        <>
          <ellipse cx="86" cy="100" rx="6.5" ry="9.5" fill={EYE} transform="rotate(-14 86 100)" />
          <ellipse cx="125" cy="92" rx="6.5" ry="9.5" fill={EYE} transform="rotate(-14 125 92)" />
          <circle cx="58" cy="44" r="4" fill="#C8C8C4" />
          <circle cx="46" cy="30" r="6" fill="#C8C8C4" />
        </>
      )
    case 'happy':
      return (
        <>
          <path d="M70 110 Q80 97 90 110" fill="none" stroke={EYE} strokeWidth="6" strokeLinecap="round" />
          <path d="M110 102 Q120 89 130 102" fill="none" stroke={EYE} strokeWidth="6" strokeLinecap="round" />
          <ellipse cx="70" cy="128" rx="10" ry="6" fill="#F4A19A" opacity="0.5" />
          <ellipse cx="136" cy="120" rx="10" ry="6" fill="#F4A19A" opacity="0.5" />
        </>
      )
    case 'waiting':
      return (
        <>
          <circle cx="80" cy="106" r="9.5" fill={EYE} />
          <circle cx="120" cy="98" r="9.5" fill={EYE} />
          <circle cx="83" cy="102" r="3" fill="#FFFFFF" />
          <circle cx="123" cy="94" r="3" fill="#FFFFFF" />
          <rect x="44" y="26" width="9" height="26" rx="4.5" fill={TEAL_DEEP} />
          <circle cx="48.5" cy="62" r="5" fill={TEAL_DEEP} />
        </>
      )
    case 'error':
      return (
        <>
          <path
            d="M72 100 L88 116 M88 100 L72 116"
            fill="none"
            stroke={EYE}
            strokeWidth="5.5"
            strokeLinecap="round"
          />
          <path
            d="M112 92 L128 108 M128 92 L112 108"
            fill="none"
            stroke={EYE}
            strokeWidth="5.5"
            strokeLinecap="round"
          />
          <path
            d="M150 82 C146 90 143 95 143 100 A7 7 0 0 0 157 100 C157 95 154 90 150 82 Z"
            fill="#8FD3F2"
          />
        </>
      )
    case 'sleeping':
      return (
        <>
          <path d="M70 106 Q80 115 90 106" fill="none" stroke={EYE} strokeWidth="5.5" strokeLinecap="round" />
          <path
            d="M110 98 Q120 107 130 98"
            fill="none"
            stroke={EYE}
            strokeWidth="5.5"
            strokeLinecap="round"
          />
          <text
            x="48"
            y="50"
            fontFamily="Inter, system-ui, sans-serif"
            fontSize="22"
            fontWeight="600"
            fill="#A3A39E"
          >
            z
          </text>
          <text
            x="30"
            y="30"
            fontFamily="Inter, system-ui, sans-serif"
            fontSize="15"
            fontWeight="600"
            fill="#C8C8C4"
          >
            z
          </text>
        </>
      )
    default:
      return (
        <>
          <ellipse cx="80" cy="108" rx="7.5" ry="11" fill={EYE} transform="rotate(-14 80 108)" />
          <ellipse cx="120" cy="100" rx="7.5" ry="11" fill={EYE} transform="rotate(-14 120 100)" />
        </>
      )
  }
}

export interface MascotProps {
  mood?: MascotMood
  /** Edge of the square the character is drawn in, in px. */
  size?: number
  /** Accessible name; defaults to the mood's label. */
  label?: string
  /** The character only decorates text that already says the same thing: hide it from screen readers. */
  decorative?: boolean
  className?: string
}

/**
 * The character. Gradient ids are unique per instance (several moods can be on screen at once).
 * While `thinking`, the small ball circles the body; `prefers-reduced-motion` stops it (see `.mascot-orbit`).
 */
export function Mascot({ mood = 'normal', size = 96, label, decorative = false, className }: MascotProps) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const bodyId = `joy-body-${uid}`
  const glowId = `joy-glow-${uid}`
  const orbiting = mood === 'thinking'
  const moon = (
    <>
      <circle cx="172" cy="68" r="17" fill={`url(#${glowId})`} />
      <circle cx="172" cy="68" r="9" fill={TEAL} />
    </>
  )
  return (
    <svg
      viewBox="0 0 200 200"
      width={size}
      height={size}
      className={`mascot${className ? ` ${className}` : ''}`}
      data-mood={mood}
      focusable="false"
      {...(decorative
        ? { 'aria-hidden': true }
        : { role: 'img', 'aria-label': label ?? MASCOT_LABELS[mood] })}
    >
      <defs>
        <radialGradient id={bodyId} cx="0.38" cy="0.34" r="0.78">
          <stop offset="0" stopColor="#FFFBEA" />
          <stop offset="0.55" stopColor="#FCEDB2" />
          <stop offset="1" stopColor="#F5D670" />
        </radialGradient>
        <radialGradient id={glowId} cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor={TEAL} stopOpacity="0.55" />
          <stop offset="1" stopColor={TEAL} stopOpacity="0" />
        </radialGradient>
      </defs>
      <ellipse cx="100" cy="188" rx="46" ry="6" fill="#F5C94A" opacity="0.22" />
      <path
        d="M12 122 A90 24 0 0 1 188 122"
        transform="rotate(-16 100 122)"
        fill="none"
        stroke={TEAL}
        strokeWidth="7"
        strokeLinecap="round"
        opacity="0.5"
      />
      <path d="M126 58 C138 54 148 46 156 38 C163 32 168 40 166 52 C164 62 158 70 152 74 Z" fill="#F8DE86" />
      <circle cx="100" cy="112" r="62" fill={`url(#${bodyId})`} />
      <Face mood={mood} />
      <path
        d="M12 122 A90 24 0 0 0 188 122"
        transform="rotate(-16 100 122)"
        fill="none"
        stroke={TEAL}
        strokeWidth="7"
        strokeLinecap="round"
      />
      {orbiting ? <g className="mascot-orbit">{moon}</g> : <g>{moon}</g>}
    </svg>
  )
}

/**
 * The flat small version (no gradients, glow or back half of the ring) for sizes under about 32px:
 * the sidebar brand and the assistant's avatar. The teal follows the theme.
 */
export function MascotMark({ size = 26, label, decorative = true, className }: Omit<MascotProps, 'mood'>) {
  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      className={`mascot-mark${className ? ` ${className}` : ''}`}
      focusable="false"
      {...(decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': label ?? 'Joy' })}
    >
      <circle cx="31" cy="35" r="22" fill="#F8DD7A" />
      <ellipse cx="25" cy="34" rx="3.2" ry="4.6" fill="#3A3A37" />
      <ellipse cx="38" cy="31" rx="3.2" ry="4.6" fill="#3A3A37" />
      <path
        className="mascot-mark-teal"
        d="M4 40 C14 50 46 44 60 28"
        fill="none"
        strokeWidth="5"
        strokeLinecap="round"
      />
      <circle className="mascot-mark-teal-fill" cx="55" cy="14" r="5" />
    </svg>
  )
}
