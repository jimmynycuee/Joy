import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { downloadFile, errorMessage } from '../api.js'
import type { AttachmentInfo, PendingAttachment } from '../attachments.js'
import { formatSize, isImageType } from '../attachments.js'
import { useAttachmentUrl } from '../hooks/useAttachments.js'
import { Icon, IconButton, Spinner } from './ui.js'

/** The files waiting above the message box. State is shown with icons: a spinner while uploading, an alert on failure. */
export function AttachmentTray({
  items,
  onRemove,
}: {
  items: readonly PendingAttachment[]
  onRemove: (key: string) => void
}) {
  if (!items.length) return null
  return (
    <ul className="attachment-tray" aria-label="附件" data-testid="attachment-tray">
      {items.map((item) => (
        <li
          key={item.key}
          className={`attachment-chip attachment-${item.status}`}
          data-status={item.status}
          title={item.error ?? `${item.name} · ${formatSize(item.size)}`}
        >
          <ChipPreview item={item} />
          {isImageType(item.mediaType) ? null : (
            <span className="attachment-meta">
              <span className="attachment-name">{item.name}</span>
              <span className="attachment-size">{formatSize(item.size)}</span>
            </span>
          )}
          {item.status === 'uploading' ? (
            <span className="attachment-state" role="status" aria-label={`正在上傳 ${item.name}`}>
              <Spinner />
            </span>
          ) : item.status === 'error' ? (
            <span
              className="attachment-state attachment-failed"
              role="img"
              aria-label={item.error ?? '上傳失敗'}
            >
              <Icon name="alert" size={14} />
            </span>
          ) : null}
          <IconButton
            icon="x"
            label={`移除 ${item.name}`}
            className="attachment-remove"
            onClick={() => onRemove(item.key)}
          />
        </li>
      ))}
    </ul>
  )
}

function ChipPreview({ item }: { item: PendingAttachment }) {
  const remote = useAttachmentUrl(isImageType(item.mediaType) && !item.localUrl ? item.id : undefined)
  const url = item.localUrl ?? remote.url
  if (isImageType(item.mediaType) && url)
    return <img className="attachment-thumb" src={url} alt={item.name} />
  return (
    <span className="attachment-icon" aria-hidden="true">
      <Icon name={isImageType(item.mediaType) ? 'paperclip' : 'file'} size={16} />
    </span>
  )
}

/** Removing a sent file: which ones are removed already, and how to remove one. */
export interface AttachmentControls {
  removed: ReadonlySet<string>
  onRemove: (attachment: AttachmentInfo) => void | Promise<void>
}

/** Files on a sent message: image thumbnails that open large, other files by name (click to save). */
export function MessageAttachments({
  attachments,
  controls,
}: {
  attachments: readonly AttachmentInfo[]
  controls?: AttachmentControls | undefined
}) {
  const [open, setOpen] = useState<AttachmentInfo | undefined>()
  if (!attachments.length) return null
  return (
    <div className="message-attachments" data-testid="message-attachments">
      {attachments.map((attachment) =>
        attachment.disabled || controls?.removed.has(attachment.id) ? (
          <span
            key={attachment.id}
            className="message-file attachment-removed"
            data-testid="removed-attachment"
            title={attachment.name}
          >
            <Icon name="file" size={14} />
            <span className="attachment-name">{attachment.name}</span>
          </span>
        ) : (
          <span key={attachment.id} className="message-attachment">
            {isImageType(attachment.mediaType) ? (
              <ImageThumb attachment={attachment} onOpen={() => setOpen(attachment)} />
            ) : (
              <FileChip attachment={attachment} />
            )}
            {controls ? (
              <IconButton
                icon="x"
                label={`移除 ${attachment.name}`}
                className="attachment-remove"
                onClick={() => void controls.onRemove(attachment)}
              />
            ) : null}
          </span>
        ),
      )}
      {open ? <Lightbox attachment={open} onClose={() => setOpen(undefined)} /> : null}
    </div>
  )
}

function ImageThumb({ attachment, onOpen }: { attachment: AttachmentInfo; onOpen: () => void }) {
  const { url, failed } = useAttachmentUrl(attachment.id)
  return (
    <button type="button" className="message-image" aria-label={`放大 ${attachment.name}`} onClick={onOpen}>
      {url ? (
        <img src={url} alt={attachment.name} />
      ) : (
        <span className="attachment-icon" aria-hidden="true">
          <Icon name={failed ? 'alert' : 'paperclip'} size={16} />
        </span>
      )}
    </button>
  )
}

function FileChip({ attachment }: { attachment: AttachmentInfo }) {
  const [failed, setFailed] = useState('')
  return (
    <button
      type="button"
      className="message-file"
      title={failed || `${attachment.name} · ${formatSize(attachment.size)}`}
      onClick={() =>
        void downloadFile(`/api/attachments/${encodeURIComponent(attachment.id)}`, attachment.name).catch(
          (cause: unknown) => setFailed(errorMessage(cause, '下載失敗')),
        )
      }
    >
      <Icon name={failed ? 'alert' : 'file'} size={14} />
      <span className="attachment-name">{attachment.name}</span>
      <span className="attachment-size">{formatSize(attachment.size)}</span>
    </button>
  )
}

function Lightbox({ attachment, onClose }: { attachment: AttachmentInfo; onClose: () => void }) {
  const { url } = useAttachmentUrl(attachment.id)
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  // On <body>, so no scrolling container of the thread clips it.
  return createPortal(
    <div className="lightbox" role="dialog" aria-modal="true" aria-label={attachment.name} onClick={onClose}>
      {url ? <img src={url} alt={attachment.name} /> : <Spinner />}
      <IconButton icon="x" label="關閉" className="lightbox-close" onClick={onClose} />
    </div>,
    document.body,
  )
}
