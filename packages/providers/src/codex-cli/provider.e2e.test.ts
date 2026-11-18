// Calls the real Codex CLI and spends a little quota. Skipped unless JOY_E2E_CODEX=1.
//   JOY_E2E_CODEX=1 pnpm vitest run --project providers codex-cli/provider.e2e
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent } from '@joy/core'
import { describe, expect, it } from 'vitest'
import { CodexCliProvider } from './provider.js'

// Cheapest model and effort: these tests only check plumbing, not quality.
const model = {
  provider: 'codex-cli',
  model: process.env.JOY_E2E_CODEX_MODEL ?? 'gpt-6-luna',
  effort: 'low',
} as const

async function collect(run: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = []
  for await (const event of run) events.push(event)
  return events
}

describe.runIf(process.env.JOY_E2E_CODEX === '1')('CodexCliProvider (real CLI)', () => {
  for (const mode of ['app-server', 'exec'] as const) {
    it(`fixes a bug and resumes the session (${mode})`, { timeout: 300_000 }, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'joy-e2e-codex-'))
      try {
        writeFileSync(join(dir, 'math.js'), 'export function add(a, b) {\n  return a - b\n}\n')
        spawnSync('git', ['init', '-q'], { cwd: dir })
        // No fallback: a broken app-server must fail here instead of quietly running exec.
        const provider = new CodexCliProvider({ mode, fallbackToExec: false })
        const events = await collect(
          provider.run(
            {
              cwd: dir,
              prompt: 'math.js has a bug in add(). Fix it. Do not create other files.',
              autonomy: 'workspace-write',
              signal: new AbortController().signal,
            },
            model,
          ),
        )
        const started = events.find((event) => event.type === 'session_started')
        expect(started).toBeDefined()
        expect(events.at(-1)).toMatchObject({ type: 'done', isError: false })
        // codex-cli 0.166.0 `exec` with gpt-6-luna says it fixed the file but only ever runs `cat` (the same when run
        // by hand, without Joy); app-server edits it. Only the app-server path is held to the edit.
        if (mode === 'app-server') expect(readFileSync(join(dir, 'math.js'), 'utf8')).toContain('a + b')

        const sessionId = started?.type === 'session_started' ? started.sessionId : ''
        const resumed = await collect(
          provider.run(
            {
              cwd: dir,
              prompt: 'Which file did you change? Answer with the file name only.',
              resumeSessionId: sessionId,
              autonomy: 'read-only',
              signal: new AbortController().signal,
            },
            model,
          ),
        )
        expect(resumed.at(-1)).toMatchObject({ type: 'done', isError: false })
        expect(JSON.stringify(resumed.at(-1))).toContain('math.js')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  }
})
