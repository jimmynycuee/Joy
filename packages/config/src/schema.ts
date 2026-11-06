import { EFFORTS, PROVIDER_KINDS, ROLES } from '@joy/core'
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
