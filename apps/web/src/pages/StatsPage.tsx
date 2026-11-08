import { useEffect, useState } from 'react'
import { errorMessage, request } from '../api.js'
import { formatDuration, modeLabel } from '../labels.js'
import type { Repo } from '../types.js'

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

/** How each provider and model has done (T3.9), filtered by period and repository. */
export function StatsPage(props: { repos: Repo[] }) {
  const [filter, setFilter] = useState({ from: '', to: '', repoId: '' })
  const [stats, setStats] = useState<{ implementers: ImplementerStat[]; reviewers: ReviewerStat[] } | null>(
    null,
  )
  const [failure, setFailure] = useState('')

  useEffect(() => {
    const query = new URLSearchParams(Object.entries(filter).filter(([, value]) => value))
    let cancelled = false
    request<{ stats?: { implementers?: ImplementerStat[]; reviewers?: ReviewerStat[] } }>(
      `/api/stats?${query}`,
    )
      .then((body) => {
        if (cancelled) return
        setFailure('')
        setStats({
          implementers: Array.isArray(body.stats?.implementers) ? body.stats.implementers : [],
          reviewers: Array.isArray(body.stats?.reviewers) ? body.stats.reviewers : [],
        })
      })
      .catch((error: unknown) => {
        if (!cancelled) setFailure(errorMessage(error, '無法載入統計'))
      })
    return () => {
      cancelled = true
    }
  }, [filter])

  return (
    <main className="page stats-page" data-testid="stats-page">
      <div className="page-inner">
        <div className="page-heading">
          <h1>模型統計</h1>
          <p className="muted">哪個模型做得好、哪個模型審查得準。</p>
        </div>
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
          {stats && stats.implementers.length === 0 ? <p className="muted">這段期間沒有實作紀錄。</p> : null}
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
          {stats && stats.reviewers.length === 0 ? <p className="muted">這段期間沒有審查紀錄。</p> : null}
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
      </div>
    </main>
  )
}
