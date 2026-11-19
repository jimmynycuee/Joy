// What the address bar says about the open page, so a task or conversation has a link of its own and the browser's
// back and forward buttons move between pages. Query strings, not paths: the server serves the app at `/` only, and
// notifications already open `/?task=<id>`.

export const SETTINGS_SECTIONS = [
  'general',
  'models',
  'permissions',
  'notifications',
  'projects',
  'plugins',
  'data',
  'stats',
  'archived',
  'advanced',
] as const
export type RouteSettingsSection = (typeof SETTINGS_SECTIONS)[number]

export type Route =
  | { kind: 'new-task' }
  | { kind: 'task'; id: string }
  /** `id` is empty for a conversation not started yet. */
  | { kind: 'chat'; id: string }
  | { kind: 'settings'; section: RouteSettingsSection; repoId: string | null }

function isSection(value: string): value is RouteSettingsSection {
  return (SETTINGS_SECTIONS as readonly string[]).includes(value)
}

/** The page a query string names. Anything it does not recognise is the new-task page, like `/`. */
export function parseRoute(search: string): Route {
  const params = new URLSearchParams(search)
  const task = params.get('task')
  if (task) return { kind: 'task', id: task }
  const chat = params.get('chat')
  if (chat !== null) return { kind: 'chat', id: chat }
  const settings = params.get('settings')
  if (settings !== null) {
    const repo = params.get('repo')
    const section = isSection(settings) ? settings : 'general'
    return { kind: 'settings', section, repoId: section === 'projects' && repo ? repo : null }
  }
  return { kind: 'new-task' }
}

/** The query string for a page (empty for the new-task page); `parseRoute` reads it back to the same page. */
export function routeQuery(route: Route): string {
  const params = new URLSearchParams()
  if (route.kind === 'task') params.set('task', route.id)
  else if (route.kind === 'chat') params.set('chat', route.id)
  else if (route.kind === 'settings') {
    params.set('settings', route.section)
    if (route.section === 'projects' && route.repoId) params.set('repo', route.repoId)
  }
  const query = params.toString()
  // `?chat=` reads better as `?chat`.
  return query ? `?${query.replace(/^chat=$/, 'chat')}` : ''
}

/**
 * Whether moving from one page to the next rewrites the current history entry instead of adding one. A new
 * conversation getting its id, and a settings section or project changing, are the same page settling, so 返回
 * should not stop at each step.
 */
export function replacesEntry(previous: Route, next: Route): boolean {
  if (previous.kind === 'chat' && next.kind === 'chat') return previous.id === ''
  return previous.kind === 'settings' && next.kind === 'settings'
}
