import { useState } from 'react'
import type { FormEvent } from 'react'
import { PROVIDER_KINDS } from '@joy/core'
import type { ProviderKind } from '@joy/core'
import { errorMessage, request } from '../api.js'
import { formatCheckCommand, shellCharactersIn } from '../check-command.js'
import { PROVIDER_LABELS, repoName } from '../labels.js'
import { repoPatch } from '../repo-patch.js'
import type { Repo } from '../types.js'
import { Button } from './ui.js'

/** One project's settings: where its PRs go, which services may work on it, and the check run before each review. */
export function RepoSettingsCard({ repo, onSaved }: { repo: Repo; onSaved: (repo: Repo) => void }) {
  const [githubRemote, setGithubRemote] = useState(repo.githubRemote ?? '')
  const [providers, setProviders] = useState<ProviderKind[]>(repo.allowedProviders ?? [...PROVIDER_KINDS])
  const [checkCommand, setCheckCommand] = useState(formatCheckCommand(repo.checkCommand))
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')
  const [saved, setSaved] = useState(false)

  const patch = repoPatch(repo, { githubRemote, providers, checkCommand })
  const changed = Object.keys(patch).length > 0
  const shellCharacter = shellCharactersIn(checkCommand)
  const name = repoName(repo.path)

  function toggleProvider(kind: ProviderKind, on: boolean) {
    setSaved(false)
    setProviders((current) => (on ? [...current, kind] : current.filter((item) => item !== kind)))
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!changed) return
    if (providers.length === 0) {
      setFailure('至少要允許一個服務')
      return
    }
    setBusy(true)
    setFailure('')
    try {
      const { repo: updated } = await request<{ repo: Repo }>(`/api/repos/${encodeURIComponent(repo.id)}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      })
      onSaved(updated)
      setSaved(true)
    } catch (cause) {
      setFailure(errorMessage(cause, '無法儲存專案設定'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className="repo-card"
      aria-label={`${name} 的專案設定`}
      data-testid="repo-settings"
      onSubmit={(event) => void save(event)}
    >
      <div className="repo-card-head">
        <strong>{name}</strong>
        <span className="muted"> · 預設分支 {repo.defaultBranch}</span>
        <code className="block-path">{repo.path}</code>
      </div>
      <div className="field-stack">
        <label>
          GitHub 網址
          <input
            name="githubRemote"
            aria-label={`${name} 的 GitHub 網址`}
            placeholder="https://github.com/owner/repo.git"
            value={githubRemote}
            onChange={(event) => {
              setSaved(false)
              setGithubRemote(event.target.value)
            }}
          />
        </label>
        <fieldset className="provider-fieldset">
          <legend>允許使用的服務</legend>
          <div className="provider-options">
            {PROVIDER_KINDS.map((kind) => (
              <label key={kind} className="checkbox-row">
                <input
                  type="checkbox"
                  aria-label={`${name} 允許 ${PROVIDER_LABELS[kind]}`}
                  checked={providers.includes(kind)}
                  onChange={(event) => toggleProvider(kind, event.target.checked)}
                />
                {PROVIDER_LABELS[kind]}
              </label>
            ))}
          </div>
          <p className="muted">這個專案的任務只會用勾選的服務，各個角色都要用得到其中一個。</p>
        </fieldset>
        <label>
          送審前檢查指令
          <input
            name="checkCommand"
            aria-label={`${name} 的檢查指令`}
            placeholder="pnpm check"
            autoComplete="off"
            spellCheck={false}
            value={checkCommand}
            onChange={(event) => {
              setSaved(false)
              setCheckCommand(event.target.value)
            }}
          />
        </label>
        <p className="muted">
          用空白分隔指令與參數，不會經過 shell（沒有引號、管線、&& 或環境變數）。像 <code>pnpm check</code>、
          <code>npm test</code>{' '}
          這種已知只在工作副本內執行的指令會直接執行；其他指令每次都需要你同意，沒同意就會略過檢查。
          留空表示不檢查。
        </p>
        {shellCharacter ? (
          <p className="notice-line" role="status">
            偵測到 <code>{shellCharacter}</code>：它會原封不動傳給程式，不會被 shell 解讀。
          </p>
        ) : null}
      </div>
      <div className="save-bar">
        <span className="muted" role="status">
          {saved ? '已儲存' : failure ? '' : changed ? '有尚未儲存的變更' : ''}
        </span>
        <Button variant="primary" type="submit" disabled={!changed || busy}>
          儲存專案設定
        </Button>
      </div>
      {failure ? <p className="form-error">{failure}</p> : null}
    </form>
  )
}
