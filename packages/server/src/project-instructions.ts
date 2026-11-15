import type { AgentProvider } from '@joy/core'

/**
 * The owner's project instructions as they open an agent's prompt. They are the owner's own words (written in the
 * project settings), not content from outside, so the agent is told to follow them like a CLAUDE.md.
 */
export function withProjectInstructionsPrefix(prompt: string, instructions: string): string {
  return [
    "Project instructions from the owner. They apply to all work in this repository, like a CLAUDE.md; follow them unless the task's own request says otherwise.",
    '<project-instructions>',
    instructions,
    '</project-instructions>',
    '',
    prompt,
  ].join('\n')
}

/**
 * Puts the project's instructions in front of the prompt of every run that starts a new agent session: implementer,
 * reviewer, judge, a plan, a handoff to another provider. A run that resumes a session does not get them again: the
 * session already has them from its first prompt, and repeating them every turn would only spend tokens.
 * `instructions` is asked at the start of each run, so a change in the settings reaches the next new session.
 */
export function withProjectInstructions(
  inner: AgentProvider,
  instructions: () => string | undefined,
): AgentProvider {
  return {
    kind: inner.kind,
    capabilities: inner.capabilities,
    healthCheck: () => inner.healthCheck(),
    run(opts, model) {
      const text = opts.resumeSessionId ? undefined : instructions()
      return inner.run(
        text ? { ...opts, prompt: withProjectInstructionsPrefix(opts.prompt, text) } : opts,
        model,
      )
    },
  }
}
