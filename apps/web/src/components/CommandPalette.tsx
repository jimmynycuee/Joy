import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { Icon } from './ui.js'
import type { IconName } from './ui.js'

export interface PaletteItem {
  id: string
  label: string
  /** Small grey text on the right: the kind of thing this is. */
  hint: string
  icon: IconName
  run: () => void
}

/** ⌘/Ctrl+K: jump to a task or conversation, or run a command. */
export function CommandPalette({ items, onClose }: { items: PaletteItem[]; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return (needle ? items.filter((item) => item.label.toLowerCase().includes(needle)) : items).slice(0, 40)
  }, [items, query])
  const active = Math.min(index, Math.max(results.length - 1, 0))

  function choose(item: PaletteItem | undefined) {
    if (!item) return
    onClose()
    item.run()
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setIndex(Math.min(active + 1, results.length - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setIndex(Math.max(active - 1, 0))
    } else if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault()
      choose(results[active])
    } else if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
    }
  }

  return (
    <div
      className="modal-backdrop palette-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="palette" role="dialog" aria-modal="true" aria-label="命令面板">
        <div className="search-field palette-input">
          <Icon name="search" size={16} />
          <input
            ref={inputRef}
            aria-label="輸入指令或任務名稱"
            placeholder="搜尋任務、對話或指令"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setIndex(0)
            }}
            onKeyDown={onKeyDown}
          />
        </div>
        <ul className="palette-list" role="listbox" aria-label="結果">
          {results.length === 0 ? <li className="palette-empty">沒有符合的項目。</li> : null}
          {results.map((item, position) => (
            <li key={item.id} role="option" aria-selected={position === active}>
              <button
                type="button"
                tabIndex={-1}
                className={`palette-row${position === active ? ' active' : ''}`}
                onMouseMove={() => setIndex(position)}
                onClick={() => choose(item)}
              >
                <Icon name={item.icon} />
                <span className="palette-label">{item.label}</span>
                <span className="palette-hint">{item.hint}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
