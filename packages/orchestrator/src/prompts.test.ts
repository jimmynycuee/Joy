import { describe, expect, it } from 'vitest'
import { MAX_DIFF_CHARS, patchSinceLastReview, reviewPrompt, splitPatch } from './prompts.js'

const file = (path: string, body: string) =>
  [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, '@@ -1 +1 @@', body].join('\n')

describe('follow-up review prompt', () => {
  it('splits a patch per file and keeps unchanged files out of the follow-up diff', () => {
    const before = `${file('a.ts', '+a')}\n${file('b.ts', '+b')}\n`
    expect([...splitPatch(before).keys()]).toEqual(['a.ts', 'b.ts'])
    // The last file of a patch may or may not end with a newline; it is the same diff either way.
    const after = `${file('a.ts', '+a')}\n${file('b.ts', '+b2')}`
    expect(patchSinceLastReview(before, after)).toEqual({
      patch: `${file('b.ts', '+b2')}\n`,
      unchanged: ['a.ts'],
      reverted: [],
    })
    expect(patchSinceLastReview(before, before)).toEqual({
      patch: '',
      unchanged: ['a.ts', 'b.ts'],
      reverted: [],
    })
  })

  it('says when no file changed since the last review and still caps a long diff', () => {
    const verdict = { approve: false, summary: 'Needs tests', findings: [] }
    const same = file('a.ts', '+a')
    const prompt = reviewPrompt('Task', same, undefined, { verdict, patch: same })
    expect(prompt).toContain('No file diff changed since your last review.')
    expect(prompt).toContain('Your previous summary: Needs tests')
    expect(prompt).toContain('(no specific findings)')

    const long = file('a.ts', `+${'x'.repeat(MAX_DIFF_CHARS)}`)
    const capped = reviewPrompt('Task', long, undefined, { verdict, patch: same })
    expect(capped).toContain(`first ${MAX_DIFF_CHARS} characters of`)
  })

  it('tells the reviewer when it had approved and only the checks failed', () => {
    const verdict = { approve: true, summary: 'Fine', findings: [] }
    const prompt = reviewPrompt('Task', file('a.ts', '+b'), undefined, { verdict, patch: file('a.ts', '+a') })
    expect(prompt).toContain('You approved an earlier version of this change, but the project checks failed')
    expect(prompt).not.toContain('did not approve')
  })
})
