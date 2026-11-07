// Turns the raw `tool_call` / `tool_result` agent events into the one line a person wants to see: the command that
// ran, the file that changed. Claude Code and Codex name and shape their tools differently, so this is deliberately
// forgiving: it never throws on an unexpected input.

import { record } from './types.js'

export interface ToolSummary {
  kind: 'command' | 'file' | 'search' | 'other'
  /** Short verb for non-command tools, in Traditional Chinese. */
  verb: string
  /** The command, path, pattern or query. Empty when nothing useful was found. */
  detail: string
}

const COMMAND_TOOLS = new Set(['bash', 'shell', 'exec', 'exec_command', 'run_command', 'local_shell'])
const FILE_TOOLS: Record<string, string> = {
  read: '讀取',
  edit: '編輯',
  multiedit: '編輯',
  write: '寫入',
  notebookedit: '編輯筆記本',
  notebookread: '讀取筆記本',
  str_replace_editor: '編輯',
  apply_patch: '套用修改',
}
const SEARCH_TOOLS: Record<string, string> = {
  glob: '找檔案',
  grep: '搜尋',
  websearch: '搜尋網路',
  web_search: '搜尋網路',
  webfetch: '讀取網頁',
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** Removes the worktree prefix so `/Users/me/.joy/worktrees/x/src/a.ts` shows as `src/a.ts`. */
export function relativePath(path: string, root?: string): string {
  if (!root) return path
  const prefix = root.endsWith('/') || root.endsWith('\\') ? root : `${root}/`
  return path.startsWith(prefix) ? path.slice(prefix.length) : path
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function commandText(input: Record<string, unknown> | null): string | undefined {
  const command = input?.command ?? input?.cmd
  if (Array.isArray(command)) {
    const parts = command.filter((part): part is string => typeof part === 'string')
    return parts.length ? parts.join(' ') : undefined
  }
  return text(command)
}

export function summarizeToolCall(name: string, input: unknown, worktreePath?: string): ToolSummary {
  const fields = record(input)
  const key = name.toLowerCase()

  if (COMMAND_TOOLS.has(key)) {
    return { kind: 'command', verb: '執行', detail: commandText(fields) ?? '' }
  }
  const fileVerb = FILE_TOOLS[key]
  if (fileVerb) {
    const path = text(fields?.file_path) ?? text(fields?.notebook_path) ?? text(fields?.path)
    return { kind: 'file', verb: fileVerb, detail: path ? relativePath(path, worktreePath) : '' }
  }
  const searchVerb = SEARCH_TOOLS[key]
  if (searchVerb) {
    const detail =
      text(fields?.pattern) ?? text(fields?.query) ?? text(fields?.url) ?? text(fields?.prompt) ?? ''
    const where = text(fields?.path)
    return {
      kind: 'search',
      verb: searchVerb,
      detail: where && key === 'grep' ? `${detail}  ${relativePath(where, worktreePath)}` : detail,
    }
  }
  if (key === 'task' || key === 'agent') {
    return {
      kind: 'other',
      verb: '交給子 agent',
      detail: text(fields?.description) ?? text(fields?.prompt) ?? '',
    }
  }
  if (key === 'todowrite') return { kind: 'other', verb: '更新待辦清單', detail: '' }

  // Anything else (MCP tools, new tools): show the short name and the first string argument.
  const shortName = key.startsWith('mcp__') ? (name.split('__').at(-1) ?? name) : name
  const firstText = fields
    ? Object.values(fields).find((value) => typeof value === 'string' && value.trim())
    : undefined
  return { kind: 'other', verb: shortName, detail: typeof firstText === 'string' ? firstText : '' }
}

/** One-line label for a tool call: `$ command` for shell tools, else `verb detail`. */
export function toolCallLabel(summary: ToolSummary): string {
  const detail = truncate((summary.detail.split('\n')[0] ?? '').trim(), 200)
  if (summary.kind === 'command') return detail ? `$ ${detail}` : '$'
  return detail ? `${summary.verb} ${detail}` : summary.verb
}

export interface ToolOutput {
  text: string
  truncated: boolean
}

function partsToText(parts: unknown[]): string {
  return parts
    .map((part) => {
      if (typeof part === 'string') return part
      const item = record(part)
      if (typeof item?.text === 'string') return item.text
      return JSON.stringify(part)
    })
    .join('\n')
}

/** The text of a tool result, whatever shape the CLI gave it, cut to `max` characters. */
export function toolOutputText(output: unknown, max = 4000): ToolOutput {
  let value = ''
  if (typeof output === 'string') value = output
  else if (Array.isArray(output)) value = partsToText(output)
  else if (output !== null && output !== undefined) {
    const fields = record(output)
    const parts = [fields?.output, fields?.stdout, fields?.stderr, fields?.content].filter(
      (part): part is string => typeof part === 'string' && part.length > 0,
    )
    const contentList = Array.isArray(fields?.content) ? partsToText(fields.content) : ''
    value = parts.length ? parts.join('\n') : contentList || JSON.stringify(output, null, 2)
  }
  value = value.replace(/\s+$/, '')
  return value.length > max
    ? { text: `${value.slice(0, max)}\n… 已省略 ${value.length - max} 個字元`, truncated: true }
    : { text: value, truncated: false }
}
