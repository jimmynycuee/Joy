import { describe, expect, it, vi } from 'vitest'
import type { ProviderKind, TaskId } from '@joy/core'
import { createToolHubDispatcher } from './hub.js'
import type { ToolHubRuntime } from './hub.js'

function runtime(overrides: Partial<ToolHubRuntime> = {}): ToolHubRuntime {
  return {
    taskId: 'task-1' as TaskId,
    currentProvider: 'claude-cli',
    allowedProviders: ['claude-cli', 'codex-cli'],
    cwd: '/tmp/shared-worktree',
    maxAskPeerCalls: 2,
    budget: { askPeerCalls: 0 },
    askPeer: vi.fn(async ({ provider, cwd, autonomy }) => ({
      provider,
      cwd,
      autonomy,
      answer: 'peer reply',
    })),
    taskStatus: vi.fn(async () => ({ id: 'task-1', status: 'running' })),
    ...overrides,
  }
}

describe('Tool Hub dispatcher', () => {
  it('asks an allowed, different provider in the shared worktree with read-only autonomy', async () => {
    const deps = runtime()
    const dispatch = createToolHubDispatcher(deps)
    await expect(
      dispatch({ name: 'ask_peer', arguments: { provider: 'codex-cli', question: 'Review this approach' } }),
    ).resolves.toEqual({
      provider: 'codex-cli',
      cwd: '/tmp/shared-worktree',
      autonomy: 'read-only',
      answer: 'peer reply',
    })
    expect(deps.askPeer).toHaveBeenCalledWith({
      taskId: 'task-1',
      provider: 'codex-cli',
      question: 'Review this approach',
      cwd: '/tmp/shared-worktree',
      autonomy: 'read-only',
    })
    expect(deps.budget.askPeerCalls).toBe(1)
  })

  it('rejects the current provider and providers outside the repository allowlist', async () => {
    const dispatch = createToolHubDispatcher(runtime({ allowedProviders: ['claude-cli'] }))
    await expect(
      dispatch({ name: 'ask_peer', arguments: { provider: 'claude-cli', question: 'Review' } }),
    ).rejects.toThrow('different provider')
    await expect(
      dispatch({ name: 'ask_peer', arguments: { provider: 'openai-api', question: 'Review' } }),
    ).rejects.toThrow('not allowed')
  })

  it('caps ask_peer calls for the task and does not silently ignore the excess call', async () => {
    const deps = runtime({ maxAskPeerCalls: 1 })
    const dispatch = createToolHubDispatcher(deps)
    const call = { name: 'ask_peer' as const, arguments: { provider: 'codex-cli', question: 'Review' } }
    await dispatch(call)
    await expect(dispatch(call)).rejects.toThrow('limit reached (1 per task)')
    expect(deps.askPeer).toHaveBeenCalledTimes(1)
  })

  it('exposes task status and marks policy approval unavailable by default', async () => {
    const deps = runtime()
    const dispatch = createToolHubDispatcher(deps)
    await expect(dispatch({ name: 'task_status', arguments: {} })).resolves.toEqual({
      id: 'task-1',
      status: 'running',
    })
    await expect(
      dispatch({
        name: 'request_approval',
        arguments: { kind: 'run_outside_worktree', summary: 'Run command', detail: { command: 'x' } },
      }),
    ).rejects.toThrow('not available')
    await expect(
      dispatch({ name: 'approve', arguments: { tool_name: 'shell', input: {}, tool_use_id: 'use-1' } }),
    ).resolves.toEqual({ behavior: 'deny', message: expect.any(String) })
  })

  it('tags proposed approval actions as agent-originated and validates action kinds', async () => {
    const requestApproval = vi.fn(async (action) => ({ status: 'awaiting_approval', action }))
    const dispatch = createToolHubDispatcher(runtime({ requestApproval }))
    await expect(
      dispatch({
        name: 'request_approval',
        arguments: { kind: 'push_default_branch', summary: 'Push main', detail: { branch: 'main' } },
      }),
    ).resolves.toMatchObject({ action: { provenance: 'agent', kind: 'push_default_branch' } })
    expect(requestApproval).toHaveBeenCalledWith({
      kind: 'push_default_branch',
      summary: 'Push main',
      detail: { branch: 'main' },
      provenance: 'agent',
    })
    await expect(
      dispatch({ name: 'request_approval', arguments: { kind: 'invented', summary: 'x', detail: {} } }),
    ).rejects.toThrow()
  })

  it('does not accept malformed peer input', async () => {
    const dispatch = createToolHubDispatcher(runtime())
    await expect(
      dispatch({ name: 'ask_peer', arguments: { provider: 'bogus' as ProviderKind, question: ' ' } }),
    ).rejects.toThrow()
  })
})
