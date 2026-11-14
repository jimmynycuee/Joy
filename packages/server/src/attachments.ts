// Files the owner attaches to a task or a message: validation, storage under <JOY_HOME>/attachments, and handing them
// to agents. The bytes never go into SQLite, events, logs or memory; only id, name, type and size do.
import { randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentProvider, ImageInput, ImageMediaType, Steer, TaskId } from '@joy/core'
import {
  createAttachment,
  deleteUnusedAttachment,
  deleteUnusedAttachments,
  getAttachment,
  listAttachmentIds,
  type AttachmentMediaType,
  type AttachmentRecord,
  type Database,
} from '@joy/db'

/** The Messages API refuses larger images (Claude Code passes the bytes on as they are). */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
/** Text goes into the prompt itself, so it is kept small enough not to crowd out the task. */
export const MAX_TEXT_BYTES = 256 * 1024
export const MAX_ATTACHMENTS_PER_MESSAGE = 10
export const MAX_MESSAGE_ATTACHMENT_BYTES = 20 * 1024 * 1024
/** Uploads no message used (an abandoned draft) are removed after this long. */
export const UNUSED_ATTACHMENT_TTL_MS = 7 * 24 * 60 * 60 * 1000

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const MARKER_SOURCE = String.raw`\[\[joy-attachment:([0-9a-f-]{36})\]\]`

export class AttachmentError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

/** Only ids Joy made can name a file, so an id can never point outside the attachments folder. */
export function isAttachmentId(id: string): boolean {
  return UUID.test(id)
}

/** The image type from the file's first bytes; extensions and Content-Type headers are not trusted. */
export function sniffImage(bytes: Uint8Array): ImageMediaType | undefined {
  const starts = (sig: number[], at = 0) => sig.every((byte, i) => bytes[at + i] === byte)
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (starts([0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (starts([0x47, 0x49, 0x46, 0x38]) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61)
    return 'image/gif'
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp'
  return undefined
}

/** UTF-8 text without NUL or other binary control bytes (tab, newline, carriage return and form feed are fine). */
export function isText(bytes: Uint8Array): boolean {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    // eslint-disable-next-line no-control-regex
    return !/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/.test(text)
  } catch {
    return false
  }
}

/** What kind of file this is by content, or an error the owner can act on. */
export function classifyAttachment(bytes: Uint8Array): AttachmentMediaType {
  if (bytes.byteLength === 0) throw new AttachmentError(400, 'The file is empty')
  const image = sniffImage(bytes)
  if (image) {
    if (bytes.byteLength > MAX_IMAGE_BYTES)
      throw new AttachmentError(413, `Images can be at most ${MAX_IMAGE_BYTES / 1024 / 1024} MB`)
    return image
  }
  if (isText(bytes)) {
    if (bytes.byteLength > MAX_TEXT_BYTES)
      throw new AttachmentError(413, `Text files can be at most ${MAX_TEXT_BYTES / 1024} KB`)
    return 'text/plain'
  }
  throw new AttachmentError(415, 'Only images (PNG, JPEG, GIF, WebP) and text or code files can be attached')
}

/**
 * A display name: the last path segment, without control or reserved characters, at most 200 characters. It is only
 * shown and told to the agent; the file is stored under its id.
 */
export function sanitizeFileName(raw: string | undefined, mediaType: AttachmentMediaType): string {
  let name = raw ?? ''
  try {
    name = decodeURIComponent(name)
  } catch {
    // Not percent-encoded: use as sent.
  }
  name = (name.split(/[/\\]/).pop() ?? '')
    .normalize('NFC')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>:"|?*‪-‮⁦-⁩]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+|[\s.]+$/g, '')
  name = [...name].slice(0, 200).join('')
  if (name) return name
  return mediaType === 'text/plain'
    ? 'file.txt'
    : `image.${mediaType.slice('image/'.length).replace('jpeg', 'jpg')}`
}

/** Reads a request body, refusing it as soon as it grows past `limit`. */
export async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > limit) throw new AttachmentError(413, 'The file is too large')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    size += data.byteLength
    if (size > limit) throw new AttachmentError(413, 'The file is too large')
    chunks.push(data)
  }
  return Buffer.concat(chunks)
}

/** The public shape of an attachment (API responses and event payloads). */
export interface AttachmentInfo {
  id: string
  name: string
  mediaType: AttachmentMediaType
  size: number
}

export function attachmentInfo(record: AttachmentRecord): AttachmentInfo {
  return { id: record.id, name: record.name, mediaType: record.mediaType, size: record.size }
}

/** Where attachment bytes live, and what goes with them. */
export class AttachmentStore {
  private lastSweep = 0

  constructor(
    private readonly db: Database,
    readonly dir: string,
    private readonly now: () => number = Date.now,
  ) {}

  pathOf(id: string): string {
    if (!isAttachmentId(id)) throw new AttachmentError(400, 'Invalid attachment id')
    return join(this.dir, id)
  }

  async save(bytes: Buffer, rawName: string | undefined): Promise<AttachmentRecord> {
    const mediaType = classifyAttachment(bytes)
    const id = randomUUID()
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    const path = this.pathOf(id)
    // Written aside and renamed, so a reader never sees half a file.
    await writeFile(`${path}.part`, bytes, { mode: 0o600 })
    await rename(`${path}.part`, path)
    try {
      return createAttachment(this.db, {
        id,
        name: sanitizeFileName(rawName, mediaType),
        mediaType,
        size: bytes.byteLength,
      })
    } catch (error) {
      await rm(path, { force: true })
      throw error
    } finally {
      void this.sweepSoon()
    }
  }

  get(id: string): AttachmentRecord | undefined {
    return isAttachmentId(id) ? getAttachment(this.db, id) : undefined
  }

  async read(record: AttachmentRecord): Promise<Buffer> {
    try {
      return await readFile(this.pathOf(record.id))
    } catch (error) {
      throw new Error(
        `The attached file "${record.name}" is missing from ${this.dir}; remove it and attach it again.`,
        { cause: error },
      )
    }
  }

  /** Removes an upload no message used yet (the owner took it out of the box). */
  async discard(id: string): Promise<boolean> {
    const record = this.get(id)
    if (!record) return false
    if (record.taskId) throw new AttachmentError(409, 'This file was already sent and cannot be removed')
    if (!deleteUnusedAttachment(this.db, id)) return false
    await rm(this.pathOf(id), { force: true })
    return true
  }

  /**
   * Checks the files a message wants to use before anything is created: each exists, is not used yet, and together
   * they stay within the limits.
   */
  checkUnused(ids: readonly string[]): AttachmentRecord[] {
    if (new Set(ids).size !== ids.length) throw new AttachmentError(400, 'An attachment is listed twice')
    if (ids.length > MAX_ATTACHMENTS_PER_MESSAGE)
      throw new AttachmentError(400, `At most ${MAX_ATTACHMENTS_PER_MESSAGE} files per message`)
    const records = ids.map((id) => {
      const record = this.get(id)
      if (!record) throw new AttachmentError(400, `Attachment ${id} was not found; attach the file again`)
      if (record.taskId) throw new AttachmentError(409, `Attachment ${record.name} was already sent`)
      return record
    })
    if (records.reduce((sum, r) => sum + r.size, 0) > MAX_MESSAGE_ATTACHMENT_BYTES)
      throw new AttachmentError(
        413,
        `The files of one message can be at most ${MAX_MESSAGE_ATTACHMENT_BYTES / 1024 / 1024} MB together`,
      )
    return records
  }

  /** Removes abandoned uploads and files no row points to. Runs at most once an hour unless forced. */
  async sweep(force = false): Promise<void> {
    const now = this.now()
    if (!force && now - this.lastSweep < 60 * 60 * 1000) return
    this.lastSweep = now
    for (const record of deleteUnusedAttachments(
      this.db,
      new Date(now - UNUSED_ATTACHMENT_TTL_MS).toISOString(),
    ))
      await rm(this.pathOf(record.id), { force: true })
    let names: string[]
    try {
      names = await readdir(this.dir)
    } catch {
      return
    }
    const known = listAttachmentIds(this.db)
    for (const name of names) {
      const partial = name.endsWith('.part')
      // An upload may be writing its file right now; only a startup sweep removes leftovers.
      if (partial && !force) continue
      const id = partial ? name.slice(0, -'.part'.length) : name
      // Never touch anything Joy did not name itself.
      if (!isAttachmentId(id) || known.has(name)) continue
      await rm(join(this.dir, name), { force: true })
    }
  }

  private async sweepSoon(): Promise<void> {
    try {
      await this.sweep()
    } catch {
      // Cleanup is best effort; the next upload tries again.
    }
  }
}

/** Where an attachment sits in text meant for an agent. Joy replaces it before the agent sees the text. */
export function attachmentMarker(id: string): string {
  return `[[joy-attachment:${id}]]`
}

/** The owner's text as the agent should get it: the text, then one marker per attached file. */
export function withAttachmentMarkers(text: string, ids: readonly string[]): string {
  if (!ids.length) return text
  return [text, '', ...ids.map(attachmentMarker)].join('\n').trim()
}

export function hasAttachmentMarker(text: string): boolean {
  return new RegExp(MARKER_SOURCE).test(text)
}

/** Attachment ids recorded on a `user.message` event payload. */
export function payloadAttachmentIds(payload: unknown): string[] {
  const list = (payload as { attachments?: unknown } | null)?.attachments
  if (!Array.isArray(list)) return []
  return list.flatMap((item) => {
    const id = (item as { id?: unknown } | null)?.id
    return typeof id === 'string' && isAttachmentId(id) ? [id] : []
  })
}

/**
 * Replaces markers with what the agent should read: an image becomes a short note and is handed over as an image,
 * a text file is quoted in full. Only files of `taskId` count; any other marker (for example one copied into an
 * issue) is left as plain words, so content from outside cannot reach the owner's files.
 */
export async function resolveAttachmentMarkers(
  text: string,
  store: AttachmentStore,
  taskId: TaskId | undefined,
): Promise<{ text: string; images: ImageInput[] }> {
  const images: ImageInput[] = []
  const seen = new Set<string>()
  const parts: string[] = []
  let last = 0
  for (const match of text.matchAll(new RegExp(MARKER_SOURCE, 'g'))) {
    parts.push(text.slice(last, match.index))
    last = match.index + match[0].length
    const id = match[1] ?? ''
    const record = store.get(id)
    if (!record || !taskId || record.taskId !== taskId) {
      parts.push('[attachment not available]')
      continue
    }
    if (record.mediaType === 'text/plain') {
      const content = (await store.read(record)).toString('utf8').replace(/^\uFEFF/, '')
      const longest = Math.max(0, ...[...content.matchAll(/`+/g)].map((m) => m[0].length))
      const fence = '`'.repeat(Math.max(3, longest + 1))
      parts.push(`File attached by the owner: "${record.name}"\n${fence}\n${content}\n${fence}`)
      continue
    }
    // Make sure the file is still there now, not when the backend reads it.
    await store.read(record)
    parts.push(`[Image attached by the owner: "${record.name}"]`)
    if (!seen.has(id)) {
      seen.add(id)
      images.push({ path: store.pathOf(id), mediaType: record.mediaType })
    }
  }
  parts.push(text.slice(last))
  return { text: parts.join(''), images }
}

/**
 * Lets every backend take attachments: markers in the prompt (and in steering messages) become text and images.
 * `taskId` names the task whose files a run may use.
 */
export function withAttachments(
  inner: AgentProvider,
  store: AttachmentStore,
  taskId: () => TaskId | undefined,
): AgentProvider {
  return {
    kind: inner.kind,
    capabilities: inner.capabilities,
    healthCheck: () => inner.healthCheck(),
    async *run(opts, model) {
      const task = taskId()
      const onSteer = opts.onSteer
      const steerWith = (steer: Steer | undefined): Steer | undefined =>
        steer &&
        (async (text, images) => {
          const resolved = await resolveAttachmentMarkers(text, store, task)
          return steer(resolved.text, [...(images ?? []), ...resolved.images])
        })
      if (!hasAttachmentMarker(opts.prompt) && !onSteer) {
        yield* inner.run(opts, model)
        return
      }
      const resolved = await resolveAttachmentMarkers(opts.prompt, store, task)
      const images = [...(opts.images ?? []), ...resolved.images]
      yield* inner.run(
        {
          ...opts,
          prompt: resolved.text,
          ...(images.length ? { images } : {}),
          ...(onSteer ? { onSteer: (steer: Steer | undefined) => onSteer(steerWith(steer)) } : {}),
        },
        model,
      )
    },
  }
}
