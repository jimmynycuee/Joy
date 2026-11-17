import type { ProviderKind } from '@joy/core'

/** What the owner is typing a `/` or `@` menu for. `start`..`end` is the text a pick replaces. */
export interface Trigger {
  kind: '/' | '@'
  start: number
  end: number
  query: string
}

/**
 * `/` only opens at the very start of the message (a skill or command applies to the whole message); `@` opens at
 * the start or after a space. The word under the caret, up to the next space, is the query.
 */
export function findTrigger(value: string, caret: number): Trigger | undefined {
  const end = wordEnd(value, caret)
  if (value.startsWith('/') && caret >= 1 && !/\s/.test(value.slice(0, caret)))
    return { kind: '/', start: 0, end, query: value.slice(1, caret) }
  let at = caret - 1
  while (at >= 0 && !/\s/.test(value[at] ?? '')) {
    if (value[at] === '@' && (at === 0 || /\s/.test(value[at - 1] ?? '')))
      return { kind: '@', start: at, end, query: value.slice(at + 1, caret) }
    at--
  }
  return undefined
}

function wordEnd(value: string, caret: number): number {
  let end = caret
  while (end < value.length && !/\s/.test(value[end] ?? '')) end++
  return end
}

/** Replaces the trigger's text with `insert` and a space; returns the new text and where the caret goes. */
export function applyCompletion(
  value: string,
  trigger: Trigger,
  insert: string,
): { value: string; caret: number } {
  const after = value.slice(trigger.end)
  const spaced = after.startsWith(' ') ? insert : `${insert} `
  const next = `${value.slice(0, trigger.start)}${spaced}${after}`
  return { value: next, caret: trigger.start + spaced.length + (after.startsWith(' ') ? 1 : 0) }
}

/** Removes a `/command` the owner ran from the box. */
export function removeTrigger(value: string, trigger: Trigger): string {
  return `${value.slice(0, trigger.start)}${value.slice(trigger.end).replace(/^ /, '')}`
}

export type SkillCli = Extract<ProviderKind, 'claude-cli' | 'codex-cli'>

export interface SkillItem {
  name: string
  description?: string
  cli: SkillCli
  scope: 'user' | 'project'
  kind: 'skill' | 'command'
}

export interface JoyCommand {
  name: string
  label: string
  run: () => void
}

export interface McpItem {
  id: string
  name: string
  enabled: boolean
  repoIds?: string[]
}

export type CompletionItem =
  | { type: 'skill'; key: string; label: string; detail?: string; tag?: string; insert: string }
  | { type: 'command'; key: string; label: string; detail: string; run: () => void }
  | { type: 'file'; key: string; label: string; insert: string }
  | { type: 'mcp'; key: string; label: string; detail: string; insert: string }

const CLI_TAGS: Record<SkillCli, string> = { 'claude-cli': 'Claude', 'codex-cli': 'Codex' }
const MAX_ITEMS = 50

function matches(name: string, query: string): number {
  const lower = name.toLowerCase()
  const needle = query.toLowerCase()
  if (!needle) return 1
  if (lower.startsWith(needle)) return 3
  if (lower.includes(needle)) return 2
  return 0
}

/**
 * The `/` menu: the implementer's skills (when the implementer is a CLI, only that CLI's; otherwise every skill with
 * its CLI named), then Joy's own commands.
 */
export function slashItems(
  query: string,
  skills: readonly SkillItem[],
  commands: readonly JoyCommand[],
  cli: ProviderKind | undefined,
): CompletionItem[] {
  const own = cli === 'claude-cli' || cli === 'codex-cli' ? cli : undefined
  const ranked = skills
    .filter((skill) => !own || skill.cli === own)
    .map((skill) => ({ skill, score: matches(skill.name, query) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))
  const seen = new Set<string>()
  const items: CompletionItem[] = []
  for (const { skill } of ranked) {
    const key = `${skill.cli}:${skill.name}`
    if (seen.has(key)) continue
    seen.add(key)
    items.push({
      type: 'skill',
      key: `skill:${key}`,
      label: `/${skill.name}`,
      ...(skill.description ? { detail: skill.description } : {}),
      ...(own ? {} : { tag: CLI_TAGS[skill.cli] }),
      insert: `/${skill.name}`,
    })
  }
  for (const command of commands) {
    if (!matches(command.name, query)) continue
    items.push({
      type: 'command',
      key: `command:${command.name}`,
      label: `/${command.name}`,
      detail: command.label,
      run: command.run,
    })
  }
  return items.slice(0, MAX_ITEMS)
}

/** The `@` menu: the owner's MCP servers for this project, then files (already ranked by the server). */
export function mentionItems(
  query: string,
  files: readonly string[],
  servers: readonly McpItem[],
  repoId: string | undefined,
): CompletionItem[] {
  const items: CompletionItem[] = servers
    .filter((server) => server.enabled && (!server.repoIds || (repoId && server.repoIds.includes(repoId))))
    .filter((server) => matches(server.name, query) > 0)
    .map((server) => ({
      type: 'mcp' as const,
      key: `mcp:${server.id}`,
      label: `@${server.name}`,
      detail: 'MCP',
      insert: `@${server.name}`,
    }))
  for (const file of files) items.push({ type: 'file', key: `file:${file}`, label: file, insert: file })
  return items.slice(0, MAX_ITEMS)
}
