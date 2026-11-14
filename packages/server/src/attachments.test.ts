import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RepoId, TaskId } from '@joy/core'
import { createRepo, createTask, linkAttachments, openDatabase } from '@joy/db'
import type { Database } from '@joy/db'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AttachmentStore,
  classifyAttachment,
  hasAttachmentMarker,
  resolveAttachmentMarkers,
  sanitizeFileName,
  sniffImage,
  UNUSED_ATTACHMENT_TTL_MS,
  withAttachmentMarkers,
} from './attachments.js'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])
const dirs: string[] = []
const dbs: Database[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  for (const db of dbs.splice(0)) db.close()
})

function store(now: () => number = Date.now) {
  const dir = mkdtempSync(join(tmpdir(), 'joy-attachments-'))
  dirs.push(dir)
  const db = openDatabase(':memory:')
  dbs.push(db)
  createRepo(db, { id: 'r' as RepoId, path: '/r', defaultBranch: 'main' })
  const task = createTask(db, {
    id: 't' as TaskId,
    repoId: 'r' as RepoId,
    title: 't',
    prompt: 'p',
    mode: 'single',
  })
  return {
    db,
    task: task.id,
    dir: join(dir, 'attachments'),
    store: new AttachmentStore(db, join(dir, 'attachments'), now),
  }
}

describe('content checks', () => {
  it('sniffs only real image signatures', () => {
    expect(sniffImage(PNG)).toBe('image/png')
    expect(sniffImage(Buffer.from('GIF87a'))).toBe('image/gif')
    expect(sniffImage(Buffer.from('GIF88a'))).toBeUndefined()
    expect(sniffImage(Buffer.from('RIFF\0\0\0\0WAVE'))).toBeUndefined()
    expect(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeUndefined()
  })

  it('treats SVG and other markup as text, never as an image', () => {
    expect(classifyAttachment(Buffer.from('<svg onload="alert(1)"/>'))).toBe('text/plain')
    expect(() => classifyAttachment(Buffer.from([0xc3, 0x28]))).toThrow(/Only images/)
  })

  it('names fall back by type', () => {
    expect(sanitizeFileName('%E8%9E%A2%E5%B9%95.png', 'image/png')).toBe('螢幕.png')
    expect(sanitizeFileName('%ZZbad', 'image/png')).toBe('%ZZbad')
    expect(sanitizeFileName('', 'image/jpeg')).toBe('image.jpg')
    expect(sanitizeFileName('', 'text/plain')).toBe('file.txt')
    expect([...sanitizeFileName('x'.repeat(500), 'text/plain')].length).toBe(200)
  })
})

describe('markers', () => {
  it('adds one marker per file and keeps text-only messages as they are', () => {
    expect(withAttachmentMarkers('hi', [])).toBe('hi')
    const text = withAttachmentMarkers('', ['00000000-0000-4000-8000-000000000001'])
    expect(text).toBe('[[joy-attachment:00000000-0000-4000-8000-000000000001]]')
    expect(hasAttachmentMarker(text)).toBe(true)
    expect(hasAttachmentMarker(text)).toBe(true)
  })

  it('quotes a text file with a fence longer than any backtick run in it', async () => {
    const { store: s, db, task } = store()
    const record = await s.save(Buffer.from('a ```` b'), 'x.md')
    linkAttachments(db, [record.id], task)
    const out = await resolveAttachmentMarkers(withAttachmentMarkers('see', [record.id]), s, task)
    expect(out.text).toContain('`````\na ```` b\n`````')
    expect(out.images).toEqual([])
  })

  it('leaves unknown and unlinked ids as plain words', async () => {
    const { store: s, task } = store()
    const unlinked = await s.save(PNG, 'a.png')
    const out = await resolveAttachmentMarkers(withAttachmentMarkers('x', [unlinked.id]), s, task)
    expect(out).toEqual({ text: 'x\n\n[attachment not available]', images: [] })
  })
})

describe('AttachmentStore.sweep', () => {
  it('removes week-old unused uploads, leftovers and stray files it named, nothing else', async () => {
    let now = Date.parse('2026-11-01T00:00:00Z')
    const { store: s, db, task, dir } = store(() => now)
    const used = await s.save(PNG, 'used.png')
    const unused = await s.save(PNG, 'unused.png')
    linkAttachments(db, [used.id], task)
    // Rows are timestamped by SQLite; age them so the clock decides.
    db.prepare("UPDATE attachments SET created_at = '2026-10-01T00:00:00.000Z'").run()
    mkdirSync(dir, { recursive: true })
    const stray = '00000000-0000-4000-8000-0000000000ff'
    writeFileSync(join(dir, stray), 'x')
    writeFileSync(join(dir, `${stray}.part`), 'x')
    writeFileSync(join(dir, 'README'), 'keep')
    now += UNUSED_ATTACHMENT_TTL_MS
    await s.sweep()
    expect(existsSync(join(dir, unused.id))).toBe(false)
    expect(s.get(unused.id)).toBeUndefined()
    expect(existsSync(join(dir, used.id))).toBe(true)
    expect(existsSync(join(dir, stray))).toBe(false)
    // Only a startup sweep removes half-written uploads, which may still be in progress otherwise.
    expect(existsSync(join(dir, `${stray}.part`))).toBe(true)
    await s.sweep(true)
    expect(existsSync(join(dir, `${stray}.part`))).toBe(false)
    expect(existsSync(join(dir, 'README'))).toBe(true)
  })
})
