import { useState } from 'react'
import type { FormEvent } from 'react'
import { PERMISSION_MODES, PROVIDER_KINDS } from '@joy/core'
import type { PermissionMode, ProviderKind } from '@joy/core'
import { errorMessage, request } from '../api.js'
import { formatCheckCommand, shellCharactersIn } from '../check-command.js'
import { MODE_LABELS, PERMISSION_HINTS, PERMISSION_LABELS, PROVIDER_LABELS, repoName } from '../labels.js'
import { IMPLEMENTER_MODELS, MODEL_CATALOG, modelLabel } from '../models.js'
import { DEFAULT_MODES, MAX_INSTRUCTIONS, buildDefaults, defaultsForm, refKey } from '../project-defaults.js'
import type { DefaultsForm } from '../project-defaults.js'
import { REPO_COLORS, repoColor } from '../repo-colors.js'
import type { RepoColorId } from '../repo-colors.js'
import { repoPatch } from '../repo-patch.js'
import type { Repo } from '../types.js'
import { Button, ProjectDot } from './ui.js'

function permissionAllowed(mode: PermissionMode, max: PermissionMode | null): boolean {
  return !max || PERMISSION_MODES.indexOf(mode) <= PERMISSION_MODES.indexOf(max)
}

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
  const [maxPermissionMode, setMaxPermissionMode] = useState<PermissionMode | null>(
    repo.maxPermissionMode ?? null,
  )
  const [instructions, setInstructions] = useState(repo.instructions ?? '')
  const [installCommand, setInstallCommand] = useState(formatCheckCommand(repo.installCommand))
  const [defaults, setDefaults] = useState<DefaultsForm>(() => defaultsForm(repo.defaults))
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')
  const [saved, setSaved] = useState(false)

  const patch = repoPatch(repo, {
    githubRemote,
    providers,
    checkCommand,
    color,
    maxPermissionMode,
    instructions,
    installCommand,
    defaults: buildDefaults(defaults, repo.defaults),
  })
  const changed = Object.keys(patch).length > 0
  const shellCharacter = shellCharactersIn(checkCommand)
  const installShellCharacter = shellCharactersIn(installCommand)
  const name = repoName(repo.path)
  // What the dot shows in the card head right now, saved or not.
  const shown = REPO_COLORS.find((item) => item.id === color) ?? repoColor(repo.id, repos)

  function toggleProvider(kind: ProviderKind, on: boolean) {
    setSaved(false)
    setProviders((current) => (on ? [...current, kind] : current.filter((item) => item !== kind)))
    // A default model from a service the project no longer allows would be refused on save: drop it with the service.
    if (!on)
      setDefaults((current) => ({
        ...current,
        implementer: current.implementer.startsWith(`${kind}|`) ? '' : current.implementer,
        reviewer: current.reviewer.startsWith(`${kind}|`) ? '' : current.reviewer,
      }))
  }

  function setDefault<K extends keyof DefaultsForm>(key: K, value: DefaultsForm[K]) {
    setSaved(false)
    setDefaults((current) => ({ ...current, [key]: value }))
  }

  /** The models a role can default to: the project's allowed services, plus a stored one that is not in the catalog. */
  function modelOptions(role: 'implementer' | 'reviewer') {
    const catalog = (role === 'implementer' ? IMPLEMENTER_MODELS : MODEL_CATALOG).filter((entry) =>
      providers.includes(entry.provider),
    )
    const options = catalog.map((entry) => ({ value: refKey(entry), label: modelLabel(entry) }))
    const stored = repo.defaults?.[role]
    if (stored && providers.includes(stored.provider) && !options.some((o) => o.value === refKey(stored)))
      options.push({ value: refKey(stored), label: modelLabel(stored) })
    return options
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
          最高權限
          <select
            aria-label={`${name} 的最高權限`}
            value={maxPermissionMode ?? ''}
            title={maxPermissionMode ? PERMISSION_HINTS[maxPermissionMode] : undefined}
            onChange={(event) => {
              setSaved(false)
              const max = (event.target.value || null) as PermissionMode | null
              setMaxPermissionMode(max)
              // A default above the new maximum would be refused on save: it goes down with the maximum.
              if (max && defaults.permissionMode && !permissionAllowed(defaults.permissionMode, max))
                setDefaults((current) => ({ ...current, permissionMode: max }))
            }}
          >
            <option value="">不限制</option>
            {PERMISSION_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {PERMISSION_LABELS[mode]}
              </option>
            ))}
          </select>
        </label>
        <fieldset className="defaults-fieldset">
          <legend>新任務的預設</legend>
          <div className="defaults-grid">
            {(['implementer', 'reviewer'] as const).map((role) => (
              <label key={role}>
                {role === 'implementer' ? '實作者' : '審查者'}
                <select
                  aria-label={`${name} 的預設${role === 'implementer' ? '實作者' : '審查者'}`}
                  value={defaults[role]}
                  onChange={(event) => setDefault(role, event.target.value)}
                >
                  <option value="">照上次選擇</option>
                  {modelOptions(role).map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            ))}
            <label>
              做法
              <select
                aria-label={`${name} 的預設做法`}
                value={defaults.mode}
                onChange={(event) => setDefault('mode', event.target.value)}
              >
                <option value="">照上次選擇</option>
                {DEFAULT_MODES.map((mode) => (
                  <option key={mode} value={mode}>
                    {MODE_LABELS[mode] ?? mode}
                  </option>
                ))}
              </select>
            </label>
            <label>
              權限
              <select
                aria-label={`${name} 的預設權限`}
                value={defaults.permissionMode}
                title={defaults.permissionMode ? PERMISSION_HINTS[defaults.permissionMode] : undefined}
                onChange={(event) => setDefault('permissionMode', event.target.value as PermissionMode | '')}
              >
                <option value="">照上次選擇</option>
                {PERMISSION_MODES.map((mode) => (
                  <option key={mode} value={mode} disabled={!permissionAllowed(mode, maxPermissionMode)}>
                    {PERMISSION_LABELS[mode]}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </fieldset>
        <label>
          專案指示
          <textarea
            name="instructions"
            aria-label={`${name} 的專案指示`}
            rows={5}
            maxLength={MAX_INSTRUCTIONS}
            spellCheck={false}
            value={instructions}
            onChange={(event) => {
              setSaved(false)
              setInstructions(event.target.value)
            }}
          />
        </label>
        <label>
          安裝指令
          <input
            name="installCommand"
            aria-label={`${name} 的安裝指令`}
            placeholder="依 lockfile 自動安裝"
            autoComplete="off"
            spellCheck={false}
            value={installCommand}
            onChange={(event) => {
              setSaved(false)
              setInstallCommand(event.target.value)
            }}
          />
        </label>
        {installShellCharacter ? (
          <p className="notice-line" role="status">
            偵測到 <code>{installShellCharacter}</code>：它會原封不動傳給程式，不會被 shell 解讀。
          </p>
        ) : null}
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
          不會經過 shell；要不要先問你，依任務的權限而定，沒同意就略過檢查。留空表示不檢查。
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
