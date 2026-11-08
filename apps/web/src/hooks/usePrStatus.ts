import { useCallback, useEffect, useRef, useState } from 'react'
import { errorMessage, request } from '../api.js'
import { parsePrStatus, shouldPollPr } from '../pr-status.js'
import type { PrStatus } from '../pr-status.js'

/** How often the PR is asked about while the page is visible. The server caches each PR for 60 s anyway. */
export const PR_POLL_MS = 60_000

/**
 * The pull request of a published task: read once, then every 60 s while the page is visible, until the PR is merged
 * or closed or all its checks finished. `refresh` asks again right now.
 */
export function usePrStatus(
  taskId: string,
  enabled: boolean,
): { status: PrStatus | null; error: string; refresh: () => void } {
  const [status, setStatus] = useState<PrStatus | null>(null)
  const [error, setError] = useState('')
  const loadRef = useRef<() => Promise<void>>(async () => undefined)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    let settled = false
    let lastLoad = 0
    const load = async () => {
      lastLoad = Date.now()
      try {
        const parsed = parsePrStatus(await request<unknown>(`/api/tasks/${encodeURIComponent(taskId)}/pr`))
        if (cancelled) return
        setStatus(parsed)
        setError(parsed ? '' : '讀不到 PR 狀態')
        settled = !shouldPollPr(parsed)
      } catch (cause) {
        if (!cancelled) setError(errorMessage(cause, '讀不到 PR 狀態'))
      }
    }
    loadRef.current = load
    void load()
    const visible = () => document.visibilityState === 'visible'
    const timer = window.setInterval(() => {
      if (!settled && visible()) void load()
    }, PR_POLL_MS)
    // Coming back to the tab refreshes a status that went stale while it was hidden.
    const onVisibility = () => {
      if (!settled && visible() && Date.now() - lastLoad >= PR_POLL_MS) void load()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [taskId, enabled])

  const refresh = useCallback(() => void loadRef.current(), [])
  return { status, error, refresh }
}
