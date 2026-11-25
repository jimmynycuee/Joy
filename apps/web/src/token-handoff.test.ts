import { describe, expect, it } from 'vitest'
import { takeTokenFromUrl, tokenFromHash } from './token-handoff.js'

const token = 'a'.repeat(43)

function browser(hash: string) {
  const saved: string[] = []
  const replaced: string[] = []
  const location = { hash, pathname: '/', search: '?task=t1' }
  const history = {
    state: { keep: true },
    replaceState: (_state: unknown, _title: string, url?: string | URL | null) => {
      replaced.push(String(url))
    },
  }
  return { saved, replaced, run: () => takeTokenFromUrl(location, history, (value) => saved.push(value)) }
}

describe('token hand-off from pnpm joy open', () => {
  it('reads only a well-formed token from the fragment', () => {
    expect(tokenFromHash(`#token=${token}`)).toBe(token)
    expect(tokenFromHash(`#x=1&token=${token}`)).toBe(token)
    expect(tokenFromHash('#token=short')).toBeUndefined()
    expect(tokenFromHash('#token=has space and more than sixteen')).toBeUndefined()
    expect(tokenFromHash('')).toBeUndefined()
  })

  it('saves the token and takes it out of the address, keeping the page it points at', () => {
    const page = browser(`#token=${token}`)
    expect(page.run()).toBe(true)
    expect(page.saved).toEqual([token])
    expect(page.replaced).toEqual(['/?task=t1'])
  })

  it('drops a bad token from the address without saving it, and leaves other fragments alone', () => {
    const bad = browser('#token=nope')
    expect(bad.run()).toBe(false)
    expect(bad.saved).toEqual([])
    expect(bad.replaced).toEqual(['/?task=t1'])
    const other = browser('#section')
    expect(other.run()).toBe(false)
    expect(other.replaced).toEqual([])
  })
})
