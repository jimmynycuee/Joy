// Web Push (T4.2): notifications to the owner's browsers and phone when a task finishes or needs approval. Joy signs
// with its own VAPID keys (kept in the keychain) and sends straight to each browser's push service; nothing goes
// through a Joy server elsewhere. The payload is encrypted for the subscribed browser.
import type { Database, PushSubscriptionRecord } from '@joy/db'
import { deletePushSubscription, listPushSubscriptions } from '@joy/db'
import type { Redactor, SecretStore } from '@joy/secrets'
import webpush from 'web-push'

export interface PushMessage {
  title: string
  body: string
  /** Where tapping the notification opens Joy (a path such as `/?task=…`). */
  url?: string
}

export interface VapidKeys {
  publicKey: string
  privateKey: string
}

/** The signing keys, created on first use and stored in the keychain. */
export async function vapidKeys(secrets: SecretStore, redactor: Redactor): Promise<VapidKeys> {
  const stored = await secrets.get('web_push_vapid_keys')
  if (stored) {
    const parsed = JSON.parse(stored) as Partial<VapidKeys>
    if (typeof parsed.publicKey === 'string' && typeof parsed.privateKey === 'string') {
      redactor.add(parsed.privateKey)
      return { publicKey: parsed.publicKey, privateKey: parsed.privateKey }
    }
  }
  const keys = webpush.generateVAPIDKeys()
  await secrets.set('web_push_vapid_keys', JSON.stringify(keys))
  redactor.add(keys.privateKey)
  return keys
}

/**
 * Sends `message` to every subscribed browser. Subscriptions the push service says are gone (404/410) are removed.
 * Returns how many were delivered. Failures never throw: a notification must not break a task.
 */
export async function sendPush(
  db: Database,
  keys: VapidKeys,
  message: PushMessage,
  options: { redactor: Redactor; fetch?: typeof fetch; warn?: (text: string) => void },
): Promise<number> {
  const send = options.fetch ?? fetch
  const payload = JSON.stringify(options.redactor.redactValue(message))
  let delivered = 0
  for (const subscription of listPushSubscriptions(db)) {
    try {
      const request = webpush.generateRequestDetails(subscription as PushSubscriptionRecord, payload, {
        vapidDetails: {
          subject: 'mailto:joy@localhost',
          publicKey: keys.publicKey,
          privateKey: keys.privateKey,
        },
        TTL: 60 * 60,
        contentEncoding: 'aes128gcm',
      })
      const response = await send(request.endpoint, {
        method: request.method,
        headers: request.headers as Record<string, string>,
        body: request.body ? new Uint8Array(request.body) : null,
        signal: AbortSignal.timeout(15_000),
      })
      if (response.status === 404 || response.status === 410)
        deletePushSubscription(db, subscription.endpoint)
      else if (response.ok) delivered++
      else options.warn?.(`push service answered ${response.status}`)
    } catch (error) {
      options.warn?.(
        `could not send a notification: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  return delivered
}
