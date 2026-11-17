import type { AgentEvent, AgentProvider, RepoId, RunOptions, Steer } from '@joy/core'
import { openDatabase } from '@joy/db'
import type { DiscoveredSkill } from '@joy/providers'
import { MemoryBackend, SecretStore } from '@joy/secrets'
import { describe, expect, it } from 'vitest'
import { PluginService, rankFiles, SkillMarkers, withPlugins } from './plugins.js'

const skills: DiscoveredSkill[] = [
  {
    name: 'review',
    cli: 'claude-cli',
    scope: 'user',
    kind: 'skill',
    path: '/h/.claude/skills/review/SKILL.md',
  },
  {
    name: 'deploy',
    cli: 'codex-cli',
    scope: 'project',
    kind: 'skill',
    path: '/p/.agents/skills/deploy/SKILL.md',
  },
]

describe('rankFiles', () => {
  const files = [
    'src/auth/login.ts',
    'docs/login-flow.md',
    'src/logic.ts',
    'README.md',
    'src/legacy/old_login.ts',
  ]
  it('puts file-name matches first, then folder matches, then letters in order; shorter paths win ties', () => {
    expect(rankFiles(files, 'login')).toEqual([
      'src/auth/login.ts',
      'docs/login-flow.md',
      'src/legacy/old_login.ts',
    ])
    expect(rankFiles(files, 'auth')).toEqual(['src/auth/login.ts'])
    expect(rankFiles(files, 'lgc')).toEqual(['src/logic.ts', 'src/legacy/old_login.ts'])
    expect(rankFiles(files, 'SRC\\AUTH')).toEqual(['src/auth/login.ts'])
    expect(rankFiles(files, '', 2)).toEqual(['src/auth/login.ts', 'docs/login-flow.md'])
    expect(rankFiles(files, 'zzz')).toEqual([])
  })
})

describe('SkillMarkers', () => {
  it('marks only a leading /name and expands it per CLI', () => {
    const markers = new SkillMarkers()
    const marked = markers.mark('/review the auth flow')
    expect(marked).not.toContain('/review')
    expect(markers.has(marked)).toBe(true)
    expect(markers.expand(marked, 'claude-cli', skills)).toMatch(
      /^The owner invoked the "review" skill.*\n the auth flow$/,
    )
    // Codex has no `review`: the owner's text comes back as typed.
    expect(markers.expand(marked, 'codex-cli', skills)).toBe('/review the auth flow')
    expect(markers.expand(markers.mark('/deploy'), 'codex-cli', skills)).toContain('$deploy')
    for (const text of ['no slash', ' /review indented', '/tmp/file.txt is big', 'see /review', '/'])
      expect(markers.mark(text)).toBe(text)
  })

  it("does not expand another instance's marker (forged or stale)", () => {
    const one = new SkillMarkers()
    const other = new SkillMarkers()
    const forged = one.mark('/review x')
    expect(other.has(forged)).toBe(false)
    expect(other.expand(forged, 'claude-cli', skills)).toBe(forged)
  })
})

describe('withPlugins', () => {
  function setup(projectDir = '/nowhere') {
    const db = openDatabase(':memory:')
    const plugins = new PluginService({
      db,
      secretStore: new SecretStore({ backend: new MemoryBackend(), env: {} }),
      userHome: '/nowhere-home',
      env: {},
      warn: () => {},
    })
    const seen: RunOptions[] = []
    const steered: string[] = []
    const inner: AgentProvider = {
      kind: 'claude-cli',
      capabilities: {
        codeEdit: true,
        tools: true,
        resume: true,
        presetSessionId: false,
        delegatedApproval: true,
        quotaEvents: false,
        structuredOutput: true,
      },
      async *run(options): AsyncGenerator<AgentEvent> {
        seen.push(options)
        const raw: Steer = async (text) => {
          steered.push(text)
          return true
        }
        options.onSteer?.(raw)
        yield { type: 'done', sessionId: 's', isError: false }
      },
      healthCheck: async () => ({ ok: true, installed: true, loggedIn: true as const }),
    }
    const markers = new SkillMarkers()
    const wrapped = withPlugins(
      inner,
      plugins,
      markers,
      () => ({ repoId: 'r1' as RepoId, projectDir, container: false }),
      'joy',
    )
    return { wrapped, seen, steered, markers, db }
  }
  const base = (extra: Partial<RunOptions> = {}): RunOptions => ({
    cwd: '/w',
    prompt: 'Do it',
    autonomy: 'workspace-write',
    signal: new AbortController().signal,
    ...extra,
  })
  const model = { provider: 'claude-cli', model: 'haiku' } as const

  it('expands markers in steering too, and adds nothing to a run without the Tool Hub', async () => {
    const { wrapped, seen, steered, markers } = setup()
    let steer: Steer | undefined
    for await (const event of wrapped.run(
      base({ prompt: 'Plain', onSteer: (s) => (steer = s ?? steer) }),
      model,
    ))
      void event
    expect(seen[0]?.prompt).toBe('Plain')
    expect(seen[0]?.mcpServers).toBeUndefined()
    await steer?.(markers.mark('/unknown thing'))
    expect(steered).toEqual(['/unknown thing'])
  })
})
