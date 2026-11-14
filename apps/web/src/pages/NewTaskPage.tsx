import { useEffect, useMemo, useRef, useState } from 'react'
import { EFFORTS } from '@joy/core'
import type { ModelRef, ProviderKind, Role } from '@joy/core'
import type { JoyConfig } from '@joy/config'
import { ApproachMenu, ModelMenu, ProjectMenu } from '../components/ComposerMenus.js'
import { Composer } from '../components/Composer.js'
import { Mascot } from '../components/Mascot.js'
import { Button, Icon } from '../components/ui.js'
import {
  COMPOSER_STORAGE_KEY,
  applyAllowlist,
  buildRoleOverrides,
  parseStoredChoice,
  planFirstDisabledReason,
  resolveModels,
  serializeChoice,
  setRoleModel,
  validMode,
} from '../composer-choice.js'
import type { ComposerChoice, RoleDefaults, TaskModels } from '../composer-choice.js'
import { relativeTime } from '../dates.js'
import {
  EFFORT_LABELS,
  MODEL_SUGGESTIONS,
  MODE_HINTS,
  PROVIDER_LABELS,
  ROLE_LABELS,
  providersForRole,
  roleModel,
  statusLabel,
  taskTitle,
} from '../labels.js'
import { readStorage, useDraft, writeStorage } from '../storage.js'
import { tasksNeedingAttention } from '../task-info.js'
import type { Repo, Task } from '../types.js'

export interface NewTaskInput {
  repoId: string
  title: string
  prompt: string
  /** `workflow:<name>` for a custom workflow, else a built-in mode. */
  mode: string
  /** Only the roles the owner picked for this task; undefined means every role follows Settings. */
  roleOverrides?: TaskModels
  /** The agent writes a plan first and waits for the owner's approval before changing code. */
  planFirst: boolean
}

const STARTERS = [
  { label: '修一個 bug', prompt: '修一個 bug：' },
  { label: '補測試', prompt: '幫這段程式補上測試：' },
  { label: '解釋這段程式', prompt: '請解釋這段程式在做什麼：' },
  { label: '從 GitHub issue 開始', prompt: '處理 GitHub issue #' },
] as const

const ROLE_KEYS: Array<Extract<Role, 'implementer' | 'reviewer'>> = ['implementer', 'reviewer']

function TaskLine({ task, onOpen }: { task: Task; onOpen: (id: string) => void }) {
  return (
    <button type="button" className="line-row" onClick={() => onOpen(task.id)}>
      <span className={`task-dot status-${task.status}`} aria-hidden="true" />
      <span className="line-title">{task.title}</span>
      <span className={`line-meta status-text-${task.status}`}>{statusLabel(task.status, task.mode)}</span>
      <span className="line-meta">{relativeTime(task.createdAt)}</span>
    </button>
  )
}

/** The home page: one big message box, a few ways to start, and what needs you. */
export function NewTaskPage({
  repos,
  tasks,
  config,
  customWorkflows,
  setupProblems,
  onOpenSetup,
  onAddRepo,
  onOpenTask,
  onCreate,
}: {
  repos: Repo[]
  tasks: Task[]
  config: JoyConfig | null
  customWorkflows: Array<{ name: string; description?: string }>
  setupProblems: number
  onOpenSetup: () => void
  onAddRepo: () => void
  onOpenTask: (id: string) => void
  onCreate: (input: NewTaskInput) => Promise<boolean>
}) {
  const [prompt, setPrompt, clearPrompt] = useDraft('new-task')
  const [repoId, setRepoId] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [busy, setBusy] = useState(false)
  // What the owner picked last time (models, mode, 先規劃) is the starting point; roles without a pick follow Settings.
  const [choice, setChoice] = useState<ComposerChoice>(() =>
    parseStoredChoice(readStorage(COMPOSER_STORAGE_KEY)),
  )
  useEffect(() => {
    writeStorage(COMPOSER_STORAGE_KEY, serializeChoice(choice))
  }, [choice])
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  const activeRepoId = repos.some((repo) => repo.id === repoId) ? repoId : (repos[0]?.id ?? '')
  const activeRepo = repos.find((repo) => repo.id === activeRepoId)
  const allowedProviders = activeRepo?.allowedProviders
  const defaults: RoleDefaults = useMemo(
    () => ({ implementer: roleModel(config, 'implementer'), reviewer: roleModel(config, 'reviewer') }),
    [config],
  )
  const mode = validMode(
    choice.mode,
    customWorkflows.map((workflow) => workflow.name),
  )
  // Picks the repository does not allow are left out, so they fall back to Settings instead of failing the task.
  const effective = useMemo(() => applyAllowlist(choice, allowedProviders), [choice, allowedProviders])
  const models = useMemo(() => {
    const resolved = resolveModels(effective.models, defaults)
    return { implementer: resolved.implementer.ref, reviewer: resolved.reviewer.ref }
  }, [effective, defaults])
  const planFirstDisabledText = planFirstDisabledReason(mode)
  const planFirstOn = choice.planFirst && !planFirstDisabledText

  const attention = useMemo(() => tasksNeedingAttention(tasks), [tasks])
  const recent = useMemo(
    () =>
      [...tasks]
        .filter((task) => !attention.some((item) => item.id === task.id))
        .sort((a, b) => Date.parse(b.createdAt || '') - Date.parse(a.createdAt || '') || 0)
        .slice(0, 3),
    [tasks, attention],
  )

  function setModel(role: 'implementer' | 'reviewer', next: ModelRef) {
    setChoice((current) => setRoleModel(current, role, next, defaults))
  }

  async function submit(form: FormData): Promise<void> {
    const roleOverrides = buildRoleOverrides(effective, mode)
    setBusy(true)
    try {
      const ok = await onCreate({
        repoId: activeRepoId,
        title: taskTitle(String(form.get('title') ?? ''), prompt),
        prompt: prompt.trim(),
        mode,
        ...(roleOverrides ? { roleOverrides } : {}),
        planFirst: planFirstOn,
      })
      if (ok) clearPrompt()
    } finally {
      setBusy(false)
    }
  }

  function startWith(text: string) {
    setPrompt(text)
    window.setTimeout(() => {
      const element = textareaRef.current
      if (!element) return
      element.focus()
      element.setSelectionRange(text.length, text.length)
    }, 0)
  }

  return (
    <main className="home-page">
      <div className="home-column">
        {setupProblems > 0 ? (
          <button type="button" className="setup-banner" onClick={onOpenSetup}>
            <Icon name="alert" size={14} />有 {setupProblems} 項環境設定需要處理，點這裡查看
          </button>
        ) : null}

        {attention.length > 0 ? (
          <section className="card attention-card" aria-label="需要你處理">
            <h2>需要你處理</h2>
            {attention.map((task) => (
              <TaskLine key={task.id} task={task} onOpen={onOpenTask} />
            ))}
          </section>
        ) : null}

        {repos.length === 0 ? (
          <div className="home-empty">
            <Mascot mood="normal" size={96} decorative />
            <h1>先加入一個專案</h1>
            <p>選一個電腦裡的 Git 專案資料夾，Joy 會在獨立的工作副本裡幫你改程式。</p>
            <Button variant="primary" large onClick={onAddRepo}>
              加入專案
            </Button>
          </div>
        ) : (
          <>
            <Mascot mood="normal" size={96} decorative className="home-mascot" />
            <h1 className="home-title">要讓 Joy 做什麼？</h1>
            <Composer
              className="composer-home"
              value={prompt}
              onChange={setPrompt}
              onSubmit={submit}
              textareaRef={textareaRef}
              placeholder="例如：登入頁按 Enter 不會送出，幫我修好"
              textareaLabel="任務內容"
              sendLabel="開始任務"
              busy={busy}
              autoFocus
              rows={3}
              bar={
                <>
                  <ProjectMenu
                    repos={repos}
                    activeId={activeRepoId}
                    onSelect={setRepoId}
                    onAddRepo={onAddRepo}
                  />
                  <ApproachMenu
                    mode={mode}
                    planFirst={choice.planFirst}
                    workflows={customWorkflows}
                    onMode={(value) => setChoice((current) => ({ ...current, mode: value }))}
                    onPlanFirst={(on) => setChoice((current) => ({ ...current, planFirst: on }))}
                  />
                  <button
                    type="button"
                    className="btn btn-ghost composer-trigger"
                    aria-label="進階"
                    aria-expanded={showAdvanced}
                    onClick={() => setShowAdvanced((open) => !open)}
                  >
                    <Icon name="settings" size={14} />
                    <span className="trigger-text hide-narrow">進階</span>
                  </button>
                </>
              }
              trailing={
                <ModelMenu
                  choice={effective}
                  defaults={defaults}
                  allowed={allowedProviders}
                  mode={mode}
                  onChange={setChoice}
                />
              }
              advanced={
                <div className="composer-advanced" hidden={!showAdvanced}>
                  <div className="field-stack">
                    <label>
                      標題（選填，預設用任務內容的第一行）
                      <input name="title" aria-label="任務標題" maxLength={500} />
                    </label>
                    <div className="role-grid">
                      {ROLE_KEYS.map((role) => {
                        const model = models[role]
                        return (
                          <fieldset className="role-card" key={role}>
                            <legend>{ROLE_LABELS[role]}</legend>
                            <label>
                              服務
                              <select
                                aria-label={`${ROLE_LABELS[role]}的服務`}
                                value={model.provider}
                                onChange={(event) => {
                                  const provider = event.target.value as ProviderKind
                                  setModel(role, {
                                    ...model,
                                    provider,
                                    model: MODEL_SUGGESTIONS[provider][0] ?? model.model,
                                  })
                                }}
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
                                list={`task-${role}-models`}
                                value={model.model}
                                onChange={(event) => setModel(role, { ...model, model: event.target.value })}
                                required
                              />
                              <datalist id={`task-${role}-models`}>
                                {MODEL_SUGGESTIONS[model.provider].map((option) => (
                                  <option key={option} value={option} />
                                ))}
                              </datalist>
                            </label>
                            <label>
                              思考程度
                              <select
                                aria-label={`${ROLE_LABELS[role]}的思考程度`}
                                value={model.effort ?? 'medium'}
                                onChange={(event) =>
                                  setModel(role, {
                                    ...model,
                                    effort: event.target.value as NonNullable<ModelRef['effort']>,
                                  })
                                }
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
                      })}
                    </div>
                  </div>
                </div>
              }
            />
            <p className="composer-hint">
              {MODE_HINTS[mode] ?? '照這個自訂流程的設定執行。'}
              {planFirstOn ? ' 先規劃：agent 會先寫計畫，等你核准才開始改程式。' : ''}
            </p>

            <div className="starter-row" role="group" aria-label="快速開始">
              {STARTERS.map((starter) => (
                <button
                  key={starter.label}
                  type="button"
                  className="starter-chip"
                  onClick={() => startWith(starter.prompt)}
                >
                  {starter.label}
                </button>
              ))}
            </div>

            {recent.length > 0 ? (
              <section className="recent-section" aria-label="最近的任務">
                <h2>最近的任務</h2>
                {recent.map((task) => (
                  <TaskLine key={task.id} task={task} onOpen={onOpenTask} />
                ))}
              </section>
            ) : null}
          </>
        )}
      </div>
    </main>
  )
}
