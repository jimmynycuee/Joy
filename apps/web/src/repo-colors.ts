import type { Repo } from './types.js'

/**
 * The six project colours, muted so they read as a small dot and never as text colour.
 * The ids are what the server stores (`REPO_COLORS` in `packages/db`); keep the two lists equal.
 */
export const REPO_COLORS = [
  { id: 'blue', label: '灰藍', hex: '#7C93B5' },
  { id: 'green', label: '灰綠', hex: '#7FA58E' },
  { id: 'purple', label: '灰紫', hex: '#9A8BB8' },
  { id: 'orange', label: '灰橘', hex: '#C39A74' },
  { id: 'pink', label: '灰粉', hex: '#BE8E9E' },
  { id: 'teal', label: '灰青', hex: '#6FA6A8' },
] as const

export type RepoColorId = (typeof REPO_COLORS)[number]['id']
export type RepoColor = (typeof REPO_COLORS)[number]

/**
 * The colour a project shows: the one the owner picked, otherwise one handed out by the project's place in the
 * list (the server returns repos in the order they were added, and they are never removed), so it stays the same.
 */
export function repoColor(repoId: string | undefined, repos: readonly Repo[]): RepoColor | undefined {
  const index = repos.findIndex((repo) => repo.id === repoId)
  const repo = repos[index]
  if (!repo) return undefined
  return REPO_COLORS.find((color) => color.id === repo.color) ?? REPO_COLORS[index % REPO_COLORS.length]
}
