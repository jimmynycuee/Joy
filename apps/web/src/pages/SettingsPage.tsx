import { useState } from 'react'
import type { Dispatch, FormEvent, SetStateAction } from 'react'
import { EFFORTS, ROLES } from '@joy/core'
import type { ModelRef, ProviderKind, Role } from '@joy/core'
import type { JoyConfig } from '@joy/config'
import { ArchivedPanel } from '../components/ArchivedPanel.js'
import { RepoSettingsCard } from '../components/RepoSettings.js'
import {
  AccessTokenPanel,
  BackupsPanel,
  DoctorChecks,
  LogsPanel,
  NotificationsPanel,
  TelegramSettings,
  WorktreesPanel,
} from '../components/settings-panels.js'
import { Button, Disclosure, Icon } from '../components/ui.js'
import type { IconName } from '../components/ui.js'
import {
  EFFORT_LABELS,
  MODEL_SUGGESTIONS,
  PROVIDER_LABELS,
  ROLE_LABELS,
  providersForRole,
  roleModel,
} from '../labels.js'
import { MODEL_PRESETS, matchingPreset } from '../presets.js'
import { SHORTCUTS, modLabel } from '../shortcuts.js'
import { THEME_LABELS } from '../theme.js'
import type { ThemePreference } from '../theme.js'
import type { DoctorReport, Repo, SecretStatus, Task } from '../types.js'
import { StatsPanel } from './StatsPage.js'

export type SettingsSection =
  | 'general'
  | 'models'
  | 'permissions'
  | 'notifications'
  | 'projects'
  | 'data'
  | 'stats'
  | 'archived'
  | 'advanced'

const SECTIONS: Array<{ id: SettingsSection; label: string }> = [
  { id: 'general', label: '一般' },
  { id: 'models', label: '模型' },
  { id: 'permissions', label: '權限與自主' },
  { id: 'notifications', label: '通知' },
  { id: 'projects', label: '專案' },
  { id: 'data', label: '資料與備份' },
  { id: 'stats', label: '統計' },
  { id: 'archived', label: '已封存' },
  { id: 'advanced', label: '進階' },
]

const THEME_ICONS: Record<ThemePreference, IconName> = { system: 'monitor', light: 'sun', dark: 'moon' }

export interface SettingsPageProps {
  section: SettingsSection
  onSection: (section: SettingsSection) => void
  config: JoyConfig | null
  setConfig: Dispatch<SetStateAction<JoyConfig | null>>
  onSaveConfig: () => Promise<void>
  secretStatus: SecretStatus | null
  secretStatusLoading: boolean
  onRetrySecret: () => void
  onSaveOpenAiKey: (event: FormEvent<HTMLFormElement>) => Promise<void>
  onRemoveOpenAiKey: () => Promise<void>
  doctorReport: DoctorReport | null
  doctorLoading: boolean
  onRetryDoctor: () => void
  repos: Repo[]
  onAddRepo: () => void
  onRepoSaved: (repo: Repo) => void
  theme: ThemePreference
  onTheme: (theme: ThemePreference) => void
  /** Every task, archived ones included (the 已封存 section lists those). */
  tasks: Task[]
  onOpenTask: (id: string) => void
  onRestoreTask: (id: string) => void
  /** Back to the page that was open before 設定. */
  onBack: () => void
}

function RoleFields({
  role,
  config,
  onChange,
}: {
  role: Role
  config: JoyConfig
  onChange: <K extends keyof ModelRef>(role: Role, field: K, value: ModelRef[K]) => void
}) {
  const model = roleModel(config, role)
  return (
    <fieldset className="role-card">
      <legend>{ROLE_LABELS[role]}</legend>
      <label>
        服務
        <select
          aria-label={`${ROLE_LABELS[role]}的服務`}
          name={`${role}-provider`}
          value={model.provider}
          onChange={(event) => onChange(role, 'provider', event.target.value as ProviderKind)}
        >
          {providersForRole(role).map((provider) => (
            <option key={provider} value={provider}>
              {PROVIDER_LABELS[provider]}
            </option>
          ))}
        </select>
      </label>
      <label>
        模型
        <input
          aria-label={`${ROLE_LABELS[role]}的模型`}
          name={`${role}-model`}
          list={`${role}-model-options`}
          value={model.model}
          onChange={(event) => onChange(role, 'model', event.target.value)}
          required
        />
        <datalist id={`${role}-model-options`}>
          {MODEL_SUGGESTIONS[model.provider].map((suggestion) => (
            <option key={suggestion} value={suggestion} />
          ))}
        </datalist>
      </label>
      <label>
        思考程度
        <select
          aria-label={`${ROLE_LABELS[role]}的思考程度`}
          name={`${role}-effort`}
          value={model.effort ?? 'medium'}
          onChange={(event) => onChange(role, 'effort', event.target.value as ModelRef['effort'])}
        >
          {EFFORTS.map((effort) => (
            <option key={effort} value={effort}>
              {EFFORT_LABELS[effort] ?? effort}
            </option>
          ))}
        </select>
      </label>
    </fieldset>
  )
}

/** Settings, split into sections on the left like the desktop apps. */
export function SettingsPage(props: SettingsPageProps) {
  const { config, setConfig, section } = props
  const [rolesOpen, setRolesOpen] = useState(false)

  function updateRole<K extends keyof ModelRef>(role: Role, field: K, value: ModelRef[K]) {
    setConfig((current) =>
      current
        ? {
            ...current,
            roles: { ...current.roles, [role]: { ...roleModel(current, role), [field]: value } },
          }
        : current,
    )
  }

  const activePreset = config ? matchingPreset(config.roles) : undefined
  const saveBar = (
    <div className="save-bar">
      <Button variant="primary" type="submit" title="只套用到之後的新任務">
        儲存設定
      </Button>
    </div>
  )

  function body() {
    if (section === 'general') {
      return (
        <>
          <section className="card settings-card">
            <h2>外觀</h2>
            <div className="segmented" role="group" aria-label="主題">
              {(Object.keys(THEME_LABELS) as ThemePreference[]).map((value) => (
                <button
                  key={value}
                  type="button"
                  className="segment"
                  aria-pressed={props.theme === value}
                  onClick={() => props.onTheme(value)}
                >
                  <Icon name={THEME_ICONS[value]} />
                  {THEME_LABELS[value]}
                </button>
              ))}
            </div>
          </section>
          <section className="card settings-card">
            <h2>鍵盤快速鍵</h2>
            <ul className="shortcut-list">
              {SHORTCUTS.map((shortcut) => (
                <li key={shortcut.keys}>
                  <span>{shortcut.label}</span>
                  <span className="keys">
                    <kbd>{modLabel()}</kbd>
                    <kbd>{shortcut.keys}</kbd>
                  </span>
                </li>
              ))}
              <li>
                <span>送出訊息（Shift+Enter 換行）</span>
                <span className="keys">
                  <kbd>Enter</kbd>
                </span>
              </li>
            </ul>
          </section>
        </>
      )
    }
    if (section === 'projects') {
      return (
        <section className="card settings-card">
          <div className="section-heading">
            <h2>專案</h2>
            <Button variant="primary" icon="plus" onClick={props.onAddRepo}>
              加入專案
            </Button>
          </div>
          {props.repos.length === 0 ? (
            <p className="muted">還沒有專案</p>
          ) : (
            <div className="repo-list">
              {props.repos.map((repo) => (
                <RepoSettingsCard key={repo.id} repo={repo} repos={props.repos} onSaved={props.onRepoSaved} />
              ))}
            </div>
          )}
        </section>
      )
    }
    if (section === 'data') {
      return (
        <>
          <BackupsPanel />
          <WorktreesPanel />
        </>
      )
    }
    if (section === 'stats') return <StatsPanel repos={props.repos} />
    if (section === 'archived') {
      return (
        <ArchivedPanel
          tasks={props.tasks}
          repos={props.repos}
          onOpen={props.onOpenTask}
          onRestore={props.onRestoreTask}
        />
      )
    }
    if (section === 'advanced') {
      return (
        <>
          <DoctorChecks
            report={props.doctorReport}
            loading={props.doctorLoading}
            onRetry={props.onRetryDoctor}
          />
          <AccessTokenPanel />
          <LogsPanel />
        </>
      )
    }
    if (section === 'notifications') {
      return (
        <>
          <NotificationsPanel />
          {config ? <TelegramSettings config={config} onConfig={(next) => setConfig(next)} /> : null}
        </>
      )
    }
    if (!config) return <div className="card loading-card">正在載入設定…</div>
    if (section === 'permissions') {
      return (
        <form
          className="card settings-card"
          onSubmit={(event) => {
            event.preventDefault()
            void props.onSaveConfig()
          }}
        >
          <h2>權限與自主</h2>
          <div className="field-stack">
            <label htmlFor="autonomy-mode">自主程度</label>
            <select
              id="autonomy-mode"
              aria-label="自主程度"
              value={config.autonomy_mode}
              onChange={(event) =>
                setConfig({ ...config, autonomy_mode: event.target.value as JoyConfig['autonomy_mode'] })
              }
            >
              <option value="careful">謹慎：每個動作都提高一級</option>
              <option value="normal">一般：照每個動作的預設等級</option>
              <option value="hands-off">放手：少通知，但高風險動作仍要你同意</option>
            </select>
            <p className="muted">高風險動作（推送、刪除等）一定要你同意。</p>
          </div>
          {saveBar}
        </form>
      )
    }
    // models
    return (
      <>
        {config.roles.implementer.provider === 'openai-api' ? (
          <p className="notice-line" role="status">
            OpenAI API 不能改程式碼，所以實作者改用 Claude Code。按儲存後生效。
          </p>
        ) : null}
        <form
          className="card settings-card"
          onSubmit={(event) => {
            event.preventDefault()
            void props.onSaveConfig()
          }}
        >
          <h2>模型組合</h2>
          <div className="preset-grid" role="group" aria-label="模型組合">
            {MODEL_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                className="preset-card"
                aria-pressed={activePreset?.id === preset.id}
                onClick={() => setConfig({ ...config, roles: preset.roles })}
              >
                <strong>{preset.label}</strong>
                <span>{preset.description}</span>
              </button>
            ))}
          </div>
          <Disclosure
            label="各角色的詳細設定"
            open={rolesOpen}
            onToggle={() => setRolesOpen((open) => !open)}
          >
            <div className="role-grid">
              {ROLES.map((role) => (
                <RoleFields key={role} role={role} config={config} onChange={updateRole} />
              ))}
            </div>
          </Disclosure>
          {saveBar}
        </form>

        <section className="card settings-card">
          <div className="section-heading">
            <h2>OpenAI API 金鑰</h2>
            <span
              className={props.secretStatus?.set ? 'status-pill configured' : 'status-pill'}
              role="status"
            >
              {props.secretStatusLoading
                ? '檢查中…'
                : props.secretStatus === null
                  ? '無法取得'
                  : props.secretStatus.set
                    ? '已設定'
                    : '未設定'}
            </span>
          </div>
          {props.secretStatusLoading ? (
            <p className="muted">正在檢查金鑰狀態…</p>
          ) : props.secretStatus === null ? (
            <p className="muted">目前無法取得金鑰狀態，暫時不能管理金鑰。</p>
          ) : null}
          {props.secretStatusLoading ? null : props.secretStatus === null ? (
            <div className="button-row">
              <Button onClick={props.onRetrySecret}>重新檢查金鑰</Button>
            </div>
          ) : props.secretStatus.source === 'env' ? (
            <div className="env-managed" role="status">
              由環境變數 OPENAI_API_KEY 管理。
            </div>
          ) : (
            <form className="field-stack" onSubmit={(event) => void props.onSaveOpenAiKey(event)}>
              <label htmlFor="openai-key">{props.secretStatus.set ? '換一把金鑰' : '輸入金鑰'}</label>
              <div className="input-row">
                <input
                  id="openai-key"
                  name="openai-key"
                  type="password"
                  autoComplete="new-password"
                  minLength={1}
                  required
                />
                <Button variant="secondary" type="submit">
                  儲存金鑰
                </Button>
              </div>
              <div className="row-between">
                <span className="muted">{props.secretStatus.set ? '存在作業系統鑰匙圈' : ''}</span>
                {props.secretStatus.source === 'keychain' && (
                  <Button variant="danger" onClick={() => void props.onRemoveOpenAiKey()}>
                    移除金鑰
                  </Button>
                )}
              </div>
            </form>
          )}
        </section>
      </>
    )
  }

  return (
    <main className="settings-page">
      <nav className="settings-nav" aria-label="設定分類">
        <button type="button" className="settings-back" onClick={props.onBack}>
          <Icon name="arrow-left" />
          返回
        </button>
        <h1>設定</h1>
        {SECTIONS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`nav-item${section === item.id ? ' active' : ''}`}
            aria-current={section === item.id ? 'page' : undefined}
            onClick={() => props.onSection(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>
      <div className="settings-content">{body()}</div>
    </main>
  )
}
