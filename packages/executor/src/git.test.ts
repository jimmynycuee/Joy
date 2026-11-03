import { describe, expect, it } from 'vitest'
import { KeyedMutex } from './git.js'

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
