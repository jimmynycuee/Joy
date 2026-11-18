import { ApiError } from './api.js'

/** What `GET /api/fs/folders` answers: one folder and the folders directly inside it. */
export interface FolderListing {
  path: string
  parent: string | null
  home: string
  isGit: boolean
  crumbs: Array<{ name: string; path: string }>
  folders: Array<{ name: string; path: string; isGit: boolean }>
  truncated: boolean
}

/** The URL that lists `path`; the home folder when there is none. The path travels percent-encoded. */
export function foldersUrl(path?: string): string {
  const text = path?.trim() ?? ''
  return text === '' ? '/api/fs/folders' : `/api/fs/folders?path=${encodeURIComponent(text)}`
}

/** One line for a failed listing, by what went wrong; the server's own words are English. */
export function folderErrorText(cause: unknown): string {
  if (cause instanceof ApiError) {
    if (cause.status === 403) return '這個資料夾不能瀏覽'
    if (cause.status === 404) return '找不到這個資料夾'
    if (cause.status === 400) return '這不是可用的資料夾路徑'
    if (cause.status === 401) return '需要重新輸入存取權杖'
    return cause.message
  }
  return '連不到 Joy server'
}

/** What `GET /api/fs/repository` answers for a git repository. */
export interface RepositoryInfo {
  path: string
  defaultBranch: string | null
  githubRemote: string | null
}

export function repositoryUrl(path: string): string {
  return `/api/fs/repository?path=${encodeURIComponent(path)}`
}

/** One line for a project that could not be added, when the reason is one the owner can fix here. */
export function addProjectErrorText(cause: unknown, branch: string): string | undefined {
  if (cause instanceof ApiError && cause.status === 422) return `這個專案沒有「${branch}」分支`
  return undefined
}

/** One line for a failed `git init`. */
export function gitInitErrorText(cause: unknown): string {
  if (cause instanceof ApiError) {
    if (cause.status === 409) return '這裡已經是 git 專案'
    if (cause.status === 403) return '這個資料夾不能使用'
    if (cause.status === 400) return '不能在這個位置建立專案，請選專案自己的資料夾'
    return cause.message
  }
  return '連不到 Joy server'
}
