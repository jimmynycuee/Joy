// `pnpm joy open`: opens Joy in the browser already signed in. The token travels in the URL fragment, which the browser
// never sends to a server, and reaches the browser through a page only the owner can read, never through a command
// line other users could see.

import { randomUUID } from 'node:crypto'
import { open, unlink } from 'node:fs/promises'
import { join } from 'node:path'

/** The address of Joy with the token in its fragment; the web app saves it and takes it out of the address bar. */
export function signedInUrl(port: number, token: string): string {
  return `http://127.0.0.1:${port}/#token=${encodeURIComponent(token)}`
}

/** A page that sends the browser on to `url` without keeping itself in the history. */
export function handoffPage(url: string): string {
  const target = JSON.stringify(url).replace(/</g, '\\u003c')
  return [
    '<!doctype html>',
    '<meta charset="utf-8">',
    '<meta name="referrer" content="no-referrer">',
    '<title>Joy</title>',
    `<script>location.replace(${target})</script>`,
  ].join('\n')
}

/** How to open a file or address in the default browser, without a shell. */
export function browserCommand(
  platform: NodeJS.Platform,
  target: string,
): { command: string; args: string[] } {
  if (platform === 'darwin') return { command: 'open', args: [target] }
  if (platform === 'win32') return { command: 'rundll32', args: ['url.dll,FileProtocolHandler', target] }
  return { command: 'xdg-open', args: [target] }
}

export interface OpenJoyDeps {
  readToken: () => Promise<string>
  /** Launches the browser; resolves once the command started. */
  launch: (command: string, args: string[]) => Promise<void>
  wait: (ms: number) => Promise<void>
  platform: NodeJS.Platform
}

/** How long the hand-off page stays on disk: long enough for a browser that is still starting. */
export const HANDOFF_PAGE_MS = 30_000

/**
 * Writes the hand-off page into the owner-only Joy folder, opens it, and removes it again. The page is created with
 * owner-only permissions before anything is written to it.
 */
export async function openJoy(home: string, port: number, deps: OpenJoyDeps): Promise<void> {
  const token = await deps.readToken()
  const page = join(home, `open-${randomUUID()}.html`)
  const file = await open(page, 'wx', 0o600)
  try {
    await file.writeFile(handoffPage(signedInUrl(port, token)), 'utf8')
  } finally {
    await file.close()
  }
  try {
    const { command, args } = browserCommand(deps.platform, page)
    await deps.launch(command, args)
    await deps.wait(HANDOFF_PAGE_MS)
  } finally {
    await unlink(page).catch(() => undefined)
  }
}
