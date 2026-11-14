import { describe, expect, it } from 'vitest'
import type { PendingAttachment } from './attachments.js'
import {
  formatSize,
  MAX_ATTACHMENTS,
  parseAttachments,
  pastedFiles,
  precheck,
  sendableAttachments,
} from './attachments.js'

const ready = (id: string): PendingAttachment => ({
  key: id,
  id,
  name: `${id}.png`,
  size: 1,
  status: 'ready',
})

describe('attachments', () => {
  it('formats sizes the way a file list does', () => {
    expect(formatSize(512)).toBe('512 B')
    expect(formatSize(1536)).toBe('1.5 KB')
    expect(formatSize(200 * 1024)).toBe('200 KB')
    expect(formatSize(5 * 1024 * 1024)).toBe('5.0 MB')
  })

  it('refuses files the server would refuse anyway, before uploading', () => {
    expect(precheck({ size: 10, type: 'image/png' }, 0)).toBeUndefined()
    expect(precheck({ size: 0, type: 'text/plain' }, 0)).toBe('檔案是空的')
    expect(precheck({ size: 6 * 1024 * 1024, type: 'image/png' }, 0)).toBe('圖片上限 5.0 MB')
    expect(precheck({ size: 300 * 1024, type: '' }, 0)).toBe('文字檔上限 256 KB')
    expect(precheck({ size: 1, type: 'image/png' }, MAX_ATTACHMENTS)).toBe('最多 10 個檔案')
  })

  it('sends only when every file is uploaded', () => {
    expect(sendableAttachments([])).toEqual({ ids: [], blocked: false })
    expect(sendableAttachments([ready('a'), ready('b')])).toEqual({ ids: ['a', 'b'], blocked: false })
    expect(sendableAttachments([ready('a'), { key: 'x', name: 'x', size: 1, status: 'uploading' }])).toEqual({
      ids: [],
      blocked: true,
    })
    expect(
      sendableAttachments([{ key: 'x', name: 'x', size: 1, status: 'error', error: 'no' }]).blocked,
    ).toBe(true)
  })

  it('reads attachment lists defensively', () => {
    expect(parseAttachments(undefined)).toEqual([])
    expect(parseAttachments([{ id: 'a', name: 'n' }, { id: 1 }])).toEqual([
      { id: 'a', name: 'n', mediaType: '', size: 0 },
    ])
  })

  it('attaches pasted files, unless the paste also carries text', () => {
    const file = { name: 'shot.png' } as File
    const data = (text: string) => ({ files: [file] as unknown as FileList, getData: () => text })
    expect(pastedFiles(data(''))).toEqual([file])
    expect(pastedFiles(data('cell A1'))).toEqual([])
  })
})
