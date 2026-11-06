import { createDecipheriv, createECDH, hkdfSync, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import type { Database } from '@joy/db'
import { listPushSubscriptions, openDatabase, savePushSubscription } from '@joy/db'
import { MemoryBackend, Redactor, SecretStore } from '@joy/secrets'
import { sendPush, vapidKeys } from './push.js'

const databases: Database[] = []
const closers: Array<() => void> = []
afterEach(() => {
  for (const db of databases.splice(0)) if (db.isOpen) db.close()
  for (const close of closers.splice(0)) close()
})

/** What a browser does with an aes128gcm push body (RFC 8291), to check what Joy sent. */
function decrypt(body: Buffer, browser: { ecdh: ReturnType<typeof createECDH>; auth: Buffer }): string {
  const salt = body.subarray(0, 16)
  const keyLength = body.readUInt8(20)
  const serverPublic = body.subarray(21, 21 + keyLength)
  const ciphertext = body.subarray(21 + keyLength)
  const shared = browser.ecdh.computeSecret(serverPublic)
  const info = Buffer.concat([Buffer.from('WebPush: info\0'), browser.ecdh.getPublicKey(), serverPublic])
  const ikm = Buffer.from(hkdfSync('sha256', shared, browser.auth, info, 32))
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16))
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12))
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce)
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16))
  const plain = Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()])
  return plain.subarray(0, plain.lastIndexOf(2)).toString('utf8')
}

async function fakePushService(status: number) {
  const received: Array<{ headers: Record<string, unknown>; body: Buffer }> = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      received.push({ headers: req.headers, body: Buffer.concat(chunks) })
      res.writeHead(status).end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  closers.push(() => server.close())
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/push/abc`, received }
}

describe('web push', () => {
  it('keeps one key pair in the keychain and encrypts a redacted message for each browser', async () => {
    const redactor = new Redactor()
    redactor.add('push-secret-99')
    const backend = new MemoryBackend()
    const secrets = new SecretStore({ backend })
    const keys = await vapidKeys(secrets, redactor)
    expect(await vapidKeys(secrets, redactor)).toEqual(keys)
    expect(redactor.redact(keys.privateKey)).not.toContain(keys.privateKey)

    const db = openDatabase(':memory:')
    databases.push(db)
    const service = await fakePushService(201)
    const browser = { ecdh: createECDH('prime256v1'), auth: randomBytes(16) }
    browser.ecdh.generateKeys()
    savePushSubscription(db, {
      endpoint: service.url,
      keys: {
        p256dh: browser.ecdh.getPublicKey().toString('base64url'),
        auth: browser.auth.toString('base64url'),
      },
    })
    const delivered = await sendPush(
      db,
      keys,
      { title: 'Task done', body: 'Rotated push-secret-99', url: '/?task=t1' },
      { redactor },
    )
    expect(delivered).toBe(1)
    const [request] = service.received
    expect(String(request?.headers.authorization)).toMatch(/^vapid t=.+, k=/)
    expect(request?.headers['content-encoding']).toBe('aes128gcm')
    const message = JSON.parse(decrypt(request?.body ?? Buffer.alloc(0), browser)) as {
      title: string
      body: string
    }
    expect(message.title).toBe('Task done')
    expect(message.body).not.toContain('push-secret-99')
  })

  it('forgets a browser the push service says is gone', async () => {
    const db = openDatabase(':memory:')
    databases.push(db)
    const service = await fakePushService(410)
    const browser = createECDH('prime256v1')
    browser.generateKeys()
    savePushSubscription(db, {
      endpoint: service.url,
      keys: {
        p256dh: browser.getPublicKey().toString('base64url'),
        auth: randomBytes(16).toString('base64url'),
      },
    })
    const keys = await vapidKeys(new SecretStore({ backend: new MemoryBackend() }), new Redactor())
    expect(await sendPush(db, keys, { title: 't', body: 'b' }, { redactor: new Redactor() })).toBe(0)
    expect(listPushSubscriptions(db)).toEqual([])
  })
})
