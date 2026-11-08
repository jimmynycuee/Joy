import { describe, expect, it } from 'vitest'
import { checkpointLabel, discardedCommitCount, mapCheckpoints } from './checkpoints.js'

const item = (n: number, extra: Record<string, unknown> = {}) => ({
  n,
  ref: `refs/joy/checkpoints/t/${n}`,
  commit: 'abc',
  head: 'def',
  round: 1,
  label: 'implementer turn, round 1',
  attemptId: 'a1',
  createdAt: '2026-11-08T10:00:00.000Z',
  available: true,
  ...extra,
})

describe('mapCheckpoints', () => {
  it('lists the newest first with Chinese labels', () => {
    const views = mapCheckpoints({
      checkpoints: [item(1), item(2, { label: 'before restoring checkpoint 1', round: 2 })],
    })
    expect(views.map((view) => view.n)).toEqual([2, 1])
    expect(views[0]).toMatchObject({ label: '還原到檢查點 1 之前的狀態', round: 2, available: true })
    expect(views[1]?.label).toBe('實作者完成第 1 輪')
  })

  it('marks checkpoints of removed worktrees and skips malformed entries', () => {
    const views = mapCheckpoints({ checkpoints: [item(1, { available: false }), { nope: true }, null] })
    expect(views).toHaveLength(1)
    expect(views[0]?.available).toBe(false)
    expect(mapCheckpoints({})).toEqual([])
    expect(mapCheckpoints(null)).toEqual([])
  })
})

describe('checkpointLabel', () => {
  it('translates the labels the server writes and keeps unknown ones', () => {
    expect(checkpointLabel('implementer turn')).toBe('實作者完成一輪')
    expect(checkpointLabel('something else')).toBe('something else')
  })
})

describe('discardedCommitCount', () => {
  it('reads the commit count of the restore 409, and nothing from other errors', () => {
    expect(
      discardedCommitCount(
        'Restoring this checkpoint would discard 2 commits made after it; confirm to continue (send {"confirm": true})',
      ),
    ).toBe(2)
    expect(discardedCommitCount('Restoring this checkpoint would discard 1 commit made after it')).toBe(1)
    expect(discardedCommitCount('Task is running; cancel it or wait for it to finish')).toBeUndefined()
  })
})
