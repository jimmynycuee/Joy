// Workflows (T5.6): the division-of-labour patterns as data. A workflow names a pattern (one model alone, implement +
// cross-model review, or compete), says which model plays each role, and sets the pattern's options. The three task
// modes Joy started with are the built-in workflows; the owner adds others in config.yaml.
import type { ModelRef, Role, RoleConfig, TaskMode } from '@joy/core'

export type WorkflowPattern = TaskMode

export interface Workflow {
  name: string
  description?: string
  pattern: WorkflowPattern
  /** Models for this workflow's roles; a role left out uses the global role setting. */
  roles?: Partial<Record<Role, ModelRef>>
  /** review_loop only: most review rounds before a human decides. */
  maxRounds?: number
  /** review_loop only: plan, have the plan reviewed, then implement. */
  planFirst?: boolean
}

/** The roles each pattern uses; a workflow may only set these. */
export const PATTERN_ROLES: Record<WorkflowPattern, Role[]> = {
  single: ['implementer'],
  review_loop: ['implementer', 'reviewer'],
  compete: ['implementer', 'reviewer', 'judge'],
}

export const BUILT_IN_WORKFLOWS: readonly Workflow[] = [
  { name: 'single', pattern: 'single', description: 'One model implements; no review.' },
  {
    name: 'review_loop',
    pattern: 'review_loop',
    description: 'One model implements, another reviews; fixes until approved or rounds run out.',
  },
  {
    name: 'compete',
    pattern: 'compete',
    description: 'Two models implement in parallel, each reviewed once; a judge compares.',
  },
]

export const WORKFLOW_NAME = /^[a-z][a-z0-9_-]{0,39}$/

/** Problems that make a workflow unusable, as messages the owner can act on (empty when it is fine). */
export function workflowProblems(workflow: Workflow): string[] {
  const problems: string[] = []
  if (!WORKFLOW_NAME.test(workflow.name))
    problems.push(
      `Workflow name "${workflow.name}" must be lowercase letters, digits, - or _, starting with a letter`,
    )
  const allowed = PATTERN_ROLES[workflow.pattern]
  for (const role of Object.keys(workflow.roles ?? {}) as Role[])
    if (!allowed.includes(role))
      problems.push(
        `Workflow "${workflow.name}": the ${workflow.pattern} pattern does not use the ${role} role`,
      )
  if (
    workflow.pattern !== 'review_loop' &&
    (workflow.maxRounds !== undefined || workflow.planFirst !== undefined)
  )
    problems.push(
      `Workflow "${workflow.name}": max_rounds and plan_first only apply to the review_loop pattern`,
    )
  if (workflow.pattern === 'compete' && workflow.roles?.implementer && workflow.roles.reviewer) {
    const { implementer, reviewer } = workflow.roles
    if (implementer.provider === reviewer.provider && implementer.model === reviewer.model)
      problems.push(
        `Workflow "${workflow.name}": compete needs two different models for implementer and reviewer`,
      )
  }
  return problems
}

/** What a task needs to run this workflow: the existing task mode plus its role choices and options. */
export function workflowTask(workflow: Workflow): {
  mode: TaskMode
  roleOverrides: Partial<RoleConfig>
  maxRounds?: number
  planFirst?: boolean
} {
  return {
    mode: workflow.pattern,
    roleOverrides: { ...(workflow.roles ?? {}) },
    ...(workflow.maxRounds !== undefined ? { maxRounds: workflow.maxRounds } : {}),
    ...(workflow.planFirst !== undefined ? { planFirst: workflow.planFirst } : {}),
  }
}

/** The built-in workflow and custom ones by name; custom names may not shadow built-ins. */
export function findWorkflow(name: string, custom: readonly Workflow[] = []): Workflow | undefined {
  return BUILT_IN_WORKFLOWS.find((w) => w.name === name) ?? custom.find((w) => w.name === name)
}
