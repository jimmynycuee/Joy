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
import {
  EFFORT_LABELS,
  MODEL_SUGGESTIONS,
  PROVIDER_LABELS,
  ROLE_LABELS,
  providersForRole,
  roleModel,
  taskTitle,
} from '../labels.js'
import { readStorage, useDraft, writeStorage } from '../storage.js'
import { visibleStarters } from '../starters.js'
import type { Repo } from '../types.js'

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

const ROLE_KEYS: Array<Extract<Role, 'implementer' | 'reviewer'>> = ['implementer', 'reviewer']

/** The home page: Joy and one big message box (and a few ways to start before the first task). */
export function NewTaskPage({
  repos,
  hasAnyTask,
  config,
  customWorkflows,
  setupProblems,
  onOpenSetup,
  onAddRepo,
  onCreate,
}: {
  repos: Repo[]
  /** Any task at all, archived ones too: the quick-start chips are for a brand-new Joy only. */
  hasAnyTask: boolean
  config: JoyConfig | null
  customWorkflows: Array<{ name: string; description?: string }>
  setupProblems: number
  onOpenSetup: () => void
  onAddRepo: () => void
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
  const planFirstOn = choice.planFirst && !planFirstDisabledReason(mode)
  const starters = visibleStarters(hasAnyTask, activeRepo?.githubRemote)

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
            <Icon name="alert" size={14} />有 {setupProblems} 項環境設定需要處理
          </button>
        ) : null}

        {repos.length === 0 ? (
          <div className="home-empty">
            <Mascot mood="normal" size={96} decorative />
            <h1>先加入一個專案</h1>
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
                    onAdvanced={() => setShowAdvanced((open) => !open)}
                  />
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
                      標題（選填）
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
            {starters.length > 0 ? (
              <div className="starter-row" role="group" aria-label="快速開始">
                {starters.map((starter) => (
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
            ) : null}
          </>
        )}
      </div>
    </main>
  )
}
