import type { AgentProvider, McpServerConfig, ProviderKind, RepoId, RunOptions, Steer } from '@joy/core'
import type { Database, McpServerRecord, NewMcpServer } from '@joy/db'
import {
  assertMcpServerShape,
  createMcpServer,
  deleteMcpServer,
  getMcpServer,
  listMcpServers,
  mcpServersForRepo,
  updateMcpServer,
} from '@joy/db'
import { listProjectFiles } from '@joy/executor'
import type { DiscoveredSkill, SkillSources } from '@joy/providers'
import { discoverSkills, skillInstruction } from '@joy/providers'
import type { SecretStore } from '@joy/secrets'
import { mcpSecretName } from '@joy/secrets'
import { randomBytes, randomUUID } from 'node:crypto'
import { z } from 'zod'

const repoIdSchema = z.string().min(1).max(128)
const varSchema = z.strictObject({
  name: z.string().min(1).max(128),
  value: z.string().max(10_000),
  /** Kept only in the OS keychain. */
  secret: z.boolean().optional(),
})

export const mcpServerInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(64),
  transport: z.enum(['stdio', 'http']),
  command: z.string().trim().min(1).max(4000).optional(),
  args: z.array(z.string().max(4000)).max(64).optional(),
  url: z.string().trim().min(1).max(4000).optional(),
  vars: z.array(varSchema).max(32).optional(),
  enabled: z.boolean().optional(),
  readOnly: z.boolean().optional(),
  repoIds: z.array(repoIdSchema).max(500).nullable().optional(),
})
export type McpServerInput = z.infer<typeof mcpServerInputSchema>

export const mcpServerPatchSchema = z.strictObject({
  enabled: z.boolean().optional(),
  readOnly: z.boolean().optional(),
  repoIds: z.array(repoIdSchema).max(500).nullable().optional(),
})

/** What the settings page sees: a secret is named, never shown. */
export interface McpServerView {
  id: string
  name: string
  transport: 'stdio' | 'http'
  command?: string
  args: string[]
  url?: string
  vars: { name: string; value?: string; secret: boolean }[]
  enabled: boolean
  readOnly: boolean
  repoIds?: string[]
}

export class PluginInputError extends Error {}

export interface PluginServiceOptions {
  db: Database
  secretStore: SecretStore
  userHome: string
  env: SkillSources['env']
  warn: (message: string) => void
}

/** Skills, project files and the owner's MCP servers, for the `/` and `@` menus and Settings. */
export class PluginService {
  constructor(private readonly options: PluginServiceOptions) {}

  skills(projectDir?: string): Promise<DiscoveredSkill[]> {
    return discoverSkills({
      userHome: this.options.userHome,
      ...(projectDir ? { projectDir } : {}),
      env: this.options.env ?? {},
    })
  }

  async files(dir: string, query: string, limit = FILE_RESULTS): Promise<string[]> {
    return rankFiles(await listProjectFiles(dir, MAX_PROJECT_FILES), query, limit)
  }

  listServers(): McpServerView[] {
    return listMcpServers(this.options.db).map(view)
  }

  /** Secret values go to the keychain before the row exists, and are removed again if the row cannot be written. */
  async createServer(input: McpServerInput): Promise<McpServerView> {
    const id = randomUUID()
    const record: NewMcpServer = {
      id,
      name: input.name,
      transport: input.transport,
      ...(input.command !== undefined ? { command: input.command } : {}),
      ...(input.args ? { args: input.args } : {}),
      ...(input.url !== undefined ? { url: input.url } : {}),
      vars: (input.vars ?? []).map((v) => (v.secret ? { name: v.name } : { name: v.name, value: v.value })),
      enabled: input.enabled ?? true,
      readOnly: input.readOnly ?? false,
      ...(input.repoIds ? { repoIds: input.repoIds as RepoId[] } : {}),
    }
    try {
      assertMcpServerShape(record)
    } catch (error) {
      throw new PluginInputError(error instanceof Error ? error.message : String(error))
    }
    const secrets = (input.vars ?? []).filter((v) => v.secret)
    for (const v of secrets)
      if (!v.value.trim()) throw new PluginInputError(`Enter a value for the secret ${v.name}`)
    const stored: string[] = []
    try {
      for (const v of secrets) {
        const name = mcpSecretName(id, v.name)
        await this.options.secretStore.set(name, v.value)
        stored.push(v.name)
      }
      return view(createMcpServer(this.options.db, record))
    } catch (error) {
      await this.forgetSecrets(id, stored)
      if (error instanceof Error && /already exists/.test(error.message))
        throw new PluginInputError(error.message)
      throw error
    }
  }

  updateServer(id: string, patch: z.infer<typeof mcpServerPatchSchema>): McpServerView | undefined {
    if (!getMcpServer(this.options.db, id)) return undefined
    const record = updateMcpServer(this.options.db, id, {
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.readOnly !== undefined ? { readOnly: patch.readOnly } : {}),
      ...(patch.repoIds !== undefined ? { repoIds: patch.repoIds as RepoId[] | null } : {}),
    })
    return record ? view(record) : undefined
  }

  async deleteServer(id: string): Promise<boolean> {
    const record = getMcpServer(this.options.db, id)
    if (!record) return false
    await this.forgetSecrets(
      id,
      record.vars.filter((v) => v.value === undefined).map((v) => v.name),
    )
    return deleteMcpServer(this.options.db, id)
  }

  /** Names of the servers a run in this project gets and the owner marked read-only (for the policy). */
  readOnlyServers(repoId: RepoId): string[] {
    return mcpServersForRepo(this.options.db, repoId)
      .filter((server) => server.readOnly)
      .map((server) => server.name)
  }

  /**
   * The enabled servers for a run in this project, with secrets read from the keychain just now (the SecretStore
   * registers each value with the redactor). A server whose secret is missing is left out with a warning instead of
   * starting without it.
   */
  async runConfigs(repoId: RepoId): Promise<McpServerConfig[]> {
    const out: McpServerConfig[] = []
    for (const server of mcpServersForRepo(this.options.db, repoId)) {
      const values: Record<string, string> = {}
      let missing: string | undefined
      for (const v of server.vars) {
        const value = v.value ?? (await this.options.secretStore.get(mcpSecretName(server.id, v.name)))
        if (value === null || value === undefined) {
          missing = v.name
          break
        }
        values[v.name] = value
      }
      if (missing) {
        this.options.warn(
          `MCP server ${server.name} was left out: its secret ${missing} is not in the keychain`,
        )
        continue
      }
      const vars = Object.keys(values).length ? values : undefined
      out.push(
        server.transport === 'stdio'
          ? {
              name: server.name,
              transport: 'stdio',
              command: server.command ?? '',
              args: server.args,
              ...(vars ? { env: vars } : {}),
              approval: 'every-call',
            }
          : {
              name: server.name,
              transport: 'http',
              url: server.url ?? '',
              ...(vars ? { headers: vars } : {}),
              approval: 'every-call',
            },
      )
    }
    return out
  }

  private async forgetSecrets(id: string, names: readonly string[]): Promise<void> {
    for (const name of names) {
      try {
        await this.options.secretStore.delete(mcpSecretName(id, name))
      } catch (error) {
        this.options.warn(
          `Could not remove the keychain entry for ${name}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
  }
}

function view(record: McpServerRecord): McpServerView {
  return {
    id: record.id,
    name: record.name,
    transport: record.transport,
    ...(record.command !== undefined ? { command: record.command } : {}),
    args: record.args,
    ...(record.url !== undefined ? { url: record.url } : {}),
    vars: record.vars.map((v) =>
      v.value === undefined
        ? { name: v.name, secret: true }
        : { name: v.name, value: v.value, secret: false },
    ),
    enabled: record.enabled,
    readOnly: record.readOnly,
    ...(record.repoIds ? { repoIds: record.repoIds } : {}),
  }
}

/** The `@` menu shows this many files. */
export const FILE_RESULTS = 50
/** Files read from git per request; a bigger repository is searched in its first this many. */
const MAX_PROJECT_FILES = 20_000

/**
 * Fuzzy file search: a match in the file name beats one in the folders, a contiguous match beats letters in order,
 * and shorter paths win ties. No query: the first files in git's order.
 */
export function rankFiles(files: readonly string[], query: string, limit = FILE_RESULTS): string[] {
  const needle = query.trim().toLowerCase().replace(/\\/g, '/')
  if (!needle) return files.slice(0, limit)
  const scored: { path: string; score: number }[] = []
  for (const path of files) {
    const lower = path.toLowerCase()
    const base = lower.slice(lower.lastIndexOf('/') + 1)
    let score: number
    if (base.startsWith(needle)) score = 4
    else if (base.includes(needle)) score = 3
    else if (lower.includes(needle)) score = 2
    else if (inOrder(lower, needle)) score = 1
    else continue
    scored.push({ path, score })
  }
  scored.sort((a, b) => b.score - a.score || a.path.length - b.path.length || a.path.localeCompare(b.path))
  return scored.slice(0, limit).map((entry) => entry.path)
}

function inOrder(text: string, needle: string): boolean {
  let at = 0
  for (const char of needle) {
    at = text.indexOf(char, at)
    if (at < 0) return false
    at++
  }
  return true
}

/** A message that starts with `/name` (then a space or the end) invokes a skill. */
const SKILL_INVOCATION = /^\/([A-Za-z0-9][A-Za-z0-9._:-]{0,63})(?=\s|$)/

/**
 * Skill invocations in the owner's own words become markers in the prompt; the run's wrapper (`withPlugins`) turns
 * each into what that run's CLI understands. The nonce keeps text from elsewhere (an attached file, an issue) from
 * forging one. The owner's message is stored as typed; only the prompt carries the marker.
 */
export class SkillMarkers {
  private readonly nonce = randomBytes(12).toString('hex')

  mark(text: string): string {
    const match = SKILL_INVOCATION.exec(text)
    if (!match) return text
    return `${this.marker(match[1] ?? '')}${text.slice(match[0].length)}`
  }

  /** The marker for `name`, or the original `/name` when this CLI has no such skill. */
  expand(prompt: string, kind: ProviderKind, skills: readonly DiscoveredSkill[]): string {
    return prompt.replace(this.pattern(), (_whole, name: string) => {
      const skill = skills.find((s) => s.cli === kind && s.name === name)
      return skill ? `${skillInstruction(skill)}\n` : `/${name}`
    })
  }

  has(prompt: string): boolean {
    return this.pattern().test(prompt)
  }

  private marker(name: string): string {
    return `⟦joy-skill:${this.nonce}:${name}⟧`
  }

  private pattern(): RegExp {
    return new RegExp(`⟦joy-skill:${this.nonce}:([A-Za-z0-9][A-Za-z0-9._:-]{0,63})⟧`, 'g')
  }
}

export interface PluginRunContext {
  repoId: RepoId
  projectDir: string
  /** Owner-added MCP servers cannot reach the inside of an agent container. */
  container: boolean
}

/**
 * Per run: expands skill markers for this CLI (in the prompt and in later steering) and, for a run that carries
 * Joy's Tool Hub (an implementer, which has an approval channel), adds the owner's enabled MCP servers. Runs without
 * the hub (plans, reviews, peers, pre-reviews) get none: nobody could approve their tool calls.
 */
export function withPlugins(
  inner: AgentProvider,
  plugins: PluginService,
  markers: SkillMarkers,
  context: () => PluginRunContext | undefined,
  toolHubName: string,
): AgentProvider {
  return {
    kind: inner.kind,
    capabilities: inner.capabilities,
    healthCheck: () => inner.healthCheck(),
    run(opts, model) {
      return (async function* () {
        const run = context()
        // Skill folders are read only when the owner actually invoked one (lazily, once per run).
        let skills: Promise<DiscoveredSkill[]> | undefined
        const expand = async (text: string) =>
          markers.has(text)
            ? markers.expand(text, inner.kind, await (skills ??= plugins.skills(run?.projectDir)))
            : text
        const managed =
          run && !run.container && opts.mcpServers?.some((server) => server.name === toolHubName)
            ? await plugins.runConfigs(run.repoId)
            : []
        const next: RunOptions = {
          ...opts,
          prompt: await expand(opts.prompt),
          ...(managed.length ? { mcpServers: [...(opts.mcpServers ?? []), ...managed] } : {}),
          ...(opts.onSteer ? { onSteer: wrapSteer(opts.onSteer, expand) } : {}),
        }
        yield* inner.run(next, model)
      })()
    },
  }
}

function wrapSteer(
  onSteer: NonNullable<RunOptions['onSteer']>,
  expand: (text: string) => Promise<string>,
): NonNullable<RunOptions['onSteer']> {
  return (steer) => {
    if (!steer) return onSteer(undefined)
    const wrapped: Steer = async (text, images) => steer(await expand(text), images)
    onSteer(wrapped)
  }
}
