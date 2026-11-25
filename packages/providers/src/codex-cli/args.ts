import type { McpServerConfig, ModelRef, RunOptions } from '@joy/core'

/** TOML basic strings accept JSON string escapes, so JSON.stringify is a safe quoter. */
const q = (s: string) => JSON.stringify(s)

/** `-c key=value` overrides that add MCP servers to this run only. */
export function mcpOverrides(servers: McpServerConfig[]): string[] {
  const out: string[] = []
  for (const s of servers) {
    if (!/^[A-Za-z0-9_-]+$/.test(s.name)) throw new Error(`Invalid MCP server name "${s.name}"`)
    // `codex exec` cannot ask anyone, so a server whose every call needs approval is left out instead of being run
    // unasked (and its secrets never land on a command line, where other local processes can read them).
    if (s.approval === 'every-call') continue
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

/**
 * Not Codex's own reviewer (`approvals_reviewer = "auto_review"` in the owner's config.toml), which approves sandbox
 * escapes and network access by itself. `exec` has nobody to ask, so such requests are refused instead.
 */
const OWNER_REVIEWS = ['-c', 'approvals_reviewer="user"']

/**
 * What a run that gets everything in its prompt (the compete judge, the safety pre-review, background work) can do
 * without: the project's AGENTS.md, web search, and the built-in tools whose definitions cost the most input tokens.
 * Measured with codex-cli 0.166.0 (gpt-6-luna, low): about 21.6k → 14k input tokens per run. The owner's own
 * `CODEX_HOME/AGENTS.md` still loads: leaving it out would mean another CODEX_HOME, away from the login.
 * Only features that exist in the tested version: Codex refuses to start on an unknown `--disable` name.
 */
export const PROMPT_ONLY_FEATURES = [
  'shell_tool',
  'unified_exec',
  'view_image',
  'image_generation',
  'memories',
  'goals',
] as const
export const PROMPT_ONLY_CONFIG = { project_doc_max_bytes: 0, web_search: 'disabled' } as const

/** Builds the `codex` argument list. `outputSchemaPath` is the file written from `opts.outputSchema`. */
/** `promptOnStdin`: the prompt argument is `-` and the caller writes the prompt to stdin. */
export function buildCodexArgs(
  opts: RunOptions,
  model: ModelRef,
  outputSchemaPath?: string,
  promptOnStdin = false,
): string[] {
  const args = opts.resumeSessionId ? ['exec', 'resume', '--json'] : ['exec', '--json']
  // Only the MCP servers Joy passes below: not the owner's config.toml (its servers, approvals reviewer), plugins,
  // connectors or remote plugins, whose tools would run without Joy's approval. Login still comes from CODEX_HOME.
  // `--ignore-rules`: the owner's execpolicy `allow` rules would run matching commands outside the sandbox, unasked.
  args.push(
    '--ignore-user-config',
    '--ignore-rules',
    '--disable',
    'plugins',
    '--disable',
    'apps',
    '--disable',
    'remote_plugin',
  )
  // `--ephemeral`: no session file under CODEX_HOME, so one-off runs stay out of the Codex app's history.
  if (opts.ephemeral && !opts.resumeSessionId) args.push('--ephemeral')
  if (opts.promptOnly) {
    for (const feature of PROMPT_ONLY_FEATURES) args.push('--disable', feature)
    args.push(
      '-c',
      `project_doc_max_bytes=${PROMPT_ONLY_CONFIG.project_doc_max_bytes}`,
      '-c',
      `web_search=${q(PROMPT_ONLY_CONFIG.web_search)}`,
    )
  }
  args.push('--model', model.model)
  if (model.effort) args.push('-c', `model_reasoning_effort=${q(model.effort)}`)

  switch (opts.autonomy) {
    case 'read-only':
    case 'workspace-write':
      // `exec resume` has no `--sandbox` flag (codex-cli 0.166.0 rejects it); the config key does the same.
      args.push(
        ...(opts.resumeSessionId ? ['-c', `sandbox_mode=${q(opts.autonomy)}`] : ['--sandbox', opts.autonomy]),
        ...OWNER_REVIEWS,
      )
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
