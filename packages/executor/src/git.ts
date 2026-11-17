import { execFile } from 'node:child_process'

export class GitError extends Error {
  constructor(
    message: string,
    readonly args: string[],
    readonly stderr: string,
  ) {
    super(message)
    this.name = 'GitError'
  }
}

/**
 * Runs git without a shell. Long paths are enabled for Windows, prompts are disabled so a missing
 * credential fails instead of hanging, and output is not localized so it can be parsed.
 */
export function git(cwd: string, args: string[]): Promise<string> {
  const full = ['-c', 'core.longpaths=true', '-c', 'core.quotepath=false', ...args]
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      full,
      {
        cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', LANG: 'C' },
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        if (err) {
          const code = (err as NodeJS.ErrnoException).code
          const message =
            code === 'ENOENT'
              ? 'git was not found on PATH. Install git to use Joy.'
              : `git ${args.join(' ')} failed: ${stderr.trim() || err.message}`
          reject(new GitError(message, args, stderr))
        } else resolve(stdout)
      },
    )
  })
}

/** Serializes async work per key. `git worktree add` on the same repo races on `.git/worktrees` locks. */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<unknown>>()

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    const tail = next.catch(() => undefined)
    this.tails.set(key, tail)
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key)
    })
    return next
  }
}

/**
 * Files in a checkout as git sees them: tracked plus untracked ones that `.gitignore` does not exclude (so nothing in
 * `.git`, `node_modules` or build output). At most `limit` paths, relative with `/`. Not a git checkout: empty.
 */
export async function listProjectFiles(cwd: string, limit = 20_000): Promise<string[]> {
  let out: string
  try {
    out = await git(cwd, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
  } catch {
    return []
  }
  const seen = new Set<string>()
  for (const path of out.split('\0')) {
    if (!path || seen.has(path)) continue
    seen.add(path)
    if (seen.size >= limit) break
  }
  return [...seen]
}
