import { useMemo, useRef, useState } from 'react'
import { EFFORTS } from '@joy/core'
import type { ModelRef, ProviderKind, Role } from '@joy/core'
import type { JoyConfig } from '@joy/config'
import { Composer } from '../components/Composer.js'
import { Button, Icon } from '../components/ui.js'
import { relativeTime } from '../dates.js'
import {
  EFFORT_LABELS,
  MODEL_SUGGESTIONS,
  MODE_HINTS,
  PROVIDER_LABELS,
  ROLE_LABELS,
  providersForRole,
  repoName,
  roleModel,
  statusLabel,
  taskTitle,
} from '../labels.js'
import { MODEL_PRESETS, findPreset, matchingTaskPreset } from '../presets.js'
import { useDraft } from '../storage.js'
import { tasksNeedingAttention } from '../task-info.js'
import type { Repo, Task } from '../types.js'

export interface NewTaskInput {
  repoId: string
  title: string
  prompt: string
  /** `workflow:<name>` for a custom workflow, else a built-in mode. */
  mode: string
  implementer: ModelRef
  reviewer: ModelRef
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
  const [mode, setMode] = useState('review_loop')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [planFirst, setPlanFirst] = useState(false)
  const [busy, setBusy] = useState(false)
  // null = use the models from Settings; otherwise this task's own implementer and reviewer.
  const [overrides, setOverrides] = useState<Record<'implementer' | 'reviewer', ModelRef> | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  const models = {
    implementer: overrides?.implementer ?? roleModel(config, 'implementer'),
    reviewer: overrides?.reviewer ?? roleModel(config, 'reviewer'),
  }
  const presetValue = overrides
    ? (matchingTaskPreset(models.implementer, models.reviewer)?.id ?? 'custom')
    : 'default'
  const isWorkflow = mode.startsWith('workflow:')
  // Plan-first works for the two built-in single-agent modes; compete tasks and custom workflows do not take it.
  const planFirstDisabledReason =
    mode === 'compete'
      ? '兩家比賽不支援先規劃'
      : isWorkflow
        ? '自訂流程請在設定檔裡設定 plan_first'
        : undefined
  const planFirstOn = planFirst && !planFirstDisabledReason
  const activeRepoId = repos.some((repo) => repo.id === repoId) ? repoId : (repos[0]?.id ?? '')

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
    setOverrides({ ...models, [role]: next })
  }

  function choosePreset(value: string) {
    const preset = findPreset(value)
    if (!preset) {
      setOverrides(null)
      return
    }
    setOverrides({ implementer: preset.roles.implementer, reviewer: preset.roles.reviewer })
  }

  async function submit(form: FormData): Promise<void> {
    setBusy(true)
    try {
      const ok = await onCreate({
        repoId: activeRepoId,
        title: taskTitle(String(form.get('title') ?? ''), prompt),
        prompt: prompt.trim(),
        mode,
        implementer: models.implementer,
        reviewer: models.reviewer,
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
            <h1>先加入一個專案</h1>
            <p>選一個電腦裡的 Git 專案資料夾，Joy 會在獨立的工作副本裡幫你改程式。</p>
            <Button variant="primary" large onClick={onAddRepo}>
              加入專案
            </Button>
          </div>
        ) : (
          <>
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
                  <select
                    aria-label="專案"
                    className="select"
                    value={activeRepoId}
                    onChange={(event) => setRepoId(event.target.value)}
                  >
                    {repos.map((repo) => (
                      <option key={repo.id} value={repo.id}>
                        {repoName(repo.path)} · {repo.defaultBranch}
                      </option>
                    ))}
                  </select>
                  <select
                    aria-label="模式"
                    className="select"
                    value={mode}
                    onChange={(event) => setMode(event.target.value)}
                  >
                    <option value="review_loop">實作＋審查</option>
                    <option value="single">單人</option>
                    <option value="compete">兩家比賽</option>
                    {customWorkflows.map((workflow) => (
                      <option key={workflow.name} value={`workflow:${workflow.name}`}>
                        {workflow.name}
                        {workflow.description ? ` — ${workflow.description}` : ''}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className={`chip-toggle${planFirstOn ? ' on' : ''}`}
                    aria-pressed={planFirstOn}
                    disabled={planFirstDisabledReason !== undefined}
                    title={planFirstDisabledReason ?? '先寫計畫，等你核准才開始改程式'}
                    onClick={() => setPlanFirst((on) => !on)}
                  >
                    <Icon name="book" size={14} />
                    先規劃
                  </button>
                  <select
                    aria-label="模型組合"
                    className="select"
                    value={presetValue}
                    disabled={isWorkflow}
                    onChange={(event) => choosePreset(event.target.value)}
                  >
                    <option value="default">模型：照設定</option>
                    {MODEL_PRESETS.map((preset) => (
                      <option key={preset.id} value={preset.id}>
                        模型：{preset.label}
                      </option>
                    ))}
                    {presetValue === 'custom' ? <option value="custom">模型：自訂</option> : null}
                  </select>
                  <Button
                    variant="ghost"
                    aria-expanded={showAdvanced}
                    onClick={() => setShowAdvanced((open) => !open)}
                  >
                    進階
                  </Button>
                </>
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
