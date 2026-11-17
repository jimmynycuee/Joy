import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { git, KeyedMutex, listProjectFiles } from './git.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('listProjectFiles', () => {
  it('lists tracked and untracked files but not ignored ones or .git, up to the limit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'joy-list-files-'))
    dirs.push(dir)
    await git(dir, ['init', '-q'])
    mkdirSync(join(dir, 'src', 'deep'), { recursive: true })
    mkdirSync(join(dir, 'node_modules', 'x'), { recursive: true })
    writeFileSync(join(dir, '.gitignore'), 'node_modules/\n*.log\n')
    writeFileSync(join(dir, 'src', 'a.ts'), 'a')
    writeFileSync(join(dir, 'src', 'deep', 'b file.ts'), 'b')
    writeFileSync(join(dir, 'node_modules', 'x', 'index.js'), 'x')
    writeFileSync(join(dir, 'debug.log'), 'x')
    await git(dir, ['add', 'src/a.ts'])
    const files = await listProjectFiles(dir)
    expect(files.sort()).toEqual(['.gitignore', 'src/a.ts', 'src/deep/b file.ts'])
    expect(await listProjectFiles(dir, 2)).toHaveLength(2)
  })

  it('is empty outside a git checkout', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'joy-list-files-'))
    dirs.push(dir)
    expect(await listProjectFiles(join(dir, 'missing'))).toEqual([])
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
