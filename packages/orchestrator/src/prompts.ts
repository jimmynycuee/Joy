// Prompts sent to the agents. Kept together so they can be tuned without touching the flow.
import type { ReviewVerdict } from '@joy/core'

/** Big diffs are cut so the reviewer prompt stays within reason; the reviewer can read files itself. */
export const MAX_DIFF_CHARS = 60_000

export const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['approve', 'summary', 'findings'],
  properties: {
    approve: { type: 'boolean', description: 'true only if the change is ready to merge as is' },
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        // Every key is required (OpenAI strict mode); optional ones are nullable instead.
        required: ['severity', 'file', 'line', 'message'],
        properties: {
          severity: { type: 'string', enum: ['blocker', 'major', 'minor', 'nit'] },
          file: { type: ['string', 'null'] },
          line: { type: ['integer', 'null'] },
          message: { type: 'string' },
        },
      },
    },
  },
} as const

export function planPrompt(task: string): string {
  return [
    'Write a short implementation plan for the task below. Do not change any files yet.',
    'List the files you will touch, the approach, and how you will test it.',
    '',
    `Task:\n${task}`,
  ].join('\n')
}

export function planReviewPrompt(task: string, plan: string): string {
  return [
    "You are reviewing another engineer's implementation plan before any code is written.",
    'Approve only if the plan is sound. Point out missing cases, risky choices and simpler alternatives.',
    '',
    `Task:\n${task}`,
    '',
    `Plan:\n${plan}`,
  ].join('\n')
}

export function implementPrompt(task: string, plan?: string, planReview?: ReviewVerdict): string {
  const parts = [`Implement this task in the current repository. Run the tests that exist.\n\nTask:\n${task}`]
  if (plan) parts.push(`Your plan:\n${plan}`)
  if (planReview && planReview.findings.length)
    parts.push(`A reviewer commented on the plan:\n${formatFindings(planReview)}`)
  return parts.join('\n\n')
}

export function reviewPrompt(task: string, patch: string): string {
  const cut = patch.length > MAX_DIFF_CHARS
  return [
    'You are reviewing a change written by another engineer (a different AI model). Be specific and skeptical:',
    'look for bugs, missing edge cases, broken tests, security problems and needless complexity.',
    'You may read files in the repository, but do not modify anything.',
    'Approve only if it is ready to merge as is. Use "blocker" or "major" for anything that must change.',
    '',
    `Task:\n${task}`,
    '',
    `Diff${cut ? ` (first ${MAX_DIFF_CHARS} characters of ${patch.length})` : ''}:`,
    '```diff',
    cut ? patch.slice(0, MAX_DIFF_CHARS) : patch,
    '```',
  ].join('\n')
}

export function fixPrompt(verdict: ReviewVerdict): string {
  return [
    'A reviewer (a different AI model) looked at your change and did not approve it.',
    'Address every blocker and major finding. Fix minor ones when cheap. If you disagree with a finding,',
    'leave the code as is and explain why in your final message.',
    '',
    `Summary: ${verdict.summary}`,
    '',
    formatFindings(verdict),
  ].join('\n')
}

export function formatFindings(v: ReviewVerdict): string {
  if (!v.findings.length) return '(no specific findings)'
  return v.findings
    .map((f) => `- [${f.severity}] ${f.file ? `${f.file}${f.line ? `:${f.line}` : ''}: ` : ''}${f.message}`)
    .join('\n')
}
