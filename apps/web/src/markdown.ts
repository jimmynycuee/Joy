// A tiny Markdown parser for agent and assistant replies. It produces a plain data tree and never HTML: the React
// renderer (components/Markdown.tsx) turns the tree into elements, so raw HTML in the input stays literal text and
// there is no way to inject markup. Links only keep http(s) and mailto targets.

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'br' }
  | { t: 'strong'; c: Inline[] }
  | { t: 'em'; c: Inline[] }
  | { t: 'link'; href: string; c: Inline[] }

export interface ListItem {
  c: Inline[]
  children: Block[]
}

export type Block =
  | { t: 'p'; c: Inline[] }
  | { t: 'h'; level: number; c: Inline[] }
  | { t: 'code'; lang: string; v: string }
  | { t: 'quote'; c: Block[] }
  | { t: 'hr' }
  | { t: 'list'; ordered: boolean; start: number; items: ListItem[] }
  | { t: 'table'; head: Inline[][]; rows: Inline[][][] }

const ALLOWED_SCHEMES = new Set(['http', 'https', 'mailto'])

/** Browsers ignore tabs and newlines inside a URL ("java\nscript:"), so any such character makes it unsafe. */
function hasWhitespaceOrControl(url: string): boolean {
  for (const character of url) {
    const code = character.codePointAt(0) ?? 0
    if (code <= 0x20 || code === 0x7f || /\s/.test(character)) return true
  }
  return false
}

/** Returns the link target when it is safe to open, else undefined. Anything with a script-like scheme is refused. */
export function safeHref(raw: string): string | undefined {
  const url = raw.trim()
  if (!url || hasWhitespaceOrControl(url)) return undefined
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(url)?.[1]?.toLowerCase()
  if (!scheme || !ALLOWED_SCHEMES.has(scheme)) return undefined
  return url
}

const ESCAPABLE = '\\`*_{}[]()#+-.!|>~'

export function parseInline(src: string): Inline[] {
  const out: Inline[] = []
  let text = ''
  const flush = () => {
    if (text) out.push({ t: 'text', v: text })
    text = ''
  }
  let i = 0
  while (i < src.length) {
    const ch = src[i] ?? ''
    const next = src[i + 1] ?? ''
    if (ch === '\\' && next && ESCAPABLE.includes(next)) {
      text += next
      i += 2
      continue
    }
    if (ch === '\n') {
      flush()
      out.push({ t: 'br' })
      i++
      continue
    }
    if (ch === '`') {
      let ticks = 1
      while (src[i + ticks] === '`') ticks++
      const fence = '`'.repeat(ticks)
      const end = src.indexOf(fence, i + ticks)
      if (end > i + ticks - 1 && end !== -1) {
        flush()
        out.push({ t: 'code', v: src.slice(i + ticks, end).replace(/^ (.+) $/, '$1') })
        i = end + ticks
        continue
      }
      text += fence
      i += ticks
      continue
    }
    if (ch === '*' && next === '*') {
      const end = src.indexOf('**', i + 2)
      if (end > i + 2) {
        flush()
        out.push({ t: 'strong', c: parseInline(src.slice(i + 2, end)) })
        i = end + 2
        continue
      }
    }
    if (ch === '*' && next && !/\s/.test(next)) {
      let end = src.indexOf('*', i + 1)
      while (end !== -1 && src[end + 1] === '*') end = src.indexOf('*', end + 2)
      if (end > i + 1 && !/\s/.test(src[end - 1] ?? ' ')) {
        flush()
        out.push({ t: 'em', c: parseInline(src.slice(i + 1, end)) })
        i = end + 1
        continue
      }
    }
    if (ch === '[') {
      const close = src.indexOf('](', i + 1)
      const paren = close === -1 ? -1 : src.indexOf(')', close + 2)
      if (close !== -1 && paren !== -1 && !src.slice(i + 1, close).includes('\n')) {
        const label = src.slice(i + 1, close)
        const href = safeHref(
          src
            .slice(close + 2, paren)
            .trim()
            .split(/\s+/)[0] ?? '',
        )
        flush()
        if (href) out.push({ t: 'link', href, c: parseInline(label) })
        else out.push(...parseInline(label))
        i = paren + 1
        continue
      }
    }
    if (ch === 'h' && (src.startsWith('http://', i) || src.startsWith('https://', i))) {
      const match = /^https?:\/\/[^\s<>]+/.exec(src.slice(i))
      if (match) {
        // Sentence punctuation right after a URL belongs to the sentence.
        const url = match[0].replace(/[.,;:!?)\]]+$/, '')
        const href = safeHref(url)
        if (href) {
          flush()
          out.push({ t: 'link', href, c: [{ t: 'text', v: url }] })
          i += url.length
          continue
        }
      }
    }
    text += ch
    i++
  }
  flush()
  return out
}

interface RawItem {
  indent: number
  ordered: boolean
  start: number
  text: string
}

const LIST_LINE = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/
const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([^`\s]*)\s*$/
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/
const HR = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{1,}:?\s*(?:\|\s*:?-{1,}:?\s*)*\|?\s*$/

function indentOf(line: string): number {
  return (/^\s*/.exec(line)?.[0] ?? '').replaceAll('\t', '    ').length
}

function splitRow(line: string): string[] {
  let row = line.trim()
  if (row.startsWith('|')) row = row.slice(1)
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1)
  return row.split(/(?<!\\)\|/).map((cell) => cell.trim().replaceAll('\\|', '|'))
}

function startsBlock(line: string, nextLine: string | undefined): boolean {
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    HR.test(line) ||
    /^\s{0,3}>/.test(line) ||
    LIST_LINE.test(line) ||
    (line.includes('|') && nextLine !== undefined && TABLE_SEPARATOR.test(nextLine) && nextLine.includes('-'))
  )
}

function buildList(items: RawItem[], position: { i: number }, indent: number): Block {
  const first = items[position.i]
  const list: Extract<Block, { t: 'list' }> = {
    t: 'list',
    ordered: first?.ordered ?? false,
    start: first?.start ?? 1,
    items: [],
  }
  while (position.i < items.length) {
    const item = items[position.i]
    if (!item || item.indent < indent) break
    if (item.indent > indent) {
      const previous = list.items.at(-1)
      if (!previous) break
      previous.children.push(buildList(items, position, item.indent))
      continue
    }
    if (item.ordered !== list.ordered && list.items.length > 0) break
    list.items.push({ c: parseInline(item.text), children: [] })
    position.i++
  }
  return list
}

export function parseMarkdown(src: string): Block[] {
  const lines = src.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n')
  const blocks: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''
    if (!line.trim()) {
      i++
      continue
    }
    const fence = FENCE.exec(line)
    if (fence) {
      const marker = fence[1] ?? '```'
      const body: string[] = []
      i++
      // An unclosed fence runs to the end: replies stream in, so the closing fence may not have arrived yet.
      while (i < lines.length) {
        const current = lines[i] ?? ''
        const closing = /^\s{0,3}(`{3,}|~{3,})\s*$/.exec(current)?.[1]
        if (closing && closing[0] === marker[0] && closing.length >= marker.length) {
          i++
          break
        }
        body.push(current)
        i++
      }
      blocks.push({ t: 'code', lang: fence[2] ?? '', v: body.join('\n') })
      continue
    }
    const heading = HEADING.exec(line)
    if (heading) {
      blocks.push({ t: 'h', level: heading[1]?.length ?? 1, c: parseInline(heading[2] ?? '') })
      i++
      continue
    }
    if (HR.test(line)) {
      blocks.push({ t: 'hr' })
      i++
      continue
    }
    if (/^\s{0,3}>/.test(line)) {
      const quoted: string[] = []
      while (i < lines.length && /^\s{0,3}>/.test(lines[i] ?? '')) {
        quoted.push((lines[i] ?? '').replace(/^\s{0,3}>\s?/, ''))
        i++
      }
      blocks.push({ t: 'quote', c: parseMarkdown(quoted.join('\n')) })
      continue
    }
    const nextLine = lines[i + 1]
    if (
      line.includes('|') &&
      nextLine !== undefined &&
      TABLE_SEPARATOR.test(nextLine) &&
      nextLine.includes('-')
    ) {
      const head = splitRow(line).map(parseInline)
      const rows: Inline[][][] = []
      i += 2
      while (i < lines.length && (lines[i] ?? '').includes('|') && (lines[i] ?? '').trim()) {
        rows.push(splitRow(lines[i] ?? '').map(parseInline))
        i++
      }
      blocks.push({ t: 'table', head, rows })
      continue
    }
    if (LIST_LINE.test(line)) {
      const items: RawItem[] = []
      while (i < lines.length) {
        const current = lines[i] ?? ''
        const match = LIST_LINE.exec(current)
        if (match) {
          const marker = match[2] ?? '-'
          items.push({
            indent: indentOf(match[1] ?? ''),
            ordered: /\d/.test(marker),
            start: /\d/.test(marker) ? Number.parseInt(marker, 10) : 1,
            text: match[3] ?? '',
          })
          i++
          continue
        }
        const last = items.at(-1)
        if (!current.trim()) {
          // A blank line only continues the list when another item follows.
          const following = lines[i + 1]
          if (following !== undefined && LIST_LINE.test(following)) {
            i++
            continue
          }
          break
        }
        // An indented line without a marker continues the previous item.
        if (last && indentOf(current) > last.indent && !startsBlock(current, undefined)) {
          last.text += `\n${current.trim()}`
          i++
          continue
        }
        break
      }
      const position = { i: 0 }
      while (position.i < items.length) {
        blocks.push(buildList(items, position, items[position.i]?.indent ?? 0))
      }
      continue
    }
    const paragraph: string[] = []
    while (i < lines.length) {
      const current = lines[i] ?? ''
      if (!current.trim()) break
      if (paragraph.length > 0 && startsBlock(current, lines[i + 1])) break
      paragraph.push(current.trim())
      i++
    }
    blocks.push({ t: 'p', c: parseInline(paragraph.join('\n')) })
  }
  return blocks
}
