import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { errorMessage, request } from '../api.js'
import type { SkillItem } from '../completion.js'
import { repoName } from '../labels.js'
import type { McpServer } from '../plugins.js'
import { commandLineOf, scopeLabel, splitCommandLine } from '../plugins.js'
import type { Repo } from '../types.js'
import { Button, IconButton } from './ui.js'

const CLI_NAMES = { 'claude-cli': 'Claude', 'codex-cli': 'Codex' } as const

interface VarRow {
  name: string
  value: string
  secret: boolean
}

/** Settings → 外掛: the owner's MCP servers, and the skills each CLI loads by itself. */
export function PluginsPanel({ repos }: { repos: Repo[] }) {
  const [servers, setServers] = useState<McpServer[] | null>(null)
  const [skills, setSkills] = useState<SkillItem[] | null>(null)
  const [adding, setAdding] = useState(false)
  const [failure, setFailure] = useState('')
  const names = useMemo(() => new Map(repos.map((repo) => [repo.id, repoName(repo.path)])), [repos])

  async function load() {
    const body = await request<{ servers: McpServer[] }>('/api/mcp-servers')
    setServers(body.servers)
  }
  useEffect(() => {
    void load().catch(() => setServers([]))
    void request<{ skills: SkillItem[] }>('/api/skills')
      .then((body) => setSkills(body.skills))
      .catch(() => setSkills([]))
  }, [])

  async function change(
    server: McpServer,
    patch: Partial<Pick<McpServer, 'enabled' | 'readOnly'>> & {
      repoIds?: string[] | null
    },
  ) {
    setFailure('')
    // Shown at once; the reload below brings back what the server kept.
    setServers(
      (current) =>
        current?.map((item) => {
          if (item.id !== server.id) return item
          const next: McpServer = {
            ...item,
            ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
          }
          if (patch.readOnly !== undefined) next.readOnly = patch.readOnly
          if (patch.repoIds === null) delete next.repoIds
          else if (patch.repoIds) next.repoIds = patch.repoIds
          return next
        }) ?? null,
    )
    try {
      await request(`/api/mcp-servers/${encodeURIComponent(server.id)}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      })
      await load()
    } catch (error) {
      setFailure(errorMessage(error, '無法更新'))
      await load().catch(() => undefined)
    }
  }

  async function remove(server: McpServer) {
    if (!window.confirm(`刪除 ${server.name}？`)) return
    setFailure('')
    try {
      await request(`/api/mcp-servers/${encodeURIComponent(server.id)}`, { method: 'DELETE' })
      await load()
    } catch (error) {
      setFailure(errorMessage(error, '無法刪除'))
    }
  }

  return (
    <>
      <section className="card settings-card" aria-label="MCP" data-testid="mcp-panel">
        <div className="section-heading">
          <h2>MCP</h2>
          {adding ? null : (
            <Button icon="plus" onClick={() => setAdding(true)}>
              新增
            </Button>
          )}
        </div>
        {adding ? (
          <McpServerForm
            repos={repos}
            onCancel={() => setAdding(false)}
            onSaved={async () => {
              setAdding(false)
              await load()
            }}
          />
        ) : null}
        {servers === null ? null : servers.length === 0 ? (
          adding ? null : (
            <p className="muted">沒有 MCP server</p>
          )
        ) : (
          <ul className="row-list">
            {servers.map((server) => (
              <li key={server.id} className="row-item plugin-row" data-testid="mcp-server">
                <span className="row-copy">
                  <strong className={server.enabled ? '' : 'muted'}>{server.name}</strong>
                  <code className="block-path">{commandLineOf(server)}</code>
                  {server.vars.length ? (
                    <span className="muted plugin-vars">
                      {server.vars.map((v) => (v.secret ? `${v.name} •••` : v.name)).join('  ')}
                    </span>
                  ) : null}
                  <ScopePicker
                    server={server}
                    repos={repos}
                    label={scopeLabel(server, names)}
                    onChange={(repoIds) => void change(server, { repoIds })}
                  />
                </span>
                <span className="plugin-controls">
                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={server.enabled}
                      aria-label={`啟用 ${server.name}`}
                      onChange={(event) => void change(server, { enabled: event.target.checked })}
                    />
                    啟用
                  </label>
                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={server.readOnly}
                      aria-label={`${server.name} 唯讀，可自動`}
                      onChange={(event) => void change(server, { readOnly: event.target.checked })}
                    />
                    唯讀，可自動
                  </label>
                  <IconButton
                    icon="trash"
                    label={`刪除 ${server.name}`}
                    className="icon-btn-sm"
                    onClick={() => void remove(server)}
                  />
                </span>
              </li>
            ))}
          </ul>
        )}
        {failure ? <p className="form-error">{failure}</p> : null}
      </section>
      <section className="card settings-card" aria-label="Skills" data-testid="skills-panel">
        <h2>Skills</h2>
        {skills === null ? null : skills.length === 0 ? (
          <p className="muted">沒有 skill</p>
        ) : (
          <ul className="row-list">
            {skills.map((skill) => (
              <li key={`${skill.cli}:${skill.name}`} className="row-item" data-testid="skill-row">
                <span className="row-copy">
                  <strong>/{skill.name}</strong>
                  {skill.description ? <span className="muted"> {skill.description}</span> : null}
                </span>
                <span className="muted plugin-cli">{CLI_NAMES[skill.cli]}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  )
}

function ScopePicker({
  server,
  repos,
  label,
  onChange,
}: {
  server: McpServer
  repos: Repo[]
  label: string
  onChange: (repoIds: string[] | null) => void
}) {
  const all = !server.repoIds
  if (!repos.length) return null
  return (
    <details className="plugin-scope">
      <summary>{label}</summary>
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={all}
          aria-label={`${server.name} 套用到所有專案`}
          onChange={(event) => onChange(event.target.checked ? null : repos.map((repo) => repo.id))}
        />
        所有專案
      </label>
      {all
        ? null
        : repos.map((repo) => (
            <label key={repo.id} className="checkbox-row">
              <input
                type="checkbox"
                checked={server.repoIds?.includes(repo.id) ?? false}
                aria-label={`${server.name} 套用到 ${repoName(repo.path)}`}
                onChange={(event) => {
                  const current = new Set(server.repoIds ?? [])
                  if (event.target.checked) current.add(repo.id)
                  else current.delete(repo.id)
                  onChange([...current])
                }}
              />
              {repoName(repo.path)}
            </label>
          ))}
    </details>
  )
}

function McpServerForm({
  repos,
  onCancel,
  onSaved,
}: {
  repos: Repo[]
  onCancel: () => void
  onSaved: () => Promise<void>
}) {
  const [transport, setTransport] = useState<'stdio' | 'http'>('stdio')
  const [vars, setVars] = useState<VarRow[]>([])
  const [failure, setFailure] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const target = String(form.get('target') ?? '').trim()
    setFailure('')
    let body: Record<string, unknown>
    try {
      const argv = transport === 'stdio' ? splitCommandLine(target) : []
      if (transport === 'stdio' && !argv.length) throw new Error('輸入指令')
      body = {
        name: String(form.get('name') ?? '').trim(),
        transport,
        ...(transport === 'stdio' ? { command: argv[0], args: argv.slice(1) } : { url: target }),
        vars: vars
          .filter((row) => row.name.trim())
          .map((row) => ({
            name: row.name.trim(),
            value: row.value,
            ...(row.secret ? { secret: true } : {}),
          })),
        readOnly: form.get('readOnly') === 'on',
        ...(repos.length && form.get('repo') ? { repoIds: [String(form.get('repo'))] } : {}),
      }
    } catch (error) {
      setFailure(errorMessage(error, '格式不對'))
      return
    }
    setBusy(true)
    try {
      await request('/api/mcp-servers', { method: 'POST', body: JSON.stringify(body) })
      await onSaved()
    } catch (error) {
      setFailure(errorMessage(error, '無法新增'))
    } finally {
      setBusy(false)
    }
  }

  const setRow = (index: number, patch: Partial<VarRow>) =>
    setVars((rows) => rows.map((row, at) => (at === index ? { ...row, ...patch } : row)))

  return (
    <form className="field-stack plugin-form" onSubmit={(event) => void submit(event)} data-testid="mcp-form">
      <div className="input-row">
        <input name="name" aria-label="名稱" placeholder="名稱" required pattern="[A-Za-z0-9_\-]{1,64}" />
        <select
          aria-label="類型"
          value={transport}
          onChange={(event) => setTransport(event.target.value as 'stdio' | 'http')}
        >
          <option value="stdio">指令</option>
          <option value="http">HTTP</option>
        </select>
      </div>
      <input
        name="target"
        aria-label={transport === 'stdio' ? '指令' : 'URL'}
        placeholder={transport === 'stdio' ? 'npx -y some-mcp-server' : 'https://'}
        required
        className="mono-input"
      />
      {vars.map((row, index) => (
        <div className="input-row" key={index}>
          <input
            aria-label={`${transport === 'stdio' ? '環境變數' : 'Header'} ${index + 1} 名稱`}
            placeholder={transport === 'stdio' ? 'NAME' : 'Header'}
            value={row.name}
            onChange={(event) => setRow(index, { name: event.target.value })}
          />
          <input
            aria-label={`${transport === 'stdio' ? '環境變數' : 'Header'} ${index + 1} 值`}
            placeholder="值"
            type={row.secret ? 'password' : 'text'}
            autoComplete="off"
            value={row.value}
            onChange={(event) => setRow(index, { value: event.target.value })}
          />
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={row.secret}
              aria-label={`變數 ${index + 1} 是秘密`}
              onChange={(event) => setRow(index, { secret: event.target.checked })}
            />
            秘密
          </label>
          <IconButton
            icon="x"
            label="移除"
            className="icon-btn-sm"
            onClick={() => setVars((rows) => rows.filter((_, at) => at !== index))}
          />
        </div>
      ))}
      <div className="input-row">
        <Button
          variant="ghost"
          icon="plus"
          onClick={() => setVars((rows) => [...rows, { name: '', value: '', secret: true }])}
        >
          {transport === 'stdio' ? '環境變數' : 'Header'}
        </Button>
      </div>
      {repos.length ? (
        <select name="repo" aria-label="專案" defaultValue="">
          <option value="">所有專案</option>
          {repos.map((repo) => (
            <option key={repo.id} value={repo.id}>
              {repoName(repo.path)}
            </option>
          ))}
        </select>
      ) : null}
      <label className="checkbox-row">
        <input type="checkbox" name="readOnly" aria-label="唯讀，可自動" />
        唯讀，可自動
      </label>
      {failure ? <p className="form-error">{failure}</p> : null}
      <div className="dialog-actions">
        <Button variant="ghost" onClick={onCancel}>
          取消
        </Button>
        <Button variant="primary" type="submit" disabled={busy}>
          新增
        </Button>
      </div>
    </form>
  )
}
