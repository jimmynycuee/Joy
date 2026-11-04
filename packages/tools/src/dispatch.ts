import { randomUUID } from 'node:crypto'
import { TASK_MODES } from '@joy/core'
import type { RepoId, TaskId } from '@joy/core'
import {
  createTask,
  getRepo,
  getTask,
  listAttempts,
  listReviews,
  listTaskApprovals,
  listTasks,
} from '@joy/db'
import type { ApprovalStatus, Database, StoredTask } from '@joy/db'
import { z } from 'zod'
import type { ToolHubTool } from './index.js'

const createTaskInput = z.strictObject({
  repoId: z.string().trim().min(1).max(128),
  title: z.string().trim().min(1).max(500),
  prompt: z.string().trim().min(1).max(20_000),
  mode: z.enum(TASK_MODES).default('single'),
})
const listTasksInput = z.strictObject({})
const summarizeTaskInput = z.strictObject({
  taskId: z.string().trim().min(1).max(128),
})
const approvalStatuses: readonly ApprovalStatus[] = ['pending', 'approved', 'denied', 'expired']

export interface TaskDispatchContext {
  db: Database
}

/** Assistant-facing tools for creating queued tasks and reading persisted task state. */
export function createTaskDispatchTools(context: TaskDispatchContext): ToolHubTool[] {
  return [
    {
      name: 'create_task',
      title: 'Create queued task',
      description:
        'Create a task for a registered repository. The task is persisted with status queued only; this tool does not start or resume execution, apply an approval policy, or send notifications.',
      inputSchema: createTaskInput,
      run: async (input, signal) => {
        ensureNotAborted(signal)
        const { repoId, title, prompt, mode } = createTaskInput.parse(input)
        const repo = getRepo(context.db, repoId as RepoId)
        if (!repo) throw new Error(`Repository ${repoId} is not registered in Joy`)
        const task = createTask(context.db, {
          id: randomUUID() as TaskId,
          repoId: repo.id,
          title,
          prompt,
          mode,
        })
        return { task: publicTask(task) }
      },
    },
    {
      name: 'list_tasks',
      title: 'List tasks',
      description:
        'List persisted Joy tasks using safe task metadata only. Task prompts, repository paths, and event payloads are not returned.',
      inputSchema: listTasksInput,
      annotations: { readOnlyHint: true },
      run: async (input, signal) => {
        ensureNotAborted(signal)
        listTasksInput.parse(input)
        return { tasks: listTasks(context.db).map(publicTask) }
      },
    },
    {
      name: 'summarize_task',
      title: 'Summarize task',
      description:
        'Read persisted task status, attempt outcomes, review summaries, and approval counts. This is read-only and does not return the task prompt or event payloads.',
      inputSchema: summarizeTaskInput,
      annotations: { readOnlyHint: true },
      run: async (input, signal) => {
        ensureNotAborted(signal)
        const { taskId } = summarizeTaskInput.parse(input)
        const task = getTask(context.db, taskId as TaskId)
        if (!task) throw new Error(`Task ${taskId} was not found`)

        const approvals = listTaskApprovals(context.db, task.id)
        const approvalCounts = Object.fromEntries(
          approvalStatuses.map((status) => [
            status,
            approvals.filter((approval) => approval.status === status).length,
          ]),
        ) as Record<ApprovalStatus, number>
        const attempts = listAttempts(context.db, task.id).map((attempt) => ({
          id: attempt.id,
          provider: attempt.provider,
          model: attempt.model,
          status: attempt.status,
          reviews: listReviews(context.db, attempt.id).map(({ round, approve, summary, findings }) => ({
            round,
            approve,
            summary,
            findings,
          })),
        }))
        const pendingApprovals = approvalCounts.pending
        const summary = `${task.title} is ${task.status}; ${attempts.length} attempt(s) recorded, ${pendingApprovals} approval request(s) pending.`

        return {
          task: publicTask(task),
          summary,
          attempts,
          approvals: approvalCounts,
        }
      },
    },
  ]
}

function publicTask(task: StoredTask) {
  return {
    id: task.id,
    repoId: task.repoId,
    title: task.title,
    mode: task.mode,
    status: task.status,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  }
}

function ensureNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('Task dispatch request cancelled')
}
