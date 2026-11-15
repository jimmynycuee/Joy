import type { AgentEvent, AgentProvider, RunOptions } from '@joy/core'
import { describe, expect, it } from 'vitest'
import { withProjectInstructions, withProjectInstructionsPrefix } from './project-instructions.js'

function fake() {
  const seen: RunOptions[] = []
  const provider: AgentProvider = {
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
      yield { type: 'done', sessionId: 's', isError: false }
    },
    healthCheck: async () => ({ ok: true, installed: true, loggedIn: true as const }),
  }
  return { provider, seen }
}
const options = (extra: Partial<RunOptions> = {}): RunOptions => ({
  cwd: '/w',
  prompt: 'Do it',
  autonomy: 'workspace-write',
  signal: new AbortController().signal,
  ...extra,
})
const model = { provider: 'claude-cli', model: 'haiku' } as const
async function drain(iterable: AsyncIterable<unknown>) {
  for await (const event of iterable) void event
}

describe('withProjectInstructions', () => {
  it('puts the instructions in front of a new session’s prompt and keeps everything else', async () => {
    const { provider, seen } = fake()
    const wrapped = withProjectInstructions(provider, () => 'Use tabs.')
    expect(wrapped.kind).toBe('claude-cli')
    expect(wrapped.capabilities).toBe(provider.capabilities)
    const outputSchema = { type: 'object' }
    await drain(wrapped.run(options({ outputSchema }), model))
    expect(seen[0]?.prompt).toBe(withProjectInstructionsPrefix('Do it', 'Use tabs.'))
    expect(seen[0]?.prompt.endsWith('\n\nDo it')).toBe(true)
    expect(seen[0]?.prompt).toContain('<project-instructions>\nUse tabs.\n</project-instructions>')
    expect(seen[0]).toMatchObject({ cwd: '/w', autonomy: 'workspace-write', outputSchema })
  })

  it('leaves a resumed session alone: it has them from its first prompt', async () => {
    const { provider, seen } = fake()
    const wrapped = withProjectInstructions(provider, () => 'Use tabs.')
    await drain(wrapped.run(options({ resumeSessionId: 'x' }), model))
    expect(seen[0]?.prompt).toBe('Do it')
  })

  it.each([[undefined], ['']])('changes nothing without instructions (%j)', async (instructions) => {
    const { provider, seen } = fake()
    await drain(withProjectInstructions(provider, () => instructions).run(options(), model))
    expect(seen[0]?.prompt).toBe('Do it')
  })

  it('asks for the instructions at every run, so an edit reaches the next new session', async () => {
    const { provider, seen } = fake()
    let text = 'one'
    const wrapped = withProjectInstructions(provider, () => text)
    await drain(wrapped.run(options(), model))
    text = 'two'
    await drain(wrapped.run(options(), model))
    expect(seen[0]?.prompt).toContain('one')
    expect(seen[1]?.prompt).toContain('two')
    expect(seen[1]?.prompt).not.toContain('one')
  })
})
