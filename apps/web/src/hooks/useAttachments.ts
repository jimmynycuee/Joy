import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, apiToken, errorMessage, request } from '../api.js'
import type { AttachmentInfo, PendingAttachment } from '../attachments.js'
import { isImageType, precheck, readDraftAttachments, writeDraftAttachments } from '../attachments.js'

let nextKey = 0

function discard(id: string): Promise<unknown> {
  return request(`/api/attachments/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => undefined)
}

async function upload(file: File): Promise<AttachmentInfo> {
  const { attachment } = await request<{ attachment: AttachmentInfo }>('/api/attachments', {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', 'x-joy-filename': encodeURIComponent(file.name) },
    body: file,
  })
  return attachment
}

/**
 * The files of one message box, kept per context like the text draft: each file is uploaded when added, and the
 * draft remembers the uploaded ones (by id) across page switches and reloads.
 */
export function useAttachments(context: string) {
  const [items, setItems] = useState<PendingAttachment[]>(() => readDraftAttachments(context))
  const contextRef = useRef(context)
  // Removed while still uploading: once the upload lands, it is freed on the server too.
  const removedKeys = useRef(new Set<string>())
  const itemsRef = useRef(items)
  itemsRef.current = items

  useEffect(() => {
    contextRef.current = context
    setItems(readDraftAttachments(context))
  }, [context])

  const update = useCallback((change: (current: PendingAttachment[]) => PendingAttachment[]) => {
    setItems((current) => {
      const next = change(current)
      writeDraftAttachments(contextRef.current, next)
      return next
    })
  }, [])

  const add = useCallback(
    (files: readonly File[]) => {
      let count = itemsRef.current.length
      for (const file of files) {
        const key = `local-${++nextKey}`
        const problem = precheck(file, count)
        const localUrl = isImageType(file.type) ? URL.createObjectURL(file) : undefined
        update((current) => [
          ...current,
          {
            key,
            name: file.name || '圖片',
            size: file.size,
            status: problem ? 'error' : 'uploading',
            ...(file.type ? { mediaType: file.type } : {}),
            ...(problem ? { error: problem } : {}),
            ...(localUrl ? { localUrl } : {}),
          },
        ])
        if (problem) continue
        count++
        const origin = contextRef.current
        upload(file)
          .then((info) => {
            if (removedKeys.current.delete(key)) {
              void discard(info.id)
              return
            }
            if (contextRef.current !== origin) return
            update((current) =>
              current.map((item) =>
                item.key === key
                  ? {
                      ...item,
                      status: 'ready',
                      id: info.id,
                      name: info.name,
                      mediaType: info.mediaType,
                      size: info.size,
                    }
                  : item,
              ),
            )
          })
          .catch((cause: unknown) => {
            removedKeys.current.delete(key)
            if (contextRef.current !== origin) return
            const message = errorMessage(cause, '上傳失敗')
            update((current) =>
              current.map((item) => (item.key === key ? { ...item, status: 'error', error: message } : item)),
            )
          })
      }
    },
    [update],
  )

  const remove = useCallback(
    (key: string) => {
      const item = itemsRef.current.find((candidate) => candidate.key === key)
      if (item?.localUrl) URL.revokeObjectURL(item.localUrl)
      // Not sent yet, so nothing needs it: free it on the server too (best effort, cleanup catches the rest).
      if (item?.status === 'ready' && item.id) void discard(item.id)
      if (item?.status === 'uploading') removedKeys.current.add(key)
      update((current) => current.filter((candidate) => candidate.key !== key))
    },
    [update],
  )

  /** After sending: the files belong to the message now. */
  const clear = useCallback(() => {
    for (const item of itemsRef.current) if (item.localUrl) URL.revokeObjectURL(item.localUrl)
    update(() => [])
  }, [update])

  return { items, add, remove, clear }
}

const blobUrls = new Map<string, Promise<string>>()

/** An authenticated attachment as an object URL (an <img> cannot send the access token itself). */
export function useAttachmentUrl(id: string | undefined): { url?: string; failed: boolean } {
  const [state, setState] = useState<{ url?: string; failed: boolean }>({ failed: false })
  useEffect(() => {
    if (!id) return
    let live = true
    let pending = blobUrls.get(id)
    if (!pending) {
      pending = fetch(`/api/attachments/${encodeURIComponent(id)}`, {
        headers: { authorization: `Bearer ${apiToken()}` },
      }).then(async (response) => {
        if (!response.ok) throw new ApiError(`無法讀取附件（${response.status}）`, response.status)
        return URL.createObjectURL(await response.blob())
      })
      blobUrls.set(id, pending)
      // A failed load may succeed later (for example after the token is entered again).
      pending.catch(() => blobUrls.delete(id))
    }
    pending.then(
      (url) => live && setState({ url, failed: false }),
      () => live && setState({ failed: true }),
    )
    return () => {
      live = false
    }
  }, [id])
  return id ? state : { failed: false }
}
