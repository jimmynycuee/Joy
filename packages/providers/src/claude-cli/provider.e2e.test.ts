// Calls the real Claude Code CLI and spends a little quota. Skipped unless JOY_E2E_CLAUDE=1.
//   JOY_E2E_CLAUDE=1 pnpm vitest run --project providers provider.e2e
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent } from '@joy/core'
import { describe, expect, it } from 'vitest'
import { ClaudeCliProvider } from './provider.js'

describe.runIf(process.env.JOY_E2E_CLAUDE === '1')('ClaudeCliProvider (real CLI)', () => {
  it('fixes a bug in a worktree and can resume the session', { timeout: 300_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'joy-e2e-'))
    try {
      writeFileSync(join(dir, 'math.js'), 'export function add(a, b) {\n  return a - b\n}\n')
      spawnSync('git', ['init', '-q'], { cwd: dir })
      const provider = new ClaudeCliProvider()
      // Cheapest model and effort: these tests only check plumbing, not quality.
      const model = {
        provider: 'claude-cli',
        model: process.env.JOY_E2E_MODEL ?? 'haiku',
        effort: 'low',
      } as const
      const sessionId = crypto.randomUUID()
      const events: AgentEvent[] = []
      for await (const e of provider.run(
        {
          cwd: dir,
          prompt: 'math.js has a bug in add(). Fix it. Do not create other files.',
          sessionId,
          autonomy: 'workspace-write',
          signal: new AbortController().signal,
        },
        model,
      ))
        events.push(e)

      expect(events[0]).toMatchObject({ type: 'session_started', sessionId })
      expect(events.at(-1)).toMatchObject({ type: 'done', isError: false, sessionId })
      expect(events).toContainEqual({ type: 'file_change', path: 'math.js', kind: 'modify' })
      expect(readFileSync(join(dir, 'math.js'), 'utf8')).toContain('a + b')

      const resumed: AgentEvent[] = []
      for await (const e of provider.run(
        {
          cwd: dir,
          prompt: 'Which file did you change? Answer with the file name only.',
          resumeSessionId: sessionId,
          autonomy: 'read-only',
          signal: new AbortController().signal,
        },
        model,
      ))
        resumed.push(e)
      expect(resumed.at(-1)).toMatchObject({ type: 'done', isError: false, sessionId })
      expect(JSON.stringify(resumed.at(-1))).toContain('math.js')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
