import type { ProviderKind } from '@joy/core'
import { open, readdir, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'

/**
 * Skills and slash commands each CLI loads by itself, found where its docs say (see docs/spikes/claude-code.md and
 * codex.md, "Skills"). Only the frontmatter (`name`, `description`) is read: never the body, never a secrets folder.
 */
export interface DiscoveredSkill {
  name: string
  description?: string
  cli: Extract<ProviderKind, 'claude-cli' | 'codex-cli'>
  scope: 'user' | 'project'
  /** A skill folder (`<dir>/SKILL.md`) or a Claude Code custom command (`commands/<name>.md`). */
  kind: 'skill' | 'command'
  /** The SKILL.md or command file. */
  path: string
}

export interface SkillSources {
  /** The user's home directory (tests pass a temp directory). */
  userHome: string
  /** The project's checkout, for project skills. */
  projectDir?: string
  /** `CLAUDE_CONFIG_DIR` and `CODEX_HOME`, which move the CLIs' own folders. */
  env?: { CLAUDE_CONFIG_DIR?: string | undefined; CODEX_HOME?: string | undefined }
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/
/** Per folder: more than this is not a list anyone picks from. */
const MAX_PER_SOURCE = 200
/** Frontmatter sits at the top; nothing past this is read. */
const HEAD_BYTES = 16 * 1024
const MAX_DESCRIPTION = 300

interface Source {
  cli: DiscoveredSkill['cli']
  scope: DiscoveredSkill['scope']
  kind: DiscoveredSkill['kind']
  dir: string
}

function sources({ userHome, projectDir, env = {} }: SkillSources): Source[] {
  const claudeHome = env.CLAUDE_CONFIG_DIR?.trim() || join(userHome, '.claude')
  const codexHome = env.CODEX_HOME?.trim() || join(userHome, '.codex')
  return [
    // Claude Code: ~/.claude/skills/<name>/SKILL.md, .claude/skills in the project, and custom commands (*.md).
    { cli: 'claude-cli', scope: 'user', kind: 'skill', dir: join(claudeHome, 'skills') },
    ...(projectDir
      ? [
          {
            cli: 'claude-cli',
            scope: 'project',
            kind: 'skill',
            dir: join(projectDir, '.claude', 'skills'),
          } as const,
        ]
      : []),
    { cli: 'claude-cli', scope: 'user', kind: 'command', dir: join(claudeHome, 'commands') },
    ...(projectDir
      ? [
          {
            cli: 'claude-cli',
            scope: 'project',
            kind: 'command',
            dir: join(projectDir, '.claude', 'commands'),
          } as const,
        ]
      : []),
    // Codex: .agents/skills in the repository and the home folder, plus the older $CODEX_HOME/skills. Custom prompts
    // (~/.codex/prompts) only expand in the interactive TUI, not in app-server or exec, so they are not listed.
    ...(projectDir
      ? [
          {
            cli: 'codex-cli',
            scope: 'project',
            kind: 'skill',
            dir: join(projectDir, '.agents', 'skills'),
          } as const,
        ]
      : []),
    { cli: 'codex-cli', scope: 'user', kind: 'skill', dir: join(userHome, '.agents', 'skills') },
    { cli: 'codex-cli', scope: 'user', kind: 'skill', dir: join(codexHome, 'skills') },
  ]
}

/** Every skill and command found; a name already found for the same CLI keeps its first place. */
export async function discoverSkills(input: SkillSources): Promise<DiscoveredSkill[]> {
  const found: DiscoveredSkill[] = []
  const seen = new Set<string>()
  for (const source of sources(input)) {
    for (const skill of await readSource(source)) {
      const key = `${skill.cli}:${skill.name}`
      if (seen.has(key)) continue
      seen.add(key)
      found.push(skill)
    }
  }
  return found
}

async function readSource(source: Source): Promise<DiscoveredSkill[]> {
  const files = source.kind === 'skill' ? await skillFiles(source.dir) : await commandFiles(source.dir, 0)
  const out: DiscoveredSkill[] = []
  for (const file of files.slice(0, MAX_PER_SOURCE)) {
    const front = await frontmatter(file.path)
    if (!front) continue
    const name = front.name ?? file.fallbackName
    if (!NAME.test(name)) continue
    out.push({
      name,
      ...(front.description ? { description: front.description.slice(0, MAX_DESCRIPTION) } : {}),
      cli: source.cli,
      scope: source.scope,
      kind: source.kind,
      path: file.path,
    })
  }
  return out
}

async function entries(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((name) => !name.startsWith('.')).sort()
  } catch {
    return []
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    return info.isFile() && info.size > 0
  } catch {
    return false
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

async function skillFiles(dir: string): Promise<{ path: string; fallbackName: string }[]> {
  const out: { path: string; fallbackName: string }[] = []
  for (const name of await entries(dir)) {
    if (out.length >= MAX_PER_SOURCE) break
    const path = join(dir, name, 'SKILL.md')
    if (await isFile(path)) out.push({ path, fallbackName: name })
  }
  return out
}

/** Claude Code commands may sit in subfolders (for grouping); the command is still named after its file. */
async function commandFiles(dir: string, depth: number): Promise<{ path: string; fallbackName: string }[]> {
  const out: { path: string; fallbackName: string }[] = []
  for (const name of await entries(dir)) {
    if (out.length >= MAX_PER_SOURCE) break
    const path = join(dir, name)
    if (extname(name) === '.md' && (await isFile(path)))
      out.push({ path, fallbackName: basename(name, '.md') })
    else if (depth < 2 && (await isDirectory(path))) out.push(...(await commandFiles(path, depth + 1)))
  }
  return out
}

/** Reads only the top of the file and returns its frontmatter's name and description (undefined if unreadable). */
async function frontmatter(path: string): Promise<{ name?: string; description?: string } | undefined> {
  let head: string
  try {
    const handle = await open(path, 'r')
    try {
      const buffer = Buffer.alloc(HEAD_BYTES)
      const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0)
      head = buffer.subarray(0, bytesRead).toString('utf8')
    } finally {
      await handle.close()
    }
  } catch {
    return undefined
  }
  return parseFrontmatter(head)
}

/**
 * The YAML subset skills use for these two keys: plain, quoted, and folded/literal block scalars. A file without
 * frontmatter (allowed for commands) gives `{}`.
 */
export function parseFrontmatter(text: string): { name?: string; description?: string } {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return {}
  const end = lines.findIndex((line, index) => index > 0 && /^(---|\.\.\.)\s*$/.test(line))
  if (end < 0) return {}
  const out: { name?: string; description?: string } = {}
  for (let index = 1; index < end; index++) {
    const match = /^(name|description):(.*)$/.exec(lines[index] ?? '')
    if (!match) continue
    const key = match[1] as 'name' | 'description'
    const raw = (match[2] ?? '').trim()
    let value: string
    if (/^[>|][+-]?$/.test(raw)) {
      const block: string[] = []
      while (index + 1 < end && /^(\s+|$)/.test(lines[index + 1] ?? ''))
        block.push((lines[++index] ?? '').trim())
      value = raw.startsWith('>') ? block.filter(Boolean).join(' ') : block.join('\n').trim()
    } else value = unquote(raw)
    value = value.replace(/\s+/g, ' ').trim()
    if (value) out[key] = value
  }
  return out
}

function unquote(raw: string): string {
  if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
    try {
      return JSON.parse(raw) as string
    } catch {
      return raw.slice(1, -1)
    }
  }
  if (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2) return raw.slice(1, -1).replace(/''/g, "'")
  // A trailing comment is not part of a plain scalar.
  return raw.replace(/\s+#.*$/, '')
}

/**
 * What the agent is told when the owner starts a message with `/name`. Joy's prompt wraps the owner's words (task
 * brief, project instructions, attachments), so a leading `/name` never reaches the CLI as a slash command; each CLI
 * gets the way it loads skills by itself instead:
 * - Claude Code: the Skill tool (it lists the user's and the project's skills and commands).
 * - Codex: `$name` is how a skill is mentioned; the path lets it open the SKILL.md even if it was not preloaded.
 * Neither was checked against the real CLI yet (docs/STATUS.md).
 */
export function skillInstruction(skill: Pick<DiscoveredSkill, 'name' | 'cli' | 'kind' | 'path'>): string {
  if (skill.cli === 'claude-cli')
    return skill.kind === 'command'
      ? `The owner invoked the /${skill.name} command for this message: run it (Skill tool, "${skill.name}") and follow it.`
      : `The owner invoked the "${skill.name}" skill for this message: load it with the Skill tool and follow it.`
  return `The owner invoked the $${skill.name} skill for this message: follow its instructions in ${skill.path}.`
}
