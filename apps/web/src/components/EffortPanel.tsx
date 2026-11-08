import { useRef } from 'react'
import type { KeyboardEvent, PointerEvent } from 'react'
import { EFFORTS } from '@joy/core'
import type { Effort } from '@joy/core'
import { effortAtPosition, effortLabel, segmentAt, stepEffort } from '../effort.js'
import { Button } from './ui.js'

/**
 * The 投入程度 popover: the current level as a title, the model as a link back to the model list, a five-step slider
 * (drag, arrow keys, digits 1-5, or click a step) and 重設. Levels the model does not take are greyed out.
 */
export function EffortPanel({
  effort,
  supported,
  modelName,
  onChange,
  onReset,
  onPickModel,
}: {
  effort: Effort | undefined
  /** Efforts the current model takes; empty when nobody has validated them. */
  supported: readonly Effort[]
  modelName: string
  onChange: (effort: Effort) => void
  onReset: () => void
  onPickModel: () => void
}) {
  const track = useRef<HTMLDivElement | null>(null)
  const dragging = useRef(false)
  const unavailable = supported.length === 0
  const index = effort ? EFFORTS.indexOf(effort) : -1

  function pick(next: Effort | undefined) {
    if (next && next !== effort) onChange(next)
  }

  function fromPointer(event: PointerEvent<HTMLDivElement>): Effort | undefined {
    const rect = track.current?.getBoundingClientRect()
    if (!rect || rect.width === 0) return undefined
    return effortAtPosition((event.clientX - rect.left) / rect.width, supported)
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (unavailable || event.button !== 0) return
    const rect = track.current?.getBoundingClientRect()
    if (!rect) return
    // Pressing a greyed-out step does nothing; dragging into one stops at the nearest step the model takes.
    const pressed = EFFORTS[segmentAt((event.clientX - rect.left) / rect.width)]
    if (!pressed || !supported.includes(pressed)) return
    dragging.current = true
    event.currentTarget.setPointerCapture(event.pointerId)
    pick(pressed)
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    if (dragging.current) pick(fromPointer(event))
  }

  function onPointerUp(event: PointerEvent<HTMLDivElement>) {
    dragging.current = false
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId)
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (unavailable || event.ctrlKey || event.metaKey || event.altKey) return
    const ordered = EFFORTS.filter((level) => supported.includes(level))
    let next: Effort | undefined
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next = stepEffort(effort, supported, 1)
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next = stepEffort(effort, supported, -1)
    else if (event.key === 'Home') next = ordered[0]
    else if (event.key === 'End') next = ordered.at(-1)
    else if (/^[1-5]$/.test(event.key)) {
      const level = EFFORTS[Number(event.key) - 1]
      next = level && supported.includes(level) ? level : undefined
    } else return
    event.preventDefault()
    pick(next)
  }

  return (
    <div className="effort-panel">
      <div className="effort-head">
        <span className="effort-title" aria-live="polite">
          {effort ? effortLabel(effort) : '預設'}
        </span>
        <Button variant="ghost" className="effort-reset" onClick={onReset}>
          重設
        </Button>
      </div>
      <button
        type="button"
        className="effort-model"
        aria-label={`模型：${modelName}，點一下換模型`}
        onClick={onPickModel}
      >
        {modelName}
        <span aria-hidden="true"> ›</span>
      </button>
      <div
        ref={track}
        className={`effort-slider${unavailable ? ' off' : ''}`}
        role="slider"
        tabIndex={unavailable ? -1 : 0}
        data-autofocus
        aria-label="投入程度"
        aria-valuemin={1}
        aria-valuemax={EFFORTS.length}
        aria-valuenow={index >= 0 ? index + 1 : undefined}
        aria-valuetext={effort ? effortLabel(effort) : '未指定'}
        aria-disabled={unavailable || undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
      >
        {EFFORTS.map((level, position) => {
          const off = !supported.includes(level)
          return (
            <div
              key={level}
              className={`effort-step${position <= index ? ' filled' : ''}${position === index ? ' current' : ''}${off ? ' unsupported' : ''}`}
              data-effort={level}
              aria-hidden="true"
              title={off && !unavailable ? `這個模型沒有「${effortLabel(level)}」` : undefined}
            >
              <span className="effort-bar" />
              <span className="effort-name">{effortLabel(level)}</span>
            </div>
          )
        })}
      </div>
      {unavailable ? <p className="effort-note">這個模型沒有已驗證的投入程度，送出時不指定。</p> : null}
    </div>
  )
}
