// `pnpm joy open` hands the access token over in the address's fragment (`#token=…`), which the browser never sends
// to a server. The app saves it and takes it out of the address bar and the history before anything else runs.

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,}$/

/** The token in a `#token=…` fragment, or undefined. Other fragments are left alone. */
export function tokenFromHash(hash: string): string | undefined {
  if (!hash.startsWith('#')) return undefined
  const token = new URLSearchParams(hash.slice(1)).get('token')
  return token && TOKEN_PATTERN.test(token) ? token : undefined
}

/**
 * Saves a handed-over token and replaces the address with the same one minus the fragment, so the token is not left
 * in the history or a bookmark. Any `#token=` fragment is dropped, even one that is not a valid token.
 */
export function takeTokenFromUrl(
  location: Pick<Location, 'hash' | 'pathname' | 'search'>,
  history: Pick<History, 'replaceState' | 'state'>,
  save: (token: string) => void,
): boolean {
  if (!/^#(.*&)?token=/.test(location.hash)) return false
  const token = tokenFromHash(location.hash)
  if (token) save(token)
  history.replaceState(history.state, '', `${location.pathname}${location.search}`)
  return token !== undefined
}
