import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  AgentEvent,
  AgentProvider,
  Executor,
  ModelRef,
  ProviderKind,
  RepoRef,
  RunOptions,
  TaskId,
  Workspace,
  WorkspaceDiff,
} from '@joy/core'
import { ConfigStore } from '@joy/config'
import { openDatabase } from '@joy/db'
import type { Database } from '@joy/db'
import { MemoryBackend, Redactor, SecretStore } from '@joy/secrets'
import { createJoyServer } from '@joy/server'
import type { JoyServer } from '@joy/server'

export const E2E_API_TOKEN = 'joy-e2e-only-api-token'

export const fakeDiff: WorkspaceDiff = {
  files: [{ path: 'src/hello.ts', status: 'modified', additions: 1, deletions: 1 }],
  patch: [
    'diff --git a/src/hello.ts b/src/hello.ts',
    'index 0f0..a1b 100644',
    '--- a/src/hello.ts',
    '+++ b/src/hello.ts',
    '@@ -1 +1 @@',
    '-export const greeting = "hello"',
    '+export const greeting = "hello from fake"',
  ].join('\n'),
}

let fakeRuns = 0
class E2EFakeProvider implements AgentProvider {
  readonly capabilities: AgentProvider['capabilities']

  constructor(readonly kind: ProviderKind) {
    this.capabilities = {
      codeEdit: kind !== 'openai-api',
      tools: true,
      resume: true,
      presetSessionId: true,
      delegatedApproval: false,
      quotaEvents: false,
      structuredOutput: true,
    }
  }

  async *run(options: RunOptions, model: ModelRef): AsyncGenerator<AgentEvent> {
    fakeRuns++
    const sessionId = `e2e-${fakeRuns}`
    yield { type: 'session_started', sessionId, model: model.model }
    if (options.outputSchema) {
      yield {
        type: 'done',
        sessionId,
        finalMessage: 'Fake review approved',
        structured: { approve: true, summary: 'Fake review approved', findings: [] },
        isError: false,
      }
      return
    }
    yield { type: 'message', text: `Fake provider completed: ${model.provider}:${model.model}` }
    yield { type: 'done', sessionId, finalMessage: 'Fake task complete', isError: false }
  }

  async healthCheck() {
    return { ok: true, installed: true, loggedIn: true as const, version: 'fake' }
  }
}

class E2EFakeExecutor implements Executor {
  async prepare(repo: RepoRef, taskId: TaskId, attemptId: Workspace['attemptId']): Promise<Workspace> {
    return {
      repo,
      taskId,
      attemptId,
      path: '/fake/e2e-worktree',
      branch: 'joy/e2e/task',
      baseCommit: 'fake-base',
    }
  }

  async diff(): Promise<WorkspaceDiff> {
    return fakeDiff
  }

  async commit(): Promise<string | null> {
    return null
  }

  async cleanup(): Promise<void> {}
}

export interface FakeJoyRuntime {
  server: JoyServer
  database: Database
  home: string
  close(): Promise<void>
}

/** `allowPlaywrightOrigin` lets a Vite preview on port 4173 talk to it, so a run never needs 5173 or 4317. */
export async function startFakeJoyRuntime(
  port = 4317,
  options: { allowPlaywrightOrigin?: boolean } = {},
): Promise<FakeJoyRuntime> {
  fakeRuns = 0
  const home = mkdtempSync(join(tmpdir(), 'joy-t1.8-e2e-'))
  const database = openDatabase(':memory:')
  const redactor = new Redactor()
  const secretStore = new SecretStore({
    backend: new MemoryBackend(),
    onSecret: (value) => redactor.add(value),
  })
  const server = await createJoyServer({
    home,
    apiToken: E2E_API_TOKEN,
    ...(options.allowPlaywrightOrigin ? { allowPlaywrightOrigin: true } : {}),
    database,
    configStore: new ConfigStore(join(home, 'config.yaml')),
    secretStore,
    redactor,
    executor: new E2EFakeExecutor(),
    doctor: {
      nodeVersion: '22.13.0',
      runCommand: async (command) => {
        if (command === 'git') return { exitCode: 0, output: 'git version 2.48.1' }
        if (command === 'gh') return { exitCode: 1 }
        if (command === 'claude') return { exitCode: null, spawnErrorCode: 'ENOENT' }
        if (command === 'codex') return { exitCode: 0, output: 'codex-cli 0.104.0' }
        return { exitCode: null, spawnErrorCode: 'ENOENT' }
      },
      keychainLookup: async () => null,
    },
    providers: {
      'openai-api': new E2EFakeProvider('openai-api'),
      'claude-cli': new E2EFakeProvider('claude-cli'),
      'codex-cli': new E2EFakeProvider('codex-cli'),
    },
  })
  await server.listen(port)
  return {
    server,
    database,
    home,
    async close() {
      await server.close()
      if (database.isOpen) database.close()
      rmSync(home, { recursive: true, force: true })
    },
  }
}
