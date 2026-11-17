import { useEffect, useState } from 'react'
import { errorMessage, request } from '../api.js'
import { formatDuration, modeLabel } from '../labels.js'
import type { Repo } from '../types.js'
import {
  costSourceLabel,
  formatCost,
  formatSpent,
  formatTokens,
  parseStatTasks,
  sortStatTasks,
  totalTokens,
} from '../usage.js'
import type { StatTask, TaskSort } from '../usage.js'

interface ImplementerStat {
  provider: string
  model: string
  mode: string
  attempts: number
  finished: number
  passed: number
  passRate: number | null
  findingsAgainst: number
  avgDurationMs: number | null
  handoffs: number
}

interface ReviewerStat {
  provider: string
  model: string
  reviews: number
  approvals: number
  findings: number
}

/** How each provider and model has done (T3.9), filtered by period and repository. A section of 設定. */
export function StatsPanel(props: { repos: Repo[] }) {
  const [filter, setFilter] = useState({ from: '', to: '', repoId: '' })
  const [stats, setStats] = useState<{ implementers: ImplementerStat[]; reviewers: ReviewerStat[] } | null>(
    null,
  )
  const [tasks, setTasks] = useState<StatTask[]>([])
  const [sort, setSort] = useState<TaskSort>('recent')
  const [failure, setFailure] = useState('')

  useEffect(() => {
    const query = new URLSearchParams(Object.entries(filter).filter(([, value]) => value))
    let cancelled = false
    request<{
      stats?: { implementers?: ImplementerStat[]; reviewers?: ReviewerStat[] }
      tasks?: unknown
    }>(`/api/stats?${query}`)
      .then((body) => {
        if (cancelled) return
        setFailure('')
        setStats({
          implementers: Array.isArray(body.stats?.implementers) ? body.stats.implementers : [],
          reviewers: Array.isArray(body.stats?.reviewers) ? body.stats.reviewers : [],
        })
        setTasks(parseStatTasks(body.tasks))
      })
      .catch((error: unknown) => {
        if (!cancelled) setFailure(errorMessage(error, '無法載入統計'))
      })
    return () => {
      cancelled = true
    }
  }, [filter])

  return (
    <>
      <form className="stats-filter" onSubmit={(event) => event.preventDefault()}>
        <label>
          從
          <input
            type="date"
            value={filter.from}
            onChange={(e) => setFilter({ ...filter, from: e.target.value })}
          />
        </label>
        <label>
          到
          <input
            type="date"
            value={filter.to}
            onChange={(e) => setFilter({ ...filter, to: e.target.value })}
          />
        </label>
        <label>
          專案
          <select value={filter.repoId} onChange={(e) => setFilter({ ...filter, repoId: e.target.value })}>
            <option value="">全部</option>
            {props.repos.map((repo) => (
              <option key={repo.id} value={repo.id}>
                {repo.path}
              </option>
            ))}
          </select>
        </label>
      </form>
      {failure ? <p className="form-error">{failure}</p> : null}
      <section className="card">
        <h2>擔任實作者</h2>
        {stats && stats.implementers.length === 0 ? <p className="muted">沒有紀錄</p> : null}
        {stats && stats.implementers.length ? (
          <div className="table-wrap">
            <table className="stats-table" aria-label="實作者統計">
              <thead>
                <tr>
                  <th>模型</th>
                  <th>模式</th>
                  <th>次數</th>
                  <th>通過率</th>
                  <th>被審查找到的問題</th>
                  <th>平均耗時</th>
                  <th>交接次數</th>
                </tr>
              </thead>
              <tbody>
                {stats.implementers.map((row) => (
                  <tr key={`${row.provider}/${row.model}/${row.mode}`}>
                    <td>
                      {row.provider} · {row.model}
                    </td>
                    <td>{modeLabel(row.mode)}</td>
                    <td>{row.attempts}</td>
                    <td>
                      {row.passRate === null ? '—' : `${Math.round(row.passRate * 100)}%`}
                      <span className="muted">
                        {' '}
                        ({row.passed}/{row.finished})
                      </span>
                    </td>
                    <td>{row.findingsAgainst}</td>
                    <td>{formatDuration(row.avgDurationMs)}</td>
                    <td>{row.handoffs}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
      <section className="card">
        <h2>擔任審查者</h2>
        {stats && stats.reviewers.length === 0 ? <p className="muted">沒有紀錄</p> : null}
        {stats && stats.reviewers.length ? (
          <div className="table-wrap">
            <table className="stats-table" aria-label="審查者統計">
              <thead>
                <tr>
                  <th>模型</th>
                  <th>審查次數</th>
                  <th>通過</th>
                  <th>找到的問題</th>
                </tr>
              </thead>
              <tbody>
                {stats.reviewers.map((row) => (
                  <tr key={`${row.provider}/${row.model}`}>
                    <td>
                      {row.provider} · {row.model}
                    </td>
                    <td>{row.reviews}</td>
                    <td>{row.approvals}</td>
                    <td>{row.findings}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
      {tasks.length > 0 ? <TaskUsageTable tasks={tasks} sort={sort} onSort={setSort} /> : null}
    </>
  )
}

/** A header that sorts the tasks by its column; the same column again goes back to the newest first. */
function SortHeader(props: {
  label: string
  by: TaskSort
  sort: TaskSort
  onSort: (sort: TaskSort) => void
}) {
  const active = props.sort === props.by
  return (
    <th aria-sort={active ? 'descending' : undefined}>
      <button
        type="button"
        className="sort-header"
        onClick={() => props.onSort(active ? 'recent' : props.by)}
      >
        {props.label}
        {active ? ' ↓' : ''}
      </button>
    </th>
  )
}

/** What each task of the period took, to compare them. A task that reported no tokens or cost shows a dash. */
function TaskUsageTable(props: { tasks: StatTask[]; sort: TaskSort; onSort: (sort: TaskSort) => void }) {
  const rows = sortStatTasks(props.tasks, props.sort)
  return (
    <section className="card">
      <h2>各任務用量</h2>
      <div className="table-wrap">
        <table className="stats-table" aria-label="各任務用量">
          <thead>
            <tr>
              <th>任務</th>
              <SortHeader label="耗時" by="duration" sort={props.sort} onSort={props.onSort} />
              <SortHeader label="Token" by="tokens" sort={props.sort} onSort={props.onSort} />
              <SortHeader label="花費" by="cost" sort={props.sort} onSort={props.onSort} />
              <th>模型</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((task) => {
              const tokens = totalTokens(task.usage)
              const source = costSourceLabel(task.usage.costSource)
              return (
                <tr key={task.id}>
                  <td className="stats-task-title" title={task.title}>
                    {task.title}
                  </td>
                  <td>{formatSpent(task.usage.durationMs)}</td>
                  <td>{tokens !== undefined ? formatTokens(tokens) : '—'}</td>
                  <td title={source}>
                    {task.usage.costUsd !== undefined ? formatCost(task.usage.costUsd) : '—'}
                  </td>
                  <td>{task.usage.byProvider.map((entry) => entry.model).join('、') || '—'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}
