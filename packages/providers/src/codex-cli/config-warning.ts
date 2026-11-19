import type { AgentEvent } from '@joy/core'

/** Codex prints this when ~/.codex/config.toml has an obsolete key. It is advice, not a failed run. */
export function isConfigWarning(message: string): boolean {
  return /ignoring \d+ unrecognized configuration setting/i.test(message)
}

/** Reports each distinct config warning once per run, as a status instead of an error. */
export class ConfigWarningFilter {
  private readonly seen = new Set<string>()

  /** Returns the replacement events for a Codex notice, or undefined when it is not a config warning. */
  take(message: string): AgentEvent[] | undefined {
    if (!isConfigWarning(message)) return undefined
    if (this.seen.has(message)) return []
    this.seen.add(message)
    return [{ type: 'status', text: message }]
  }
}
