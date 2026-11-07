import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Markdown } from './components/Markdown.js'
import { parseInline, parseMarkdown, safeHref } from './markdown.js'

const html = (text: string) => renderToStaticMarkup(<Markdown text={text} />)

describe('safeHref', () => {
  it('allows http, https and mailto only', () => {
    expect(safeHref('https://example.com/a?b=1')).toBe('https://example.com/a?b=1')
    expect(safeHref('http://localhost:3000')).toBe('http://localhost:3000')
    expect(safeHref('mailto:a@example.com')).toBe('mailto:a@example.com')
  })

  it('refuses script-like and obfuscated schemes', () => {
    expect(safeHref('javascript:alert(1)')).toBeUndefined()
    expect(safeHref('JaVaScRiPt:alert(1)')).toBeUndefined()
    expect(safeHref('java\nscript:alert(1)')).toBeUndefined()
    expect(safeHref(' javascript:alert(1)')).toBeUndefined()
    expect(safeHref('data:text/html,<script>alert(1)</script>')).toBeUndefined()
    expect(safeHref('vbscript:msgbox(1)')).toBeUndefined()
    expect(safeHref('file:///etc/passwd')).toBeUndefined()
  })

  it('refuses links without a scheme', () => {
    expect(safeHref('src/main.ts')).toBeUndefined()
    expect(safeHref('//evil.example.com')).toBeUndefined()
    expect(safeHref('')).toBeUndefined()
  })
})

describe('Markdown rendering is safe', () => {
  it('shows raw HTML as literal text', () => {
    const output = html('<script>alert(1)</script> and <img src=x onerror=alert(1)>')
    expect(output).not.toContain('<script')
    expect(output).not.toContain('<img')
    expect(output).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it('escapes HTML inside code spans and fenced blocks', () => {
    const output = html('`<b>x</b>`\n\n```html\n<script>alert(1)</script>\n```')
    expect(output).not.toContain('<script')
    expect(output).not.toContain('<b>')
    expect(output).toContain('&lt;script&gt;')
  })

  it('drops javascript: links but keeps their text', () => {
    const output = html('[click me](javascript:alert(1))')
    expect(output).not.toContain('href')
    expect(output).not.toContain('javascript:')
    expect(output).toContain('click me')
  })

  it('opens real links safely in a new tab', () => {
    const output = html('[docs](https://example.com/docs)')
    expect(output).toContain('href="https://example.com/docs"')
    expect(output).toContain('rel="noreferrer noopener"')
    expect(output).toContain('target="_blank"')
  })

  it('does not let attribute-breaking quotes escape the href', () => {
    const output = html('[x](https://example.com/"onmouseover="alert(1))')
    expect(output).not.toMatch(/ onmouseover=/)
  })

  it('links bare URLs without swallowing the trailing period', () => {
    const inline = parseInline('see https://example.com/a.')
    expect(inline).toEqual([
      { t: 'text', v: 'see ' },
      { t: 'link', href: 'https://example.com/a', c: [{ t: 'text', v: 'https://example.com/a' }] },
      { t: 'text', v: '.' },
    ])
  })
})

describe('Markdown structure', () => {
  it('renders paragraphs, bold, italic and inline code', () => {
    const output = html('Run **pnpm check** and *then* `git push`.')
    expect(output).toContain('<strong>pnpm check</strong>')
    expect(output).toContain('<em>then</em>')
    expect(output).toContain('<code>git push</code>')
  })

  it('keeps lone asterisks and snake_case words literal', () => {
    const output = html('2 * 3 = 6 and my_var_name')
    expect(output).toContain('2 * 3 = 6 and my_var_name')
    expect(output).not.toContain('<em>')
  })

  it('renders unordered, ordered and nested lists', () => {
    const blocks = parseMarkdown('- a\n- b\n  - b1\n  - b2\n- c\n\n1. one\n2. two')
    expect(blocks).toHaveLength(2)
    const list = blocks[0]
    expect(list?.t).toBe('list')
    if (list?.t === 'list') {
      expect(list.items).toHaveLength(3)
      expect(list.items[1]?.children[0]?.t).toBe('list')
    }
    expect(blocks[1]).toMatchObject({ t: 'list', ordered: true })
  })

  it('renders fenced code with a language and keeps an unclosed fence while streaming', () => {
    expect(parseMarkdown('```ts\nconst a = 1\n```')).toEqual([{ t: 'code', lang: 'ts', v: 'const a = 1' }])
    expect(parseMarkdown('```\nstill typing')).toEqual([{ t: 'code', lang: '', v: 'still typing' }])
  })

  it('renders headings, quotes, rules and tables', () => {
    const output = html('# Title\n\n> quoted\n\n---\n\n| a | b |\n| - | - |\n| 1 | 2 |')
    expect(output).toContain('<h3>Title</h3>')
    expect(output).toContain('<blockquote>')
    expect(output).toContain('<hr/>')
    expect(output).toContain('<th>a</th>')
    expect(output).toContain('<td>2</td>')
  })

  it('treats a single newline as a line break', () => {
    expect(html('one\ntwo')).toContain('one<br/>two')
  })

  it('returns nothing for empty input', () => {
    expect(parseMarkdown('')).toEqual([])
    expect(parseMarkdown('   \n\n ')).toEqual([])
  })
})
