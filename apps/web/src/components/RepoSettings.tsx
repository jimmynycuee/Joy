import { useState } from 'react'
import type { FormEvent } from 'react'
import { PROVIDER_KINDS } from '@joy/core'
import type { ProviderKind } from '@joy/core'
import { errorMessage, request } from '../api.js'
import { formatCheckCommand, shellCharactersIn } from '../check-command.js'
import { PROVIDER_LABELS, repoName } from '../labels.js'
import { REPO_COLORS, repoColor } from '../repo-colors.js'
import type { RepoColorId } from '../repo-colors.js'
import { repoPatch } from '../repo-patch.js'
import type { Repo } from '../types.js'
import { Button, ProjectDot } from './ui.js'

/** One project's settings: where its PRs go, which services may work on it, and the check run before each review. */
export function RepoSettingsCard({
  repo,
  repos,
  onSaved,
}: {
  repo: Repo
  /** Every project: the automatic colour depends on this one's place in the list. */
  repos: Repo[]
  onSaved: (repo: Repo) => void
}) {
  const [githubRemote, setGithubRemote] = useState(repo.githubRemote ?? '')
  const [providers, setProviders] = useState<ProviderKind[]>(repo.allowedProviders ?? [...PROVIDER_KINDS])
  const [checkCommand, setCheckCommand] = useState(formatCheckCommand(repo.checkCommand))
  const [color, setColor] = useState<RepoColorId | null>(repo.color ?? null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')
  const [saved, setSaved] = useState(false)

  const patch = repoPatch(repo, { githubRemote, providers, checkCommand, color })
  const changed = Object.keys(patch).length > 0
  const shellCharacter = shellCharactersIn(checkCommand)
  const name = repoName(repo.path)
  // What the dot shows in the card head right now, saved or not.
  const shown = REPO_COLORS.find((item) => item.id === color) ?? repoColor(repo.id, repos)

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
        <ProjectDot color={shown} className="project-dot-lg" />
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
        <fieldset className="color-fieldset">
          <legend>代表色</legend>
          <div className="color-options" role="radiogroup" aria-label={`${name} 的代表色`}>
            <label className={`color-option color-option-auto${color === null ? ' selected' : ''}`}>
              <input
                type="radio"
                name={`color-${repo.id}`}
                aria-label={`${name} 的代表色：自動`}
                checked={color === null}
                onChange={() => {
                  setSaved(false)
                  setColor(null)
                }}
              />
              自動
            </label>
            {REPO_COLORS.map((item) => (
              <label
                key={item.id}
                className={`color-option${color === item.id ? ' selected' : ''}`}
                title={item.label}
              >
                <input
                  type="radio"
                  name={`color-${repo.id}`}
                  aria-label={`${name} 的代表色：${item.label}`}
                  checked={color === item.id}
                  onChange={() => {
                    setSaved(false)
                    setColor(item.id)
                  }}
                />
                <span className="color-swatch" style={{ background: item.hex }} aria-hidden="true" />
              </label>
            ))}
          </div>
        </fieldset>
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
          不會經過 shell。<code>pnpm check</code>、<code>npm test</code>{' '}
          這類已知指令直接執行；其他指令每次都要你同意，沒同意就略過檢查。留空表示不檢查。
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
