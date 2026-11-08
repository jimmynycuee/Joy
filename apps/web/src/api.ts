declare const __JOY_API_TOKEN__: string

const TOKEN_KEY = 'joy.apiToken'

/**
 * The access token: one this device saved (remote access, or after regenerating), else the one the local dev server
 * injected. Storage can be unavailable (private windows), so every access is guarded.
 */
export function apiToken(): string {
  try {
    return window.localStorage.getItem(TOKEN_KEY) || __JOY_API_TOKEN__
  } catch {
    return __JOY_API_TOKEN__
  }
}

export function saveApiToken(token: string): void {
  try {
    window.localStorage.setItem(TOKEN_KEY, token)
  } catch {
    // Without storage the token only lasts until reload; the gate asks again.
  }
}

/** Tells the app the token was refused, so it can ask for a new one. */
export const UNAUTHORIZED_EVENT = 'joy-unauthorized'

type ApiErrorBody = { error?: string }

/** A failed API call; `status` lets callers treat 409 (busy, conflict) and 429 (too many) differently. */
export class ApiError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers)
  if (init?.body && !headers.has('content-type')) headers.set('content-type', 'application/json')
  headers.set('authorization', `Bearer ${apiToken()}`)
  const response = await fetch(path, { ...init, headers })
  if (response.status === 401) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT))
  const text = await response.text()
  const body = text ? (JSON.parse(text) as T & ApiErrorBody) : ({} as T & ApiErrorBody)
  if (!response.ok) throw new ApiError(body.error ?? `請求失敗（${response.status}）`, response.status)
  return body
}

/** Downloads an authenticated API response as a file. */
export async function downloadFile(path: string, filename: string): Promise<void> {
  const response = await fetch(path, { headers: { authorization: `Bearer ${apiToken()}` } })
  if (!response.ok) throw new Error(`下載失敗（${response.status}）`)
  const url = URL.createObjectURL(await response.blob())
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

/** Removes worktrees; asks again before losing commits that exist nowhere else. */
export async function removeWithConfirmation(path: string, body: Record<string, unknown>): Promise<boolean> {
  try {
    await request(path, { method: 'POST', body: JSON.stringify(body) })
    return true
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    if (!/unpushed commit/.test(message)) throw error
    if (!window.confirm(`${message}\n\n還是要刪掉這些 commit 嗎？`)) return false
    await request(path, { method: 'POST', body: JSON.stringify({ ...body, confirmUnpushedCommits: true }) })
    return true
  }
}
