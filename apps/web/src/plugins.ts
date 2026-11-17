/** An MCP server as Settings lists it; a secret variable is named, never shown. */
export interface McpServer {
  id: string
  name: string
  transport: 'stdio' | 'http'
  command?: string
  args: string[]
  url?: string
  vars: Array<{ name: string; value?: string; secret: boolean }>
  enabled: boolean
  readOnly: boolean
  repoIds?: string[]
}

/**
 * The owner types a command line once; Joy keeps argv (run without a shell). Quotes group words; a backslash escapes a
 * space, quote or backslash (outside single quotes). Throws on an unclosed quote.
 */
export function splitCommandLine(line: string): string[] {
  const out: string[] = []
  let word = ''
  let started = false
  let quote: '"' | "'" | null = null
  for (let index = 0; index < line.length; index++) {
    const char = line[index] ?? ''
    if (quote) {
      if (char === quote) quote = null
      else if (char === '\\' && quote === '"' && index + 1 < line.length) word += line[++index]
      else word += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      started = true
    } else if (char === '\\' && /[\s"'\\]/.test(line[index + 1] ?? '')) {
      // Only before a space, a quote or a backslash, so a Windows path like C:\tools\mcp.exe stays as typed.
      word += line[++index]
      started = true
    } else if (/\s/.test(char)) {
      if (started) out.push(word)
      word = ''
      started = false
    } else {
      word += char
      started = true
    }
  }
  if (quote) throw new Error('引號沒有關上')
  if (started) out.push(word)
  return out
}

/** How a server's command line or URL is shown again. */
export function commandLineOf(server: Pick<McpServer, 'transport' | 'command' | 'args' | 'url'>): string {
  if (server.transport === 'http') return server.url ?? ''
  return [server.command ?? '', ...server.args]
    .map((part) => (part === '' || /[\s"'\\]/.test(part) ? `'${part.replace(/'/g, `'\\''`)}'` : part))
    .join(' ')
}

/** Which projects a server applies to, as one short line. */
export function scopeLabel(server: Pick<McpServer, 'repoIds'>, names: ReadonlyMap<string, string>): string {
  if (!server.repoIds) return '所有專案'
  if (!server.repoIds.length) return '沒有專案'
  return server.repoIds.map((id) => names.get(id) ?? id).join('、')
}
