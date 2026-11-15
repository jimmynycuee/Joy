import { afterEach, describe, expect, it } from 'vitest'
import type { AttemptId, RepoId, TaskId } from '@joy/core'
import { migrate, openDatabase } from './database.js'
import { MIGRATIONS } from './migrations.js'
import type { Database } from './database.js'
import {
  addUsage,
  appendTaskEvent,
  appendTaskFailureEvent,
  createAttempt,
  createRepo,
  createReview,
  createTask,
  getAttempt,
  getRepo,
  getTask,
  interruptRunningWork,
  latestAttempt,
  listAttempts,
  listRepos,
  listReviews,
  listTaskEvents,
  listTasks,
  listUsage,
  MAX_PROJECT_INSTRUCTIONS,
  REPO_COLORS,
  setTaskStatus,
  updateAttempt,
  updateRepoCheckCommand,
  updateRepoColor,
  updateRepoDefaults,
  updateRepoInstallCommand,
  updateRepoInstructions,
  updateRepoMaxPermissionMode,
  updateTask,
  updateTaskSettings,
} from './repositories.js'

const databases: Database[] = []
function fresh() {
  const db = openDatabase(':memory:')
  databases.push(db)
  return db
}
afterEach(() => {
  for (const db of databases.splice(0)) if (db.isOpen) db.close()
})

const rid = (id: string) => id as RepoId
const tid = (id: string) => id as TaskId
const aid = (id: string) => id as AttemptId

function seed(db: Database) {
  const repo = createRepo(db, {
    id: rid('r1'),
    path: '/repo',
    defaultBranch: 'main',
    githubRemote: 'https://example/repo',
  })
  const task = createTask(db, {
    id: tid('t1'),
    repoId: repo.id,
    title: 'Fix bug',
    prompt: 'Fix it',
    mode: 'review_loop',
    roleOverrides: { implementer: { provider: 'claude-cli', model: 'haiku' } },
    planFirst: true,
    maxRounds: 4,
  })
  return { repo, task }
}

describe('repositories', () => {
  it('creates and lists repositories and tasks with their typed configuration', () => {
    const db = fresh()
    const { repo, task } = seed(db)
    expect(getRepo(db, rid('r1'))).toEqual(repo)
    expect(listRepos(db)).toEqual([repo])
    expect(repo.allowedProviders).toEqual(['openai-api', 'claude-cli', 'codex-cli'])
    expect(getTask(db, task.id)).toEqual(task)
    expect(listTasks(db)).toEqual([task])
    expect(task.roleOverrides.implementer).toEqual({ provider: 'claude-cli', model: 'haiku' })
    expect(task.planFirst).toBe(true)
    expect(task.maxRounds).toBe(4)
  })

  it('persists repository-specific provider allowlists', () => {
    const db = fresh()
    const repo = createRepo(db, {
      id: rid('restricted'),
      path: '/restricted',
      defaultBranch: 'main',
      allowedProviders: ['claude-cli'],
    })
    expect(repo.allowedProviders).toEqual(['claude-cli'])
    expect(getRepo(db, repo.id)).toEqual(repo)
  })

  it('fails closed when a legacy corrupt repository appears in a repository list', () => {
    const db = openDatabase(':memory:', { migrations: MIGRATIONS.slice(0, 2) })
    databases.push(db)
    db.prepare("INSERT INTO repos (id, path, default_branch) VALUES ('valid', '/valid', 'main')").run()
    db.prepare('INSERT INTO repos (id, path, default_branch, allowed_providers) VALUES (?, ?, ?, ?)').run(
      'corrupt',
      '/corrupt',
      'main',
      '{"provider":"claude-cli"}',
    )

    expect(() => listRepos(db)).toThrow(/allowlist/i)
  })

  it.each([
    { stored: {}, reason: 'array' },
    { stored: [], reason: 'at least one' },
    { stored: ['unknown'], reason: 'provider' },
    { stored: ['claude-cli', 'claude-cli'], reason: 'unique' },
  ])('rejects invalid legacy persisted allowlist values ($reason)', ({ stored }) => {
    const db = openDatabase(':memory:', { migrations: MIGRATIONS.slice(0, 2) })
    databases.push(db)
    db.prepare('INSERT INTO repos (id, path, default_branch, allowed_providers) VALUES (?, ?, ?, ?)').run(
      'legacy-invalid',
      '/legacy-invalid',
      'main',
      JSON.stringify(stored),
    )

    expect(() => getRepo(db, rid('legacy-invalid'))).toThrow(/allowlist/i)
  })

  it('persists attempt workspaces, sessions and status updates', () => {
    const db = fresh()
    const { task } = seed(db)
    const attempt = createAttempt(db, {
      id: aid('a1'),
      taskId: task.id,
      provider: 'claude-cli',
      model: 'haiku',
      status: 'preparing',
    })
    updateAttempt(db, attempt.id, {
      worktreePath: '/tmp/joy-worktree',
      branch: 'joy/t1/a1',
      baseCommit: 'a'.repeat(40),
      sessionId: 'session-1',
      status: 'running',
      diffStats: { files: 2 },
    })
    expect(getAttempt(db, attempt.id)).toMatchObject({
      id: attempt.id,
      taskId: attempt.taskId,
      provider: attempt.provider,
      model: attempt.model,
      worktreePath: '/tmp/joy-worktree',
      branch: 'joy/t1/a1',
      baseCommit: 'a'.repeat(40),
      sessionId: 'session-1',
      status: 'running',
      diffStats: { files: 2 },
    })
    expect(listAttempts(db, task.id)).toHaveLength(1)
    expect(latestAttempt(db, task.id)?.id).toBe(attempt.id)
    setTaskStatus(db, task.id, 'running')
    expect(getTask(db, task.id)?.status).toBe('running')
  })

  it('persists task-level failure events without inventing an attempt', () => {
    const db = fresh()
    const { task } = seed(db)
    const blocked = appendTaskFailureEvent(db, task.id, 'Provider is not allowed')
    const attempt = createAttempt(db, {
      id: aid('after-blocked'),
      taskId: task.id,
      provider: 'claude-cli',
      model: 'haiku',
      status: 'running',
    })
    const started = appendTaskEvent(db, attempt.id, 'started', { attemptId: attempt.id })

    expect(blocked).toMatchObject({
      taskId: task.id,
      seq: 1,
      type: 'error',
      payload: { message: 'Provider is not allowed' },
    })
    expect(blocked).not.toHaveProperty('attemptId')
    expect(started.seq).toBe(2)
    expect(listTaskEvents(db, task.id)).toEqual([blocked, started])
  })

  it('persists task-ordered events, reviews, and additive daily usage', () => {
    const db = fresh()
    const { task } = seed(db)
    const first = createAttempt(db, {
      id: aid('a1'),
      taskId: task.id,
      provider: 'claude-cli',
      model: 'haiku',
      status: 'running',
    })
    const second = createAttempt(db, {
      id: aid('a2'),
      taskId: task.id,
      provider: 'codex-cli',
      model: 'gpt-6-luna',
      status: 'running',
    })
    expect(appendTaskEvent(db, first.id, 'message', { text: 'started' }).seq).toBe(1)
    expect(appendTaskEvent(db, second.id, 'review', { approve: false }).seq).toBe(2)
    expect(appendTaskEvent(db, first.id, 'done', { ok: true }).seq).toBe(3)
    expect(listTaskEvents(db, task.id, 1).map(({ seq }) => seq)).toEqual([2, 3])

    createReview(db, {
      id: 'review-1',
      attemptId: first.id,
      reviewerProvider: 'codex-cli',
      reviewerModel: 'gpt-6-luna',
      round: 1,
      approve: false,
      summary: 'One issue',
      findings: [{ severity: 'major', message: 'Handle the empty input' }],
    })
    expect(listReviews(db, first.id)).toMatchObject([
      { approve: false, summary: 'One issue', findings: [{ severity: 'major' }] },
    ])
    createReview(db, {
      id: 'review-1-replayed',
      attemptId: first.id,
      reviewerProvider: 'codex-cli',
      reviewerModel: 'gpt-6-luna',
      round: 1,
      approve: true,
      summary: 'Replayed review',
      findings: [],
    })
    expect(listReviews(db, first.id)).toMatchObject([{ approve: true, summary: 'Replayed review' }])
    expect(listReviews(db, first.id)).toHaveLength(1)

    addUsage(db, { provider: 'openai-api', day: '2026-11-03', inputTokens: 10, costUsd: 0.2 })
    addUsage(db, { provider: 'openai-api', day: '2026-11-03', outputTokens: 4, rateLimitHits: 1 })
    addUsage(db, { provider: 'claude-cli', day: '2026-11-03', inputTokens: 7 })
    expect(listUsage(db)).toEqual([
      {
        provider: 'claude-cli',
        day: '2026-11-03',
        inputTokens: 7,
        outputTokens: 0,
        costUsd: 0,
        rateLimitHits: 0,
      },
      {
        provider: 'openai-api',
        day: '2026-11-03',
        inputTokens: 10,
        outputTokens: 4,
        costUsd: 0.2,
        rateLimitHits: 1,
      },
    ])
  })

  it('marks interrupted work failed without deleting resume checkpoints', () => {
    const db = fresh()
    const { task } = seed(db)
    const attempt = createAttempt(db, {
      id: aid('a1'),
      taskId: task.id,
      provider: 'claude-cli',
      model: 'haiku',
      status: 'running',
    })
    updateAttempt(db, attempt.id, {
      worktreePath: '/tmp/joy-worktree',
      branch: 'joy/t1/a1',
      baseCommit: 'a'.repeat(40),
      sessionId: 'session-1',
    })
    setTaskStatus(db, task.id, 'running')

    expect(interruptRunningWork(db)).toEqual([task.id])
    expect(getTask(db, task.id)?.status).toBe('failed')
    expect(getAttempt(db, attempt.id)).toMatchObject({
      status: 'failed',
      worktreePath: '/tmp/joy-worktree',
      sessionId: 'session-1',
    })
  })
})

describe('task rename and archive', () => {
  it('renames, archives and filters archived tasks out of the list on request', () => {
    const db = fresh()
    const { task } = seed(db)
    expect(task.archived).toBe(false)
    const renamed = updateTask(db, task.id, { title: 'Better title' })
    expect(renamed).toMatchObject({ title: 'Better title', archived: false })
    expect(updateTask(db, task.id, { archived: true })).toMatchObject({ archived: true })
    expect(listTasks(db).map((t) => t.id)).toEqual([task.id])
    expect(listTasks(db, { archived: false })).toEqual([])
    expect(listTasks(db, { archived: true }).map((t) => t.id)).toEqual([task.id])
    expect(updateTask(db, tid('missing'), { title: 'x' })).toBeUndefined()
    expect(() => db.prepare('UPDATE tasks SET archived = 2').run()).toThrow()
  })

  it('replaces the prompt and keeps the title', () => {
    const db = fresh()
    const { task } = seed(db)
    expect(updateTask(db, task.id, { prompt: 'Rewritten request' })).toMatchObject({
      prompt: 'Rewritten request',
      title: task.title,
    })
  })
})

describe('task settings', () => {
  it('changes the mode, models and permission mode and leaves the rest alone', () => {
    const db = fresh()
    const { task } = seed(db)
    const roleOverrides = {
      implementer: { provider: 'codex-cli' as const, model: 'gpt-6', effort: 'high' as const },
    }
    const updated = updateTaskSettings(db, task.id, { mode: 'single', roleOverrides, permissionMode: 'auto' })
    expect(updated).toMatchObject({
      mode: 'single',
      roleOverrides,
      permissionMode: 'auto',
      title: task.title,
    })
    expect(updateTaskSettings(db, task.id, { mode: 'review_loop' })).toMatchObject({
      mode: 'review_loop',
      roleOverrides,
      permissionMode: 'auto',
    })
    expect(updateTaskSettings(db, task.id, {})).toMatchObject({ mode: 'review_loop' })
    expect(updateTaskSettings(db, tid('missing'), { mode: 'single' })).toBeUndefined()
  })

  it('refuses compete and unknown permission modes', () => {
    const db = fresh()
    const { task } = seed(db)
    expect(() => updateTaskSettings(db, task.id, { mode: 'compete' as never })).toThrow('cannot switch')
    expect(() => updateTaskSettings(db, task.id, { permissionMode: 'root' as never })).toThrow(
      'Invalid permission mode',
    )
    expect(getTask(db, task.id)?.mode).toBe(task.mode)
  })
})

describe('repository check command', () => {
  it('stores, clears and validates the argv', () => {
    const db = fresh()
    const { repo } = seed(db)
    expect(repo.checkCommand).toBeUndefined()
    expect(updateRepoCheckCommand(db, repo.id, ['pnpm', 'check'])?.checkCommand).toEqual(['pnpm', 'check'])
    expect(updateRepoCheckCommand(db, repo.id, null)?.checkCommand).toBeUndefined()
    expect(() => updateRepoCheckCommand(db, repo.id, [])).toThrow('Invalid check command')
    expect(() => db.prepare('UPDATE repos SET check_command = \'"pnpm check"\'').run()).toThrow()
  })
})

describe('repository colour', () => {
  it('starts automatic, stores one of the six ids, and clears back to automatic', () => {
    const db = fresh()
    const { repo } = seed(db)
    expect(repo.color).toBeUndefined()
    // The table's CHECK and the exported list say the same six ids.
    for (const id of REPO_COLORS) {
      expect(updateRepoColor(db, repo.id, id)?.color).toBe(id)
      db.prepare('UPDATE repos SET color = ? WHERE id = ?').run(id, repo.id)
    }
    expect(REPO_COLORS).toHaveLength(6)
    expect(updateRepoColor(db, repo.id, 'purple')?.color).toBe('purple')
    expect(getRepo(db, repo.id)?.color).toBe('purple')
    expect(updateRepoColor(db, repo.id, null)?.color).toBeUndefined()
  })

  it('refuses anything else, in code and in the table', () => {
    const db = fresh()
    const { repo } = seed(db)
    // @ts-expect-error not one of the six ids
    expect(() => updateRepoColor(db, repo.id, 'red')).toThrow('Invalid project colour')
    expect(() => db.prepare("UPDATE repos SET color = '#7C93B5'").run()).toThrow()
    expect(() => db.prepare("UPDATE repos SET color = ''").run()).toThrow()
    expect(getRepo(db, repo.id)?.color).toBeUndefined()
  })

  it('keeps repos in the order they were added, which is what the automatic colour follows', () => {
    const db = fresh()
    for (const [id, path] of [
      ['b', '/tmp/b'],
      ['a', '/tmp/a'],
    ] as const)
      db.prepare(
        "INSERT INTO repos (id, path, default_branch, allowed_providers, created_at) VALUES (?, ?, 'main', '[\"claude-cli\"]', '2025-01-01T00:00:00.000Z')",
      ).run(id, path)
    expect(listRepos(db).map((r) => r.id)).toEqual(['a', 'b'])
  })
})

describe('permission modes', () => {
  it('stores a task mode, defaulting to ask', () => {
    const db = fresh()
    const { repo, task } = seed(db)
    expect(task.permissionMode).toBe('ask')
    const auto = createTask(db, {
      id: tid('t-auto'),
      repoId: repo.id,
      title: 'Auto',
      prompt: 'Go',
      mode: 'single',
      permissionMode: 'auto',
    })
    expect(getTask(db, auto.id)?.permissionMode).toBe('auto')
    expect(() => db.prepare("UPDATE tasks SET permission_mode = 'bypass'").run()).toThrow()
  })

  it('gives tasks created before the migration the ask mode', () => {
    const db = openDatabase(':memory:', { migrations: MIGRATIONS.filter((m) => m.version < 22) })
    databases.push(db)
    db.prepare("INSERT INTO repos (id, path, default_branch) VALUES ('r-old', '/old', 'main')").run()
    db.prepare(
      "INSERT INTO tasks (id, repo_id, title, prompt, mode, status) VALUES ('t-old', 'r-old', 'Old', 'Old', 'single', 'done')",
    ).run()
    migrate(db, MIGRATIONS)
    expect(getTask(db, tid('t-old'))?.permissionMode).toBe('ask')
    expect(getRepo(db, rid('r-old'))?.maxPermissionMode).toBeUndefined()
  })

  it('sets and clears a repository maximum, refusing unknown modes', () => {
    const db = fresh()
    const { repo } = seed(db)
    expect(repo.maxPermissionMode).toBeUndefined()
    expect(updateRepoMaxPermissionMode(db, repo.id, 'auto')?.maxPermissionMode).toBe('auto')
    expect(updateRepoMaxPermissionMode(db, repo.id, null)?.maxPermissionMode).toBeUndefined()
    // @ts-expect-error not a permission mode
    expect(() => updateRepoMaxPermissionMode(db, repo.id, 'root')).toThrow('Invalid permission mode')
    expect(() => db.prepare("UPDATE repos SET max_permission_mode = 'root'").run()).toThrow()
  })

  it('keeps project instructions, trims them, clears them and refuses too long ones', () => {
    const db = fresh()
    const { repo } = seed(db)
    expect(repo.instructions).toBeUndefined()
    expect(updateRepoInstructions(db, repo.id, '  Use pnpm.\nNo default exports.\n')?.instructions).toBe(
      'Use pnpm.\nNo default exports.',
    )
    expect(updateRepoInstructions(db, repo.id, '   ')?.instructions).toBeUndefined()
    expect(
      updateRepoInstructions(db, repo.id, 'x'.repeat(MAX_PROJECT_INSTRUCTIONS))?.instructions,
    ).toHaveLength(MAX_PROJECT_INSTRUCTIONS)
    expect(updateRepoInstructions(db, repo.id, null)?.instructions).toBeUndefined()
    expect(() => updateRepoInstructions(db, repo.id, 'x'.repeat(MAX_PROJECT_INSTRUCTIONS + 1))).toThrow(
      'limited to',
    )
    expect(() =>
      db.prepare('UPDATE repos SET instructions = ?').run('x'.repeat(MAX_PROJECT_INSTRUCTIONS + 1)),
    ).toThrow()
    expect(() => db.prepare("UPDATE repos SET instructions = ''").run()).toThrow()
  })

  it('stores the install command as argv and refuses anything else', () => {
    const db = fresh()
    const { repo } = seed(db)
    expect(repo.installCommand).toBeUndefined()
    expect(updateRepoInstallCommand(db, repo.id, ['pnpm', 'install', '--offline'])?.installCommand).toEqual([
      'pnpm',
      'install',
      '--offline',
    ])
    expect(updateRepoInstallCommand(db, repo.id, null)?.installCommand).toBeUndefined()
    expect(() => updateRepoInstallCommand(db, repo.id, [])).toThrow('Invalid install command')
    expect(() => updateRepoInstallCommand(db, repo.id, ['pnpm', ''])).toThrow('Invalid install command')
    expect(() => db.prepare('UPDATE repos SET install_command = \'"pnpm install"\'').run()).toThrow()
  })

  it('stores project defaults, drops empty ones and refuses invalid ones', () => {
    const db = fresh()
    const { repo } = seed(db)
    expect(repo.defaults).toBeUndefined()
    const defaults = {
      implementer: { provider: 'codex-cli', model: 'gpt-6-luna', effort: 'low' },
      reviewer: { provider: 'claude-cli', model: 'haiku' },
      mode: 'single',
      permissionMode: 'auto',
    } as const
    expect(updateRepoDefaults(db, repo.id, defaults)?.defaults).toEqual(defaults)
    expect(updateRepoDefaults(db, repo.id, { mode: 'compete' })?.defaults).toEqual({ mode: 'compete' })
    expect(updateRepoDefaults(db, repo.id, {})?.defaults).toBeUndefined()
    expect(updateRepoDefaults(db, repo.id, defaults)?.defaults).toBeDefined()
    expect(updateRepoDefaults(db, repo.id, null)?.defaults).toBeUndefined()
    // @ts-expect-error not a task mode
    expect(() => updateRepoDefaults(db, repo.id, { mode: 'party' })).toThrow('Invalid project default mode')
    // @ts-expect-error not a permission mode
    expect(() => updateRepoDefaults(db, repo.id, { permissionMode: 'root' })).toThrow('permission mode')
    expect(() =>
      updateRepoDefaults(db, repo.id, { implementer: { provider: 'openai-api', model: 'gpt' } }),
    ).toThrow('cannot edit code')
    // @ts-expect-error not a provider
    expect(() => updateRepoDefaults(db, repo.id, { reviewer: { provider: 'x', model: 'm' } })).toThrow(
      'Invalid project default reviewer',
    )
    // @ts-expect-error unknown field
    expect(() => updateRepoDefaults(db, repo.id, { planFirst: true })).toThrow('unknown field planFirst')
    expect(() => db.prepare("UPDATE repos SET defaults = '[]'").run()).toThrow()
    expect(() => db.prepare("UPDATE repos SET defaults = 'nope'").run()).toThrow()
  })

  it('leaves repositories from before migration 23 without the new fields', () => {
    const db = openDatabase(':memory:', { migrations: MIGRATIONS.filter((m) => m.version < 23) })
    databases.push(db)
    db.prepare("INSERT INTO repos (id, path, default_branch) VALUES ('r-old', '/old', 'main')").run()
    migrate(db, MIGRATIONS)
    const repo = getRepo(db, rid('r-old'))
    expect(repo?.instructions).toBeUndefined()
    expect(repo?.installCommand).toBeUndefined()
    expect(repo?.defaults).toBeUndefined()
  })
})
