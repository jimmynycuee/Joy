import { isIP } from 'node:net'
import { ACTION_KINDS, EFFORTS, PROVIDER_KINDS, ROLES, TASK_MODES } from '@joy/core'
import type { ModelRef, Role } from '@joy/core'
import { effortCompatibilityError } from '@joy/model-effort'
import { z } from 'zod'

const modelRef = z
  .strictObject({
    provider: z.enum(PROVIDER_KINDS),
    model: z.string().trim().min(1),
    effort: z.enum(EFFORTS).optional(),
  })
  .superRefine((ref, ctx) => {
    if (!ref.effort) return
    const issue = effortCompatibilityError(ref.provider, ref.model, ref.effort)
    if (issue) ctx.addIssue({ code: 'custom', path: ['effort'], message: issue })
  })

/**
 * Model names here are defaults the owner is expected to change; nothing in code depends on them.
 * Coding roles use the subscription CLIs; high-frequency roles use the cheap API model.
 */
export const DEFAULT_ROLES: Record<Role, ModelRef> = {
  assistant_brain: { provider: 'openai-api', model: 'gpt-6-luna', effort: 'low' },
  background: { provider: 'openai-api', model: 'gpt-6-luna', effort: 'low' },
  orchestrator: { provider: 'claude-cli', model: 'opus', effort: 'high' },
  implementer: { provider: 'claude-cli', model: 'opus', effort: 'medium' },
  reviewer: { provider: 'codex-cli', model: 'gpt-6.1-sol', effort: 'medium' },
  judge: { provider: 'codex-cli', model: 'gpt-6.1-sol', effort: 'medium' },
}

const roles = z.strictObject(
  Object.fromEntries(ROLES.map((r) => [r, modelRef.default(DEFAULT_ROLES[r])])) as {
    [R in Role]: z.ZodDefault<typeof modelRef>
  },
)

const cliPath = z.strictObject({ command: z.string().min(1).optional() })
const codexCli = z.strictObject({
  command: z.string().min(1).optional(),
  /** `app-server` supports approvals and quota events; `exec` is the older one-shot JSONL fallback. */
  transport: z.enum(['app-server', 'exec']).default('app-server'),
  /** Windows: run `codex exec` inside WSL (needs transport exec and Codex installed in WSL). T4.4. */
  wsl: z.boolean().default(false),
})

export const configSchema = z.strictObject({
  roles: roles.default(() => roles.parse({})),
  fallback: z
    .strictObject({
      /** When a subscription CLI hits its usage limit. */
      on_rate_limit: z.enum(['swap_provider', 'queue', 'fail']).default('swap_provider'),
    })
    .default({ on_rate_limit: 'swap_provider' }),
  budget: z
    .strictObject({
      openai_api_usd_monthly_cap: z.number().nonnegative().default(30),
      per_task: z
        .strictObject({
          max_rounds: z.number().int().min(1).max(20).default(3),
          max_minutes: z
            .number()
            .int()
            .min(1)
            .max(24 * 60)
            .default(60),
          max_api_usd: z.number().nonnegative().default(1),
        })
        .default({ max_rounds: 3, max_minutes: 60, max_api_usd: 1 }),
    })
    .default({
      openai_api_usd_monthly_cap: 30,
      per_task: { max_rounds: 3, max_minutes: 60, max_api_usd: 1 },
    }),
  approvals: z
    .strictObject({
      /** How long a red action waits for the owner before it counts as not approved. */
      timeout_minutes: z
        .number()
        .int()
        .min(1)
        .max(24 * 60)
        .default(30),
      /** After the timeout: pause the task until you approve later ('pause'), or deny and let the agent go on. */
      on_timeout: z.enum(['pause', 'deny']).default('pause'),
    })
    .default({ timeout_minutes: 30, on_timeout: 'pause' }),
  channels: z
    .strictObject({
      telegram: z
        .strictObject({
          /** Your own chat id with the bot. Joy ignores every other chat. The bot token lives in the keychain. */
          owner_chat_id: z
            .string()
            .regex(/^-?\d+$/, 'must be a numeric Telegram chat id')
            .optional(),
        })
        .default({}),
    })
    .default({ telegram: {} }),
  autonomy_mode: z.enum(['careful', 'normal', 'hands-off']).default('normal'),
  github: z
    .strictObject({
      /** Open issues with this label become tasks (repositories with a GitHub remote only). */
      issue_label: z.string().trim().min(1).max(100).default('joy'),
      /** How often to look for labelled issues; 0 turns label import off. */
      issue_poll_minutes: z.number().int().min(0).max(1440).default(5),
    })
    .default({ issue_label: 'joy', issue_poll_minutes: 5 }),
  remote: z
    .strictObject({
      /**
       * Also listen on `address` (e.g. this computer's Tailscale IP) so other devices can use Joy with the access
       * token. Off by default; Joy otherwise listens on 127.0.0.1 only. Restart Joy after changing it.
       */
      enabled: z.boolean().default(false),
      address: z
        .string()
        .refine((value) => value === '' || isIP(value) !== 0, 'must be an IP address')
        .refine(
          (value) => !isUnspecifiedAddress(value),
          'must be one interface (e.g. the Tailscale IP), not 0.0.0.0 or ::, which listens on every network',
        )
        .default(''),
      port: z.number().int().min(0).max(65535).default(4317),
      /**
       * Host names an HTTPS reverse proxy on this computer forwards to Joy's 127.0.0.1 listener, e.g. the name
       * `tailscale serve` gives this machine (`my-pc.tailnet-123.ts.net`). Allows that Host and its https:// Origin,
       * which phones need for installing the app and push notifications. Works with or without `enabled`.
       */
      https_hosts: z
        .array(
          z
            .string()
            .regex(
              /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/i,
              'must be a host name such as my-pc.tailnet-123.ts.net (no scheme, port or path)',
            )
            .refine((value) => !/^localhost$/i.test(value), 'localhost is always allowed'),
        )
        .max(5)
        .default([]),
    })
    .refine((remote) => !remote.enabled || remote.address !== '', {
      message: 'remote.address is required when remote.enabled is true',
    })
    .default({ enabled: false, address: '', port: 4317, https_hosts: [] }),
  container: z
    .strictObject({
      /** Image with Claude Code, Codex, git and node (build it with `pnpm joy container-build`). */
      image: z
        .string()
        .regex(/^[\w./:@-]+$/)
        .default('joy-agent:latest'),
      /** `host`: the CLI reaches its model and Joy's approvals. `none`: no network at all (the CLI cannot work). */
      network: z.enum(['host', 'none']).default('host'),
    })
    .default({ image: 'joy-agent:latest', network: 'host' }),
  /**
   * Custom workflows (T5.6), by name: a pattern (single, review_loop or compete), the model for each role it uses and
   * its options. The built-in workflows are the three patterns themselves; these add variations, e.g. a careful review
   * loop with Codex implementing and Claude reviewing.
   */
  workflows: z
    .record(
      z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/, 'workflow names are lowercase letters, digits, - or _'),
      z.strictObject({
        description: z.string().max(300).optional(),
        pattern: z.enum(TASK_MODES),
        roles: z
          .strictObject(
            Object.fromEntries(ROLES.map((r) => [r, modelRef.optional()])) as {
              [R in Role]: z.ZodOptional<typeof modelRef>
            },
          )
          .optional(),
        max_rounds: z.number().int().min(1).max(20).optional(),
        plan_first: z.boolean().optional(),
      }),
    )
    .refine((workflows) => !['single', 'review_loop', 'compete'].some((name) => name in workflows), {
      message: 'single, review_loop and compete are built-in workflow names',
    })
    .default({}),
  /**
   * Outside MCP servers the assistant may use (T3.8), e.g. Google Workspace:
   * `google: { command: uvx, args: [workspace-mcp, --tools, gmail, calendar] }`. Each server keeps its own login.
   * `tools` overrides how a tool is classified for the permission rules (tool name → action kind).
   */
  mcp_servers: z
    .record(
      z.string().regex(/^[a-z][a-z0-9_]{0,19}$/, 'MCP server names are lowercase letters, digits or _'),
      z.strictObject({
        command: z.string().min(1),
        args: z.array(z.string()).default([]),
        tools: z.record(z.string(), z.enum(ACTION_KINDS)).optional(),
      }),
    )
    .default({}),
  worktrees: z
    .strictObject({
      /** Idle worktrees older than this are offered for cleanup in the UI (never removed without the owner). */
      stale_after_days: z.number().int().min(1).max(365).default(14),
    })
    .default({ stale_after_days: 14 }),
  tool_hub: z
    .strictObject({ max_ask_peer_calls: z.number().int().min(1).max(100).default(5) })
    .default({ max_ask_peer_calls: 5 }),
  providers: z
    .strictObject({
      claude: cliPath.default({}),
      codex: codexCli.default({ transport: 'app-server', wsl: false }),
    })
    .default({ claude: {}, codex: { transport: 'app-server', wsl: false } }),
  paths: z
    .strictObject({
      /** Defaults to `<JOY_HOME>/worktrees`. */
      worktrees: z.string().min(1).optional(),
      /** Defaults to `<JOY_HOME>/joy.sqlite`. */
      database: z.string().min(1).optional(),
    })
    .default({}),
})

export type JoyConfig = z.infer<typeof configSchema>
/** What a config file may contain: everything optional. */
export type JoyConfigInput = z.input<typeof configSchema>

export function defaultConfig(): JoyConfig {
  return configSchema.parse({})
}

/** 0.0.0.0 or ::, which bind every network interface instead of one. */
function isUnspecifiedAddress(value: string): boolean {
  if (isIP(value) === 4) return value.split('.').every((part) => Number(part) === 0)
  if (isIP(value) === 6) return /^[0:]+$/.test(value) || /^::ffff:0+\.0+\.0+\.0+$/i.test(value)
  return false
}
