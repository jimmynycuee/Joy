import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import type { ProviderKind } from '@joy/core'
import { request } from '../api.js'
import type { CompletionItem, JoyCommand, McpItem, SkillItem, Trigger } from '../completion.js'
import { applyCompletion, findTrigger, mentionItems, removeTrigger, slashItems } from '../completion.js'

/** Joy's own `/` commands, given once by the workspace. */
export const JoyCommandsContext = createContext<readonly JoyCommand[]>([])

/** Where the `/` and `@` menus look: the implementer's CLI, and the project or task whose files are listed. */
export interface ComposerCompletion {
  cli?: ProviderKind | undefined
  repoId?: string | undefined
  taskId?: string | undefined
}

const skillCache = new Map<string, Promise<SkillItem[]>>()
function loadSkills(repoId: string | undefined): Promise<SkillItem[]> {
  const key = repoId ?? ''
  let cached = skillCache.get(key)
  if (!cached) {
    cached = request<{ skills: SkillItem[] }>(
      `/api/skills${repoId ? `?repoId=${encodeURIComponent(repoId)}` : ''}`,
    )
      .then((body) => body.skills)
      .catch(() => [])
    skillCache.set(key, cached)
    // Skills change rarely; a fresh list after a minute is enough.
    setTimeout(() => skillCache.delete(key), 60_000)
  }
  return cached
}

/**
 * The `/` and `@` menus of a message box. `onKeyDown` must run first in the textarea's key handler: it returns true
 * when the menu used the key.
 */
export function useCompletion({
  value,
  onChange,
  textarea,
  completion,
}: {
  value: string
  onChange: (text: string) => void
  textarea: { current: HTMLTextAreaElement | null }
  completion: ComposerCompletion | undefined
}) {
  const commands = useContext(JoyCommandsContext)
  const [caret, setCaret] = useState<number | null>(null)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [active, setActive] = useState(0)
  const [skills, setSkills] = useState<SkillItem[]>([])
  const [servers, setServers] = useState<McpItem[]>([])
  const [files, setFiles] = useState<string[]>([])
  const pendingCaret = useRef<number | null>(null)

  const trigger: Trigger | undefined =
    completion && caret !== null ? findTrigger(value, Math.min(caret, value.length)) : undefined
  const triggerKey = trigger ? `${trigger.kind}${trigger.start}` : null
  const open = Boolean(trigger) && triggerKey !== dismissed
  // Esc closes the menu until that `/` or `@` is gone.
  useEffect(() => {
    if (!triggerKey) setDismissed(null)
  }, [triggerKey])
  const kind = open ? trigger?.kind : undefined
  const query = trigger?.query ?? ''

  useEffect(() => {
    if (kind === '/') void loadSkills(completion?.repoId).then(setSkills)
    if (kind === '@')
      void request<{ servers: McpItem[] }>('/api/mcp-servers')
        .then((body) => setServers(body.servers))
        .catch(() => setServers([]))
  }, [kind, completion?.repoId])

  const fileScope = completion?.taskId
    ? `taskId=${encodeURIComponent(completion.taskId)}`
    : completion?.repoId
      ? `repoId=${encodeURIComponent(completion.repoId)}`
      : ''
  useEffect(() => {
    if (kind !== '@' || !fileScope) {
      setFiles([])
      return
    }
    let stale = false
    const timer = setTimeout(() => {
      request<{ files: string[] }>(`/api/files?${fileScope}&q=${encodeURIComponent(query)}`)
        .then((body) => {
          if (!stale) setFiles(body.files)
        })
        .catch(() => {
          if (!stale) setFiles([])
        })
    }, 120)
    return () => {
      stale = true
      clearTimeout(timer)
    }
  }, [kind, query, fileScope])

  const items: CompletionItem[] = useMemo(() => {
    if (kind === '/') return slashItems(query, skills, commands, completion?.cli)
    if (kind === '@') return mentionItems(query, files, servers, completion?.repoId)
    return []
  }, [kind, query, skills, commands, completion?.cli, files, servers, completion?.repoId])
  const index = Math.min(active, Math.max(items.length - 1, 0))
  useEffect(() => setActive(0), [kind, query])

  // After a pick the caret goes right after the inserted text.
  useEffect(() => {
    const element = textarea.current
    if (pendingCaret.current === null || !element) return
    element.setSelectionRange(pendingCaret.current, pendingCaret.current)
    setCaret(pendingCaret.current)
    pendingCaret.current = null
  }, [value, textarea])

  function pick(item: CompletionItem | undefined) {
    if (!item || !trigger) return
    if (item.type === 'command') {
      onChange(removeTrigger(value, trigger))
      setDismissed(null)
      item.run()
      return
    }
    const next = applyCompletion(value, trigger, item.insert)
    pendingCaret.current = next.caret
    onChange(next.value)
  }

  const track = () => setCaret(textarea.current?.selectionStart ?? null)

  return {
    open: open && items.length > 0,
    items,
    active: index,
    track,
    blur: () => setCaret(null),
    choose: (item: CompletionItem) => pick(item),
    hover: (position: number) => setActive(position),
    onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
      if (!open || !items.length || event.nativeEvent.isComposing || event.keyCode === 229) return false
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const step = event.key === 'ArrowDown' ? 1 : -1
        setActive((index + step + items.length) % items.length)
        return true
      }
      if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
        event.preventDefault()
        pick(items[index])
        return true
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setDismissed(triggerKey)
        return true
      }
      return false
    },
  }
}

export function CompletionMenu({
  id,
  items,
  active,
  onChoose,
  onHover,
}: {
  id: string
  items: CompletionItem[]
  active: number
  onChoose: (item: CompletionItem) => void
  onHover: (index: number) => void
}) {
  const list = useRef<HTMLUListElement | null>(null)
  useEffect(() => {
    list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [active])
  return (
    <ul className="completion-menu" role="listbox" id={id} ref={list} data-testid="completion-menu">
      {items.map((item, index) => (
        <li
          key={item.key}
          id={`${id}-${index}`}
          role="option"
          aria-selected={index === active}
          className={`completion-item${index === active ? ' active' : ''}${item.type === 'file' ? ' completion-file' : ''}`}
          // Keep the focus in the text box.
          onMouseDown={(event) => {
            event.preventDefault()
            onChoose(item)
          }}
          onMouseEnter={() => onHover(index)}
        >
          <span className="completion-label">{item.label}</span>
          {'detail' in item && item.detail ? <span className="completion-detail">{item.detail}</span> : null}
          {item.type === 'skill' && item.tag ? <span className="completion-tag">{item.tag}</span> : null}
        </li>
      ))}
    </ul>
  )
}
