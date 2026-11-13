import type { ModelRef, RunOptions } from '@joy/core'
import { effortCompatibilityError } from '@joy/model-effort'

/**
 * Builds the `claude` argument list. Pure, so it is unit-tested directly.
 * `mcpConfigPath` is the JSON file written from `opts.mcpServers` (see provider.ts).
 * `streamingInput`: the prompt and later owner messages go to stdin as JSONL (`--input-format stream-json`) instead
 * of the command line, so the process can take more input while it works.
 */
export function buildClaudeArgs(
  opts: RunOptions,
  model: ModelRef,
  mcpConfigPath?: string,
  streamingInput = false,
): string[] {
  if (model.provider !== 'claude-cli') {
    throw new Error(`Claude Code cannot run model provider '${model.provider}'.`)
  }
  if (model.effort) {
    const issue = effortCompatibilityError(model.provider, model.model, model.effort)
    if (issue) throw new Error(`Invalid Claude Code model effort: ${issue}`)
  }

  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--model', model.model]
  if (streamingInput) args.push('--input-format', 'stream-json')
  if (model.effort) args.push('--effort', model.effort)

  if (opts.resumeSessionId) args.push('--resume', opts.resumeSessionId)
  else if (opts.sessionId) args.push('--session-id', opts.sessionId)

  switch (opts.autonomy) {
    case 'read-only':
      args.push('--permission-mode', 'plan', '--permission-prompts', 'none')
      break
    case 'workspace-write':
      args.push('--permission-mode', 'acceptEdits')
      if (opts.approvalTool)
        args.push('--permission-prompt-tool', opts.approvalTool, '--permission-prompts', 'host')
      // Nobody is there to answer a prompt: deny instead of hanging.
      else args.push('--permission-prompts', 'none')
      break
    case 'full':
      args.push('--permission-mode', 'bypassPermissions')
      break
  }

  if (mcpConfigPath) args.push('--mcp-config', mcpConfigPath, '--strict-mcp-config')
  if (opts.outputSchema) args.push('--json-schema', JSON.stringify(opts.outputSchema))

  // `--` so a prompt starting with "-" is never read as a flag.
  if (!streamingInput) args.push('--', opts.prompt)
  return args
}

/** One user message on stdin in `--input-format stream-json` (the Agent SDK's streaming input shape). */
export function claudeUserMessage(text: string): string {
  // JSON.stringify leaves U+2028/U+2029 raw, and some line readers split on them; escaped they are the same JSON.
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
  }).replace(/[\u2028\u2029]/g, (char) => `\\u${char.charCodeAt(0).toString(16)}`)
}

/** Claude's `--mcp-config` file format. */
export function mcpConfigJson(servers: NonNullable<RunOptions['mcpServers']>): string {
  const mcpServers: Record<string, unknown> = {}
  for (const s of servers) {
    mcpServers[s.name] =
      s.transport === 'stdio'
        ? { command: s.command, args: s.args, ...(s.env ? { env: s.env } : {}) }
        : { type: 'http', url: s.url, ...(s.headers ? { headers: s.headers } : {}) }
  }
  return JSON.stringify({ mcpServers })
}
