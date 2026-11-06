import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GhIssueSource, repositoryName } from './issues.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A stand-in for `gh` that records its arguments and answers from a fixed table. */
function fakeGh(answers: Record<string, unknown>, fail = false) {
  const dir = mkdtempSync(join(tmpdir(), 'joy-fake-gh-'))
  dirs.push(dir)
  const script = join(dir, 'gh.mjs')
  writeFileSync(
    script,
    `const args = process.argv.slice(2)
if (${fail}) { console.error('HTTP 401: Bad credentials'); process.exit(1) }
const answers = ${JSON.stringify(answers)}
const path = args.at(-1)
process.stdout.write(JSON.stringify({ args, body: answers[path.split('?')[0]] ?? null }.body))
`,
  )
  return new GhIssueSource({ ghExecutable: process.execPath, ghPrefixArgs: [script] })
}

describe('GhIssueSource', () => {
  it('lists labelled issues without pull requests', async () => {
    const source = fakeGh({
      'repos/o/r/issues': [
        { number: 1, title: 'Bug', body: 'b', labels: [{ name: 'joy' }] },
        { number: 2, title: 'PR', body: '', labels: [], pull_request: {} },
      ],
    })
    expect(await source.listLabeledIssues('https://github.com/o/r.git', 'joy')).toEqual([
      { number: 1, title: 'Bug', body: 'b', labels: [{ name: 'joy' }] },
    ])
  })

  it('reads one issue and refuses pull requests', async () => {
    const source = fakeGh({
      'repos/o/r/issues/5': { number: 5, title: 'x', body: null, labels: [] },
      'repos/o/r/issues/6': { number: 6, title: 'y', body: null, labels: [], pull_request: {} },
    })
    expect(await source.getIssue('git@github.com:o/r.git', 5)).toMatchObject({ number: 5 })
    await expect(source.getIssue('git@github.com:o/r.git', 6)).rejects.toThrow(/pull request/)
    await expect(source.getIssue('git@github.com:o/r.git', 0)).rejects.toThrow(/positive/)
  })

  it('explains a failed gh call without echoing output', async () => {
    await expect(fakeGh({}, true).listLabeledIssues('https://github.com/o/r', 'joy')).rejects.toThrow(
      /Bad credentials.*gh auth status/,
    )
  })

  it('names the repository for the issue adapter', () => {
    expect(repositoryName('https://github.com/o/r.git')).toBe('o/r')
  })
})
