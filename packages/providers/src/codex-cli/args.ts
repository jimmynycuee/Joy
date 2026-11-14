import type { McpServerConfig, ModelRef, RunOptions } from '@joy/core'

/** TOML basic strings accept JSON string escapes, so JSON.stringify is a safe quoter. */
const q = (s: string) => JSON.stringify(s)

/** `-c key=value` overrides that add MCP servers to this run only. */
export function mcpOverrides(servers: McpServerConfig[]): string[] {
  const out: string[] = []
  for (const s of servers) {
    if (!/^[A-Za-z0-9_-]+$/.test(s.name)) throw new Error(`Invalid MCP server name "${s.name}"`)
    const key = `mcp_servers.${s.name}`
    if (s.transport === 'stdio') {
      out.push('-c', `${key}.command=${q(s.command)}`, '-c', `${key}.args=[${s.args.map(q).join(',')}]`)
      if (s.env) {
        const table = Object.entries(s.env)
          .map(([k, v]) => `${q(k)}=${q(v)}`)
          .join(',')
        out.push('-c', `${key}.env={${table}}`)
      }
    } else {
      out.push('-c', `${key}.url=${q(s.url)}`)
    }
  }
  return out
}

/** Builds the `codex` argument list. `outputSchemaPath` is the file written from `opts.outputSchema`. */
/** `promptOnStdin`: the prompt argument is `-` and the caller writes the prompt to stdin. */
export function buildCodexArgs(
  opts: RunOptions,
  model: ModelRef,
  outputSchemaPath?: string,
  promptOnStdin = false,
): string[] {
  const args = opts.resumeSessionId ? ['exec', 'resume', '--json'] : ['exec', '--json']
  args.push('--model', model.model)
  if (model.effort) args.push('-c', `model_reasoning_effort=${q(model.effort)}`)

  switch (opts.autonomy) {
    case 'read-only':
      args.push('--sandbox', 'read-only')
      break
    case 'workspace-write':
      args.push('--sandbox', 'workspace-write')
      break
    case 'full':
      args.push('--dangerously-bypass-approvals-and-sandbox')
      break
  }

  if (opts.mcpServers?.length) args.push(...mcpOverrides(opts.mcpServers))
  if (outputSchemaPath) args.push('--output-schema', outputSchemaPath)
  // `--image <FILE>` once per image (`codex exec --help`, `codex exec resume --help`, codex-cli 0.166.0). The flag
  // takes several values, so each goes with its own flag and the `--` below ends the list before the prompt.
  for (const image of opts.images ?? []) args.push('--image', image.path)

  // `--` so a prompt starting with "-" is never read as a flag. Codex picks its own session ids,
  // so opts.sessionId is ignored (capabilities.presetSessionId is false).
  args.push('--')
  if (opts.resumeSessionId) args.push(opts.resumeSessionId)
  args.push(promptOnStdin ? '-' : opts.prompt)
  return args
}
