import { existsSync, lstatSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** `missing`: nothing built yet. `stale`: a source file is newer than the build. `fresh`: the build is current. */
export type UiBuildState = 'missing' | 'stale' | 'fresh'

/**
 * What the built UI is made from: a change to any of these makes the build in apps/web/dist out of date. The web app
 * imports `@joy/core` and `@joy/config` at build time, so their sources count too.
 */
const UI_INPUTS = [
  ['apps', 'web', 'src'],
  ['apps', 'web', 'public'],
  ['apps', 'web', 'index.html'],
  ['apps', 'web', 'vite.config.ts'],
  ['apps', 'web', 'package.json'],
  ['packages', 'core', 'src'],
  ['packages', 'core', 'package.json'],
  ['packages', 'config', 'src'],
  ['packages', 'config', 'package.json'],
]

/** Newest modification time (ms) of a file or of everything under a folder; 0 when it does not exist. Symlinks are not followed. */
function newestMtime(path: string): number {
  let stat
  try {
    stat = lstatSync(path)
  } catch {
    return 0
  }
  if (stat.isSymbolicLink()) return 0
  if (!stat.isDirectory()) return stat.mtimeMs
  let newest = stat.mtimeMs
  for (const entry of readdirSync(path)) newest = Math.max(newest, newestMtime(join(path, entry)))
  return newest
}

/**
 * Whether apps/web/dist exists and is newer than the web sources. A `git pull` that changes the UI makes it `stale`,
 * so `pnpm joy start` can say that `pnpm joy build-ui` is needed (the server only hands out what is built).
 */
export function uiBuildState(repoRoot: string): UiBuildState {
  const web = join(repoRoot, 'apps', 'web')
  const built = join(web, 'dist', 'index.html')
  if (!existsSync(built)) return 'missing'
  const builtAt = statSync(built).mtimeMs
  const sourceAt = Math.max(0, ...UI_INPUTS.map((input) => newestMtime(join(repoRoot, ...input))))
  return sourceAt > builtAt ? 'stale' : 'fresh'
}
