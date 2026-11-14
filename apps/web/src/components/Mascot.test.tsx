import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MASCOT_LABELS, MASCOT_MOODS, Mascot, MascotMark } from './Mascot.js'

const html = (element: React.ReactElement) => renderToStaticMarkup(element)

describe('Mascot', () => {
  it('draws every mood with the shared body and ring', () => {
    for (const mood of MASCOT_MOODS) {
      const svg = html(<Mascot mood={mood} />)
      expect(svg, mood).toContain('viewBox="0 0 200 200"')
      expect(svg, mood).toContain(`data-mood="${mood}"`)
      expect(svg, mood).toContain('r="62"')
      expect(svg, mood).toContain('stroke="#2EE6D6"')
    }
  })

  it('gives each mood its own face', () => {
    const face = (mood: (typeof MASCOT_MOODS)[number]) => html(<Mascot mood={mood} />)
    expect(face('normal')).toContain('rx="7.5" ry="11"')
    expect(face('thinking')).toContain('rx="6.5" ry="9.5"')
    expect(face('thinking')).toContain('cx="46" cy="30" r="6"')
    expect(face('happy')).toContain('M70 110 Q80 97 90 110')
    expect(face('happy')).toContain('fill="#F4A19A"')
    expect(face('waiting')).toContain('fill="#0E9C91"')
    expect(face('error')).toContain('M72 100 L88 116')
    expect(face('error')).toContain('fill="#8FD3F2"')
    expect(face('sleeping')).toContain('M70 106 Q80 115 90 106')
    expect(face('sleeping')).toContain('>z</text>')
    // The faces do not leak into each other.
    expect(face('normal')).not.toContain('M70 110 Q80 97')
    expect(face('happy')).not.toContain('rx="7.5" ry="11"')
  })

  it('only circles the small ball while thinking, with CSS the reduced-motion query can switch off', () => {
    for (const mood of MASCOT_MOODS)
      expect(html(<Mascot mood={mood} />).includes('mascot-orbit'), mood).toBe(mood === 'thinking')
    const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8')
    const reduced = /@media \(prefers-reduced-motion: reduce\) \{\s*\.mascot-orbit \{\s*animation: none;/
    expect(css).toMatch(reduced)
    expect(css).toMatch(
      /\.mascot-orbit \{[^}]*transform-origin: 100px 112px;[^}]*animation: mascot-orbit 3\.2s linear infinite/,
    )
  })

  it('names itself in Chinese, or hides when it only decorates', () => {
    for (const mood of MASCOT_MOODS) {
      const svg = html(<Mascot mood={mood} />)
      expect(svg, mood).toContain('role="img"')
      expect(svg, mood).toContain(`aria-label="${MASCOT_LABELS[mood]}"`)
    }
    expect(MASCOT_LABELS.waiting).toBe('Joy 等你')
    expect(html(<Mascot mood="error" label="連不上伺服器" />)).toContain('aria-label="連不上伺服器"')
    const hidden = html(<Mascot mood="happy" decorative />)
    expect(hidden).toContain('aria-hidden="true"')
    expect(hidden).not.toContain('role="img"')
    expect(hidden).not.toContain('aria-label')
  })

  it('sizes the svg and defaults to the normal mood', () => {
    const svg = html(<Mascot size={20} />)
    expect(svg).toContain('width="20"')
    expect(svg).toContain('height="20"')
    expect(svg).toContain('data-mood="normal"')
  })

  it('uses gradient ids that differ per instance, and each url() points at its own', () => {
    const both = html(
      <>
        <Mascot mood="normal" />
        <Mascot mood="happy" />
      </>,
    )
    const ids = [...both.matchAll(/<radialGradient id="([^"]+)"/g)].map((match) => match[1])
    expect(ids).toHaveLength(4)
    expect(new Set(ids).size).toBe(4)
    for (const id of ids) {
      expect(id).toMatch(/^[A-Za-z0-9_-]+$/)
      expect(both).toContain(`url(#${id})`)
    }
  })
})

describe('MascotMark', () => {
  it('is the flat version: no gradients, teal from the theme', () => {
    const svg = html(<MascotMark size={26} />)
    expect(svg).toContain('viewBox="0 0 64 64"')
    expect(svg).toContain('width="26"')
    expect(svg).not.toContain('radialGradient')
    expect(svg).toContain('mascot-mark-teal')
    expect(svg).toContain('fill="#F8DD7A"')
  })

  it('is decorative unless asked to speak', () => {
    expect(html(<MascotMark />)).toContain('aria-hidden="true"')
    const spoken = html(<MascotMark decorative={false} />)
    expect(spoken).toContain('role="img"')
    expect(spoken).toContain('aria-label="Joy"')
  })
})
