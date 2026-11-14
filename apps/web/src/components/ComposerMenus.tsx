import type { ProviderKind } from '@joy/core'
import {
  applyPreset,
  comboSummary,
  followSettings,
  modeSummary,
  modelButtonText,
  normalizeModels,
  pickEffort,
  pickModel,
  planFirstDisabledReason,
  providerBlockedReason,
  resetEffort,
  resolveModels,
  sameRef,
} from '../composer-choice.js'
import type { ComposerChoice, RoleDefaults } from '../composer-choice.js'
import { effortLabel, supportedEfforts } from '../effort.js'
import { MODE_HINTS, modeLabel, repoName } from '../labels.js'
import { IMPLEMENTER_MODELS, MODEL_CATALOG, modelLabel, sameModelName } from '../models.js'
import { MODEL_PRESETS } from '../presets.js'
import { repoColor } from '../repo-colors.js'
import type { Repo } from '../types.js'
import { EffortPanel } from './EffortPanel.js'
import { Menu, MenuGroup, MenuItem, MenuSeparator, SubMenu } from './Menu.js'
import { Icon, ProjectDot } from './ui.js'

/** Updates the remembered choice from the previous one, so quick successive changes (a drag) never use stale state. */
type ChoiceUpdate = (change: (choice: ComposerChoice) => ComposerChoice) => void

const BUILT_IN_MODES = ['review_loop', 'single', 'compete'] as const

/** 專案 · 分支. */
export function ProjectMenu({
  repos,
  activeId,
  onSelect,
  onAddRepo,
}: {
  repos: Repo[]
  activeId: string
  onSelect: (id: string) => void
  onAddRepo: () => void
}) {
  const active = repos.find((repo) => repo.id === activeId)
  const text = active ? `${repoName(active.path)} · ${active.defaultBranch}` : '專案'
  return (
    <Menu
      label="專案"
      triggerLabel={`專案：${text}`}
      trigger={
        <>
          {active ? <ProjectDot color={repoColor(active.id, repos)} /> : <Icon name="folder" size={14} />}
          <span className="trigger-text">{text}</span>
          <Icon name="chevron-down" size={12} />
        </>
      }
    >
      <MenuGroup label="專案 · 分支">
        {repos.map((repo, index) => (
          <MenuItem
            key={repo.id}
            role="menuitemradio"
            checked={repo.id === activeId}
            shortcut={index < 9 ? String(index + 1) : undefined}
            description={repo.path}
            onSelect={() => onSelect(repo.id)}
          >
            <span className="menu-item-project">
              <ProjectDot color={repoColor(repo.id, repos)} />
              {repoName(repo.path)} · {repo.defaultBranch}
            </span>
          </MenuItem>
        ))}
      </MenuGroup>
      <MenuSeparator />
      <MenuItem icon="plus" onSelect={onAddRepo}>
        加入專案
      </MenuItem>
    </Menu>
  )
}

/** 做法: the mode and 先規劃 in one place. */
export function ApproachMenu({
  mode,
  planFirst,
  workflows,
  onMode,
  onPlanFirst,
  onAdvanced,
}: {
  mode: string
  planFirst: boolean
  workflows: Array<{ name: string; description?: string }>
  onMode: (mode: string) => void
  onPlanFirst: (on: boolean) => void
  /** Opens the advanced panel (title, per-role model fields); the last row of the menu. */
  onAdvanced: () => void
}) {
  const label = (value: string) =>
    value.startsWith('workflow:') ? value.slice('workflow:'.length) : modeLabel(value)
  const planReason = planFirstDisabledReason(mode)
  const planOn = planFirst && !planReason
  const text = modeSummary(mode, planOn, label)
  const modes = [
    ...BUILT_IN_MODES.map((value) => ({ value: value as string, description: MODE_HINTS[value] })),
    ...workflows.map((workflow) => ({
      value: `workflow:${workflow.name}`,
      description: workflow.description ?? '自訂流程',
    })),
  ]
  return (
    <Menu
      label="做法"
      triggerLabel={`做法：${text}`}
      trigger={
        <>
          <Icon name="bolt" size={14} />
          <span className="trigger-text hide-narrow">{text}</span>
          <span className="hide-narrow">
            <Icon name="chevron-down" size={12} />
          </span>
        </>
      }
    >
      <MenuGroup label="做法">
        {modes.map((item, index) => (
          <MenuItem
            key={item.value}
            role="menuitemradio"
            checked={item.value === mode}
            shortcut={index < 9 ? String(index + 1) : undefined}
            description={item.description}
            onSelect={() => onMode(item.value)}
          >
            {label(item.value)}
          </MenuItem>
        ))}
      </MenuGroup>
      <MenuSeparator />
      <MenuItem
        role="menuitemcheckbox"
        checked={planOn}
        disabled={planReason !== undefined}
        disabledReason={planReason}
        description="先寫計畫，等你核准才開始改程式"
        onSelect={() => onPlanFirst(!planFirst)}
      >
        先規劃
      </MenuItem>
      <MenuSeparator />
      <MenuItem icon="settings" onSelect={onAdvanced}>
        進階
      </MenuItem>
    </Menu>
  )
}

/** The model entry next to the send button: implementer model and effort, 審查模型, and 快速套用. */
export function ModelMenu({
  choice,
  defaults,
  allowed,
  mode,
  onChange,
}: {
  choice: ComposerChoice
  defaults: RoleDefaults
  allowed: readonly ProviderKind[] | undefined
  mode: string
  onChange: ChoiceUpdate
}) {
  const isWorkflow = mode.startsWith('workflow:')
  const resolved = resolveModels(choice.models, defaults)
  const implementer = resolved.implementer.ref
  const reviewer = resolved.reviewer.ref
  const followingSettings = Object.keys(normalizeModels(choice.models, defaults)).length === 0
  const efforts = supportedEfforts(implementer.provider, implementer.model)
  const listed = IMPLEMENTER_MODELS.some((entry) => sameModelName(entry, implementer))
  const trigger = modelButtonText(implementer)
  const singleMode = mode === 'single'

  const blockedFor = (
    roles: Array<'implementer' | 'reviewer'>,
    combo: { implementer: ProviderKind; reviewer: ProviderKind },
  ) => roles.map((role) => providerBlockedReason(combo[role], allowed)).find((reason) => reason !== undefined)

  return (
    <Menu
      label="模型"
      triggerLabel={isWorkflow ? '模型：自訂流程' : `模型：${trigger}`}
      triggerTitle={isWorkflow ? '自訂流程使用自己設定的模型' : undefined}
      triggerClassName="btn btn-ghost composer-trigger composer-model"
      disabled={isWorkflow}
      side="top"
      align="end"
      trigger={
        isWorkflow ? (
          <span className="trigger-text">自訂流程</span>
        ) : (
          <>
            <span className="trigger-text">{trigger}</span>
            <Icon name="chevron-down" size={12} />
          </>
        )
      }
    >
      <MenuGroup label="實作模型" hideLabel>
        {listed ? null : (
          <MenuItem role="menuitemradio" checked description="來自設定檔">
            {modelLabel(implementer)}
          </MenuItem>
        )}
        {IMPLEMENTER_MODELS.map((entry, index) => {
          const blocked = providerBlockedReason(entry.provider, allowed)
          return (
            <MenuItem
              key={`${entry.provider}:${entry.model}`}
              role="menuitemradio"
              checked={sameModelName(entry, implementer)}
              shortcut={String(index + 1)}
              hint={blocked ? undefined : entry.blurb}
              description={blocked}
              disabled={blocked !== undefined}
              disabledReason={blocked}
              onSelect={() => onChange((current) => pickModel(current, 'implementer', entry, defaults))}
            >
              {entry.label}
              {sameModelName(entry, defaults.implementer) ? <span className="menu-tag">預設</span> : null}
            </MenuItem>
          )
        })}
      </MenuGroup>
      <MenuSeparator />
      <SubMenu
        label="投入程度"
        value={implementer.effort ? effortLabel(implementer.effort) : '預設'}
        kind="dialog"
      >
        {(api) => (
          <EffortPanel
            effort={implementer.effort}
            supported={efforts}
            modelName={modelLabel(implementer)}
            onChange={(effort) => onChange((current) => pickEffort(current, 'implementer', effort, defaults))}
            onReset={() => onChange((current) => resetEffort(current, 'implementer', defaults))}
            onPickModel={api.backToList}
          />
        )}
      </SubMenu>
      <SubMenu
        label="審查模型"
        value={modelLabel(reviewer)}
        description={singleMode ? undefined : providerBlockedReason(reviewer.provider, allowed)}
        disabled={singleMode}
        disabledReason="單人模式沒有審查者"
      >
        <MenuGroup label="審查模型">
          {MODEL_CATALOG.map((entry, index) => {
            const blocked = providerBlockedReason(entry.provider, allowed)
            const same = sameModelName(entry, implementer)
            return (
              <MenuItem
                key={`${entry.provider}:${entry.model}`}
                role="menuitemradio"
                checked={sameModelName(entry, reviewer)}
                shortcut={index < 9 ? String(index + 1) : undefined}
                description={
                  same ? `${entry.description}（與實作模型相同，審查較不獨立）` : entry.description
                }
                disabled={blocked !== undefined}
                disabledReason={blocked}
                onSelect={() => onChange((current) => pickModel(current, 'reviewer', entry, defaults))}
              >
                {entry.label}
                {sameModelName(entry, defaults.reviewer) ? <span className="menu-tag">預設</span> : null}
              </MenuItem>
            )
          })}
        </MenuGroup>
      </SubMenu>
      <MenuSeparator />
      <MenuGroup label="快速套用">
        <MenuItem
          role="menuitemradio"
          checked={followingSettings}
          description={comboSummary(defaults.implementer, defaults.reviewer)}
          onSelect={() => onChange(followSettings)}
        >
          照設定
        </MenuItem>
        {MODEL_PRESETS.map((preset) => {
          const blocked = blockedFor(singleMode ? ['implementer'] : ['implementer', 'reviewer'], {
            implementer: preset.roles.implementer.provider,
            reviewer: preset.roles.reviewer.provider,
          })
          return (
            <MenuItem
              key={preset.id}
              role="menuitemradio"
              checked={
                !followingSettings &&
                sameRef(implementer, preset.roles.implementer) &&
                (singleMode || sameRef(reviewer, preset.roles.reviewer))
              }
              description={comboSummary(preset.roles.implementer, preset.roles.reviewer)}
              disabled={blocked !== undefined}
              disabledReason={blocked}
              onSelect={() => onChange((current) => applyPreset(current, preset, defaults))}
            >
              {preset.label}
            </MenuItem>
          )
        })}
      </MenuGroup>
    </Menu>
  )
}
