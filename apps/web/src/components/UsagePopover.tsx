import { PROVIDER_LABELS } from '../labels.js'
import { costIsEstimate, formatCost, formatSpent, formatTokens } from '../usage.js'
import type { ProviderKind } from '@joy/core'
import type { ProviderUsage, TaskUsage } from '../types.js'
import { Popover } from './Popover.js'

function tokenText(usage: { inputTokens?: number; outputTokens?: number }): string {
  const parts = []
  if (usage.inputTokens !== undefined) parts.push(`輸入 ${formatTokens(usage.inputTokens)}`)
  if (usage.outputTokens !== undefined) parts.push(`輸出 ${formatTokens(usage.outputTokens)}`)
  return parts.join(' / ')
}

function ProviderRow({ entry }: { entry: ProviderUsage }) {
  const tokens = tokenText(entry)
  return (
    <li className="usage-row">
      <strong>
        {PROVIDER_LABELS[entry.provider as ProviderKind] ?? entry.provider} · {entry.model}
      </strong>
      <span className="muted">
        {[
          tokens,
          entry.costUsd !== undefined
            ? `${formatCost(entry.costUsd)}${costIsEstimate(entry.provider) ? '（估算）' : ''}`
            : '',
        ]
          .filter(Boolean)
          .join(' · ') || '沒有回報用量'}
      </span>
    </li>
  )
}

/** Time, tokens and cost of the task. The CLIs' cost is their own estimate, not what a subscription billed. */
export function UsagePopover({ usage }: { usage: TaskUsage }) {
  const tokens = tokenText(usage)
  return (
    <Popover icon="chart" label="用量" buttonLabel={`用量 · ${formatSpent(usage.durationMs)}`}>
      <h2 className="popover-title">這個任務的用量</h2>
      <dl className="usage-totals">
        <div>
          <dt>耗時</dt>
          <dd>{formatSpent(usage.durationMs)}</dd>
        </div>
        <div>
          <dt>Token</dt>
          <dd>{tokens || '沒有回報'}</dd>
        </div>
        <div>
          <dt>估計花費</dt>
          <dd>{usage.costUsd !== undefined ? formatCost(usage.costUsd) : '沒有回報'}</dd>
        </div>
      </dl>
      {usage.byProvider.length > 0 ? (
        <ul className="usage-list" aria-label="各模型用量">
          {usage.byProvider.map((entry) => (
            <ProviderRow key={`${entry.provider}:${entry.model}`} entry={entry} />
          ))}
        </ul>
      ) : null}
      <p className="muted">花費依價目表估算，不是訂閱實際扣的錢；權限預審等額外呼叫不在內。</p>
    </Popover>
  )
}
