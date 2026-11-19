import { describe, expect, it } from 'vitest'
import { parseRoute, replacesEntry, routeQuery } from './route.js'
import type { Route } from './route.js'

describe('parseRoute and routeQuery', () => {
  const routes: Array<[Route, string]> = [
    [{ kind: 'new-task' }, ''],
    [{ kind: 'task', id: 'task-1' }, '?task=task-1'],
    [{ kind: 'chat', id: 'c 1' }, '?chat=c+1'],
    [{ kind: 'chat', id: '' }, '?chat'],
    [{ kind: 'settings', section: 'stats', repoId: null }, '?settings=stats'],
    [{ kind: 'settings', section: 'projects', repoId: 'r1' }, '?settings=projects&repo=r1'],
  ]

  it('writes each page as an address and reads it back to the same page', () => {
    for (const [route, url] of routes) {
      expect(routeQuery(route)).toBe(url)
      expect(parseRoute(url)).toEqual(route)
    }
  })

  it('opens the task a notification links to', () => {
    expect(parseRoute('?task=abc')).toEqual({ kind: 'task', id: 'abc' })
  })

  it('falls back to the new-task page, or 一般, for what it does not know', () => {
    expect(parseRoute('')).toEqual({ kind: 'new-task' })
    expect(parseRoute('?task=')).toEqual({ kind: 'new-task' })
    expect(parseRoute('?foo=bar')).toEqual({ kind: 'new-task' })
    expect(parseRoute('?settings=nope')).toEqual({ kind: 'settings', section: 'general', repoId: null })
    // A project only narrows 專案.
    expect(parseRoute('?settings=stats&repo=r1')).toEqual({ kind: 'settings', section: 'stats', repoId: null })
  })
})

describe('replacesEntry', () => {
  it('replaces while a new conversation gets its id and while moving inside 設定', () => {
    expect(replacesEntry({ kind: 'chat', id: '' }, { kind: 'chat', id: 'c1' })).toBe(true)
    expect(
      replacesEntry(
        { kind: 'settings', section: 'general', repoId: null },
        { kind: 'settings', section: 'stats', repoId: null },
      ),
    ).toBe(true)
  })

  it('adds an entry for every other move', () => {
    expect(replacesEntry({ kind: 'chat', id: 'c1' }, { kind: 'chat', id: 'c2' })).toBe(false)
    expect(replacesEntry({ kind: 'task', id: 'a' }, { kind: 'task', id: 'b' })).toBe(false)
    expect(replacesEntry({ kind: 'new-task' }, { kind: 'task', id: 'a' })).toBe(false)
    expect(replacesEntry({ kind: 'task', id: 'a' }, { kind: 'settings', section: 'general', repoId: null })).toBe(
      false,
    )
  })
})
