import { PROVIDER_LABELS, ROLE_SPEAKERS } from '../labels.js'
import { costSourceLabel, formatCost, formatSpent, formatTokens } from '../usage.js'
import type { ProviderKind } from '@joy/core'
import type { RoleUsage, TaskUsage, UsageTotals } from '../types.js'

/** 「輸入 240k（快取 228k） / 輸出 693」: only the parts that were reported. */
function tokenText(usage: UsageTotals): string {
  const parts = []
  if (usage.inputTokens !== undefined) {
    const cached =
      usage.cachedInputTokens !== undefined && usage.cachedInputTokens > 0
        ? `（快取 ${formatTokens(usage.cachedInputTokens)}）`
        : ''
    parts.push(`輸入 ${formatTokens(usage.inputTokens)}${cached}`)
  }
  if (usage.outputTokens !== undefined) parts.push(`輸出 ${formatTokens(usage.outputTokens)}`)
  return parts.join(' / ')
}

function modelName(entry: { provider?: string; model?: string }): string {
  if (!entry.provider) return ''
  return `${PROVIDER_LABELS[entry.provider as ProviderKind] ?? entry.provider}${entry.model ? ` · ${entry.model}` : ''}`
}

function costText(entry: UsageTotals): string {
  return entry.costUsd !== undefined ? formatCost(entry.costUsd) : ''
}

function Row({ title, entry, time }: { title: string; entry: UsageTotals; time?: number | undefined }) {
  const facts = [
    time !== undefined && time >= 1000 ? formatSpent(time) : '',
    tokenText(entry),
    costText(entry),
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <li className="usage-row">
      <strong>{title}</strong>
      <span className="muted">{facts || '沒有回報用量'}</span>
    </li>
  )
}

function roleTitle(entry: RoleUsage): string {
  const role = ROLE_SPEAKERS[entry.role] ?? entry.role
  const model = modelName(entry)
  return model ? `${role} · ${model}` : role
}

/** Time, tokens and cost of the task, as the agents reported them. A task that reported none shows only its time. */
export function UsagePanel({ usage }: { usage: TaskUsage }) {
  const tokens = tokenText(usage)
  const source = usage.costUsd !== undefined ? costSourceLabel(usage.costSource) : ''
  return (
    <div className="panel-content">
      <dl className="usage-totals">
        <div>
          <dt>耗時</dt>
          <dd>{formatSpent(usage.durationMs)}</dd>
        </div>
        {usage.approvalWaitMs ? (
          <div>
            <dt>等核准</dt>
            <dd>{formatSpent(usage.approvalWaitMs)}</dd>
          </div>
        ) : null}
        <div>
          <dt>Token</dt>
          <dd>{tokens || '沒有回報'}</dd>
        </div>
        <div>
          <dt>估計花費</dt>
          <dd title="CLI 回報的是依標價換算的金額，訂閱不會實際扣這筆錢">
            {usage.costUsd !== undefined ? formatCost(usage.costUsd) : '沒有回報'}
            {source ? <span className="muted"> · {source}</span> : null}
          </dd>
        </div>
      </dl>
      {usage.byProvider.length > 0 ? (
        <ul className="usage-list" aria-label="各模型用量">
          {usage.byProvider.map((entry) => (
            <Row key={`${entry.provider}:${entry.model}`} title={modelName(entry)} entry={entry} />
          ))}
        </ul>
      ) : null}
      {usage.byRole.length > 0 ? (
        <ul className="usage-list" aria-label="各角色用量">
          {usage.byRole.map((entry) => (
            <Row
              key={`${entry.role}:${entry.provider ?? ''}:${entry.model ?? ''}`}
              title={roleTitle(entry)}
              entry={entry}
              time={entry.durationMs}
            />
          ))}
        </ul>
      ) : null}
    </div>
  )
}
