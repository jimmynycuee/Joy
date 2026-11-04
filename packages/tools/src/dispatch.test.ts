import type { AttemptId, RepoId, TaskId } from '@joy/core'
import {
  createApproval,
  createAttempt,
  createRepo,
  createReview,
  createTask,
  getTask,
  listAttempts,
  listTasks,
  openDatabase,
  setTaskStatus,
} from '@joy/db'
import type { Database } from '@joy/db'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it } from 'vitest'
import { createMcpServerForTools, toFunctionCallingTools } from './index.js'
import type { ToolHubTool } from './index.js'
import { createTaskDispatchTools } from './dispatch.js'

const databases: Database[] = []
const clients: Client[] = []

function fixture() {
  const db = openDatabase(':memory:')
  databases.push(db)
  createRepo(db, { id: 'repo-1' as RepoId, path: '/private/repo', defaultBranch: 'main' })
  const controller = new AbortController()
  const tools = createTaskDispatchTools({ db })
  return { db, controller, tools }
}

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close()
  for (const db of databases.splice(0)) if (db.isOpen) db.close()
})

function findTool(tools: readonly ToolHubTool[], name: string): ToolHubTool {
  const tool = tools.find((candidate) => candidate.name === name)
  if (!tool) throw new Error(`Missing ${name} tool`)
  return tool
}

function text(content: unknown): string {
  const result = content as { content?: Array<{ type: string; text?: string }> }
  return result.content?.find((item) => item.type === 'text')?.text ?? ''
}

describe('assistant task dispatch tools', () => {
  it('creates queued tasks only, through the shared MCP and function-calling contracts', async () => {
    const f = fixture()
    const functionTools = toFunctionCallingTools(f.tools)
    expect(functionTools.map(({ name }) => name).sort()).toEqual([
      'create_task',
      'list_tasks',
      'summarize_task',
    ])
    expect(findTool(f.tools, 'create_task').description).toContain('status queued only')

    const createFunction = functionTools.find((tool) => tool.name === 'create_task')
    if (!createFunction) throw new Error('Missing create_task function tool')
    const created = (await createFunction.run(
      { repoId: 'repo-1', title: 'Queued from assistant', prompt: 'Implement a safe change' },
      f.controller.signal,
    )) as { task: { id: TaskId; status: string; title: string } }
    expect(created.task).toMatchObject({ status: 'queued', title: 'Queued from assistant' })
    expect(getTask(f.db, created.task.id)?.status).toBe('queued')
    expect(listAttempts(f.db, created.task.id)).toEqual([])
    const functionList = functionTools.find((tool) => tool.name === 'list_tasks')
    const functionSummary = functionTools.find((tool) => tool.name === 'summarize_task')
    if (!functionList || !functionSummary) throw new Error('Missing assistant read tool')
    expect(((await functionList.run({}, f.controller.signal)) as { tasks: unknown[] }).tasks).toHaveLength(1)
    expect(
      (
        (await functionSummary.run({ taskId: created.task.id }, f.controller.signal)) as {
          task: { status: string }
        }
      ).task.status,
    ).toBe('queued')

    const server = createMcpServerForTools(f.tools, f.controller.signal)
    const client = new Client({ name: 'joy-dispatch-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    clients.push(client)
    const listed = await client.listTools()
    expect(listed.tools.map(({ name }) => name).sort()).toEqual([
      'create_task',
      'list_tasks',
      'summarize_task',
    ])

    const response = await client.callTool({
      name: 'create_task',
      arguments: {
        repoId: 'repo-1',
        title: 'MCP queued task',
        prompt: 'Wait for a separate execution action',
        mode: 'review_loop',
      },
    })
    expect(response.isError).not.toBe(true)
    const mcpCreated = JSON.parse(text(response)) as { task: { id: TaskId; status: string; mode: string } }
    expect(mcpCreated.task).toMatchObject({ status: 'queued', mode: 'review_loop' })
    expect(listAttempts(f.db, mcpCreated.task.id)).toEqual([])
    const mcpList = await client.callTool({ name: 'list_tasks', arguments: {} })
    expect((JSON.parse(text(mcpList)) as { tasks: unknown[] }).tasks).toHaveLength(2)
    const mcpSummary = await client.callTool({
      name: 'summarize_task',
      arguments: { taskId: mcpCreated.task.id },
    })
    expect(JSON.parse(text(mcpSummary)).task.status).toBe('queued')
  })

  it('lists only public task metadata and summarizes persisted attempts, reviews, and approval counts', async () => {
    const f = fixture()
    const task = createTask(f.db, {
      id: 'task-1' as TaskId,
      repoId: 'repo-1' as RepoId,
      title: 'Existing task',
      prompt: 'PRIVATE_PROMPT_SHOULD_NOT_BE_RETURNED',
      mode: 'single',
    })
    const attempt = createAttempt(f.db, {
      id: 'attempt-1' as AttemptId,
      taskId: task.id,
      provider: 'claude-cli',
      model: 'haiku',
      status: 'succeeded',
    })
    createReview(f.db, {
      id: 'review-1',
      attemptId: attempt.id,
      reviewerProvider: 'codex-cli',
      reviewerModel: 'gpt-6-luna',
      round: 1,
      approve: true,
      summary: 'The change is ready for review.',
      findings: [{ severity: 'minor', message: 'Add a brief example.' }],
    })
    createApproval(f.db, {
      id: 'approval-1',
      attemptId: attempt.id,
      action: {
        kind: 'edit_worktree',
        summary: 'Proposed edit',
        detail: {},
        provenance: 'agent',
      },
      tier: 'approve',
    })
    setTaskStatus(f.db, task.id, 'awaiting_approval')

    const listed = (await findTool(f.tools, 'list_tasks').run({}, f.controller.signal)) as {
      tasks: Array<Record<string, unknown>>
    }
    expect(listed.tasks).toHaveLength(1)
    expect(listed.tasks[0]).toMatchObject({ id: task.id, status: 'awaiting_approval' })
    expect(listed.tasks[0]).not.toHaveProperty('prompt')

    const summary = (await findTool(f.tools, 'summarize_task').run(
      { taskId: task.id },
      f.controller.signal,
    )) as {
      task: { status: string }
      summary: string
      attempts: Array<{ id: AttemptId; reviews: Array<{ summary: string; approve: boolean }> }>
      approvals: { pending: number; approved: number; denied: number; expired: number }
    }
    expect(summary.task.status).toBe('awaiting_approval')
    expect(summary.summary).toContain('1 attempt(s) recorded')
    expect(summary.attempts).toMatchObject([
      { id: attempt.id, reviews: [{ approve: true, summary: 'The change is ready for review.' }] },
    ])
    expect(summary.approvals).toEqual({ pending: 1, approved: 0, denied: 0, expired: 0 })
    expect(JSON.stringify({ listed, summary })).not.toContain('PRIVATE_PROMPT_SHOULD_NOT_BE_RETURNED')
    expect(JSON.stringify({ listed, summary })).not.toContain('/private/repo')
  })

  it('rejects unknown repositories, malformed inputs, missing tasks, and cancelled calls', async () => {
    const f = fixture()
    const create = findTool(f.tools, 'create_task')
    await expect(
      create.run(
        { repoId: 'unknown', title: 'No repo', prompt: 'This must not persist' },
        f.controller.signal,
      ),
    ).rejects.toThrow('Repository unknown is not registered in Joy')
    await expect(
      create.run({ repoId: 'repo-1', title: '  ', prompt: 'Invalid title' }, f.controller.signal),
    ).rejects.toThrow()
    expect(listTasks(f.db)).toEqual([])
    await expect(
      findTool(f.tools, 'summarize_task').run({ taskId: 'missing' }, f.controller.signal),
    ).rejects.toThrow('Task missing was not found')

    f.controller.abort()
    await expect(findTool(f.tools, 'list_tasks').run({}, f.controller.signal)).rejects.toThrow(
      'Task dispatch request cancelled',
    )
  })
})
