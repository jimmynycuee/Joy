import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { KeyedMutex, git, gitEnvironment } from './git.js'

describe('gitEnvironment', () => {
  it('drops what redirects git, in any letter case, and keeps the rest', () => {
    const env = gitEnvironment(
      {
        PATH: '/bin',
        HOME: '/home/me',
        GIT_DIR: '/elsewhere/.git',
        GIT_WORK_TREE: '/elsewhere',
        GIT_INDEX_FILE: '/elsewhere/index',
        GIT_OBJECT_DIRECTORY: '/elsewhere/objects',
        GIT_ALTERNATE_OBJECT_DIRECTORIES: '/x',
        GIT_COMMON_DIR: '/elsewhere/common',
        GIT_NAMESPACE: 'ns',
        GIT_PREFIX: 'sub/',
        GIT_CONFIG: '/c',
        GIT_CONFIG_GLOBAL: '/g',
        GIT_CONFIG_SYSTEM: '/s',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'core.hooksPath',
        GIT_CONFIG_VALUE_0: '/hooks',
        GIT_CONFIG_PARAMETERS: "'a.b=c'",
        git_dir: '/lower',
        Git_Config_Global: '/mixed',
        GIT_EXEC_PATH: '/usr/lib/git-core',
      },
      { GIT_TERMINAL_PROMPT: '0' },
    )
    expect(env).toEqual({
      PATH: '/bin',
      HOME: '/home/me',
      GIT_EXEC_PATH: '/usr/lib/git-core',
      GIT_TERMINAL_PROMPT: '0',
    })
  })

  it('lets the caller set a variable it just removed', () => {
    expect(gitEnvironment({ GIT_DIR: '/x' }, { GIT_DIR: '/mine' })).toEqual({ GIT_DIR: '/mine' })
  })
})

describe('git()', () => {
  const dirs: string[] = []
  const saved = { ...process.env }
  afterEach(() => {
    process.env = { ...saved }
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('works in the folder it was given even when the process has GIT_DIR, GIT_WORK_TREE and GIT_CONFIG_* set', async () => {
    const mine = mkdtempSync(join(tmpdir(), 'joy-git-env-mine-'))
    const other = mkdtempSync(join(tmpdir(), 'joy-git-env-other-'))
    dirs.push(mine, other)
    await git(mine, ['init'])
    await git(other, ['init'])
    process.env.GIT_DIR = join(other, '.git')
    process.env.GIT_WORK_TREE = other
    process.env.GIT_CONFIG_COUNT = '1'
    process.env.GIT_CONFIG_KEY_0 = 'joy.test'
    process.env.GIT_CONFIG_VALUE_0 = 'leaked'
    expect((await git(mine, ['rev-parse', '--show-toplevel'])).trim()).toContain('joy-git-env-mine-')
    await expect(git(mine, ['config', '--get', 'joy.test'])).rejects.toThrow()
  })
})

describe('KeyedMutex', () => {
  it('runs work for the same key one at a time, in order, even after a failure', async () => {
    const mutex = new KeyedMutex()
    const log: string[] = []
    const step =
      (name: string, fail = false) =>
      async () => {
        log.push(`start ${name}`)
        await new Promise((r) => setTimeout(r, 5))
        log.push(`end ${name}`)
        if (fail) throw new Error(name)
        return name
      }
    const results = await Promise.allSettled([
      mutex.run('k', step('a')),
      mutex.run('k', step('b', true)),
      mutex.run('k', step('c')),
    ])
    expect(log).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c'])
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled'])
  })

  it('runs different keys concurrently', async () => {
    const mutex = new KeyedMutex()
    const log: string[] = []
    const step = (name: string) => async () => {
      log.push(`start ${name}`)
      await new Promise((r) => setTimeout(r, 5))
      log.push(`end ${name}`)
    }
    await Promise.all([mutex.run('x', step('x')), mutex.run('y', step('y'))])
    expect(log.slice(0, 2)).toEqual(['start x', 'start y'])
  })
})
