import { EFFORTS, PROVIDER_KINDS, ROLES } from '@joy/core'
import type { ModelRef, Role } from '@joy/core'
import { z } from 'zod'

const modelRef = z.strictObject({
  provider: z.enum(PROVIDER_KINDS),
  model: z.string().trim().min(1),
  effort: z.enum(EFFORTS).optional(),
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
  autonomy_mode: z.enum(['careful', 'normal', 'hands-off']).default('normal'),
  providers: z
    .strictObject({
      claude: cliPath.default({}),
      codex: cliPath.default({}),
    })
    .default({ claude: {}, codex: {} }),
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
