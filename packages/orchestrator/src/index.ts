export { compete, JUDGE_SCHEMA, synthesizeStrengths } from './compete.js'
export type {
  CompeteDeps,
  CompeteEvent,
  CompeteInput,
  CompeteJudgment,
  CompetitorResult,
  SynthesisAttemptCandidate,
  SynthesisEvent,
  SynthesisSourceCandidate,
  SynthesizedCandidate,
  SynthesizeInput,
} from './compete.js'
export { MAX_DIFF_CHARS, REVIEW_SCHEMA, formatFindings } from './prompts.js'
export { parseVerdict, reviewLoop } from './review-loop.js'
export type { LoopEvent, Phase, ReviewLoopDeps, ReviewLoopInput } from './review-loop.js'
