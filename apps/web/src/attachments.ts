// Files attached to a message: limits mirrored from the server (which decides), sizes, and the draft's saved list.
// Uploads go to the server as soon as they are added, so a draft only keeps their ids and names.

import { readStorage, writeStorage } from './storage.js'
import { record } from './types.js'

export interface AttachmentInfo {
  id: string
  name: string
  mediaType: string
  size: number
}

export type AttachmentStatus = 'uploading' | 'ready' | 'error'

/** One file in the message box. `localUrl` previews an image before (and after) it is uploaded. */
export interface PendingAttachment {
  key: string
  name: string
  size: number
  status: AttachmentStatus
  id?: string
  mediaType?: string
  error?: string
  localUrl?: string
}

export const MAX_ATTACHMENTS = 10
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
export const MAX_TEXT_BYTES = 256 * 1024

export function isImageType(mediaType: string | undefined): boolean {
  return typeof mediaType === 'string' && mediaType.startsWith('image/')
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** A reason to refuse a file before uploading it; the server checks the content again either way. */
export function precheck(file: { size: number; type: string }, count: number): string | undefined {
  if (count >= MAX_ATTACHMENTS) return `最多 ${MAX_ATTACHMENTS} 個檔案`
  if (file.size === 0) return '檔案是空的'
  if (isImageType(file.type)) {
    if (file.size > MAX_IMAGE_BYTES) return `圖片上限 ${formatSize(MAX_IMAGE_BYTES)}`
  } else if (file.size > MAX_TEXT_BYTES) return `文字檔上限 ${formatSize(MAX_TEXT_BYTES)}`
  return undefined
}

/** What can be sent now: the ids of uploaded files, or nothing while one is uploading or failed. */
export function sendableAttachments(items: readonly PendingAttachment[]): {
  ids: string[]
  blocked: boolean
} {
  const blocked = items.some((item) => item.status !== 'ready' || !item.id)
  return { ids: blocked ? [] : items.map((item) => item.id as string), blocked }
}

/** Attachment metadata from an API response or event payload; anything malformed is left out. */
export function parseAttachments(value: unknown): AttachmentInfo[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const r = record(item)
    if (!r || typeof r.id !== 'string' || typeof r.name !== 'string') return []
    return [
      {
        id: r.id,
        name: r.name,
        mediaType: typeof r.mediaType === 'string' ? r.mediaType : '',
        size: typeof r.size === 'number' ? r.size : 0,
      },
    ]
  })
}

const DRAFT_PREFIX = 'joy.draft-attachments.'

export function readDraftAttachments(context: string): PendingAttachment[] {
  try {
    return parseAttachments(JSON.parse(readStorage(`${DRAFT_PREFIX}${context}`) ?? '[]')).map((info) => ({
      key: info.id,
      ...info,
      status: 'ready' as const,
    }))
  } catch {
    return []
  }
}

/** Keeps the uploaded files of an unsent draft; uploads still running or failed are not worth keeping. */
export function writeDraftAttachments(context: string, items: readonly PendingAttachment[]): void {
  const ready = items.flatMap((item) =>
    item.status === 'ready' && item.id
      ? [{ id: item.id, name: item.name, mediaType: item.mediaType ?? '', size: item.size }]
      : [],
  )
  writeStorage(`${DRAFT_PREFIX}${context}`, ready.length ? JSON.stringify(ready) : null)
}

/**
 * Files to attach from a paste. Text that comes with them (a spreadsheet copies both) is pasted as text instead.
 */
export function pastedFiles(data: Pick<DataTransfer, 'files' | 'getData'>): File[] {
  if (data.getData('text/plain').trim()) return []
  return Array.from(data.files)
}
