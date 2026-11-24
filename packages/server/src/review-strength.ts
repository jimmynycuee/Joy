import type { JoyConfig } from '@joy/config'
import type { ModelRef } from '@joy/core'
import { EFFORTS } from '@joy/core'
import { effortCompatibilityError } from '@joy/model-effort'

/**
 * The reviewer for small changes: the same model at `review.small_change_effort`. undefined when it is turned off,
 * would not be lighter than the configured effort, or that model does not take that effort.
 */
export function smallChangeReviewer(
  reviewer: ModelRef,
  review: JoyConfig['review'],
): { model: ModelRef; maxChangedLines: number } | undefined {
  if (review.small_change_max_lines === 0) return undefined
  const effort = review.small_change_effort
  if (reviewer.effort && EFFORTS.indexOf(reviewer.effort) <= EFFORTS.indexOf(effort)) return undefined
  if (effortCompatibilityError(reviewer.provider, reviewer.model, effort)) return undefined
  return { model: { ...reviewer, effort }, maxChangedLines: review.small_change_max_lines }
}
