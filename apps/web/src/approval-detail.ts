import { record } from './types.js'

export interface ApprovalTarget {
  /** What the text is: 指令, 檔案, 目錄, 網址 or 搜尋. */
  label: string
  text: string
  /** Where a command runs, when the request says. */
  cwd?: string
}

const MAX_CHARS = 4_000

function clip(text: string): string {
  return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}…` : text
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/**
 * The command, file or address an approval is about, read from the action's detail (the agent's tool input or the
 * Codex request), so the owner sees `rm -rf ../x` instead of only "Claude requested the Bash tool."
 */
export function approvalTarget(detail: unknown): ApprovalTarget | undefined {
  const item = record(detail)
  if (!item) return undefined
  const cwd = str(item.cwd)
  const command = Array.isArray(item.command)
    ? item.command.filter((part): part is string => typeof part === 'string').join(' ')
    : str(item.command)
  if (command) return { label: '指令', text: clip(command), ...(cwd ? { cwd } : {}) }
  const file = str(item.file_path) ?? str(item.filePath) ?? str(item.notebook_path) ?? str(item.path)
  if (file) return { label: '檔案', text: clip(file) }
  const root = str(item.grantRoot)
  if (root) return { label: '目錄', text: clip(root) }
  const url = str(item.url)
  if (url) return { label: '網址', text: clip(url) }
  const query = str(item.query)
  if (query) return { label: '搜尋', text: clip(query) }
  return undefined
}
