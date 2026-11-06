import type { Database } from './database.js'

export interface PushSubscriptionRecord {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

export function savePushSubscription(db: Database, subscription: PushSubscriptionRecord): void {
  db.prepare(
    `INSERT INTO push_subscriptions (endpoint, p256dh, auth) VALUES (?, ?, ?)
     ON CONFLICT (endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth`,
  ).run(subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth)
}

export function listPushSubscriptions(db: Database): PushSubscriptionRecord[] {
  return (
    db
      .prepare('SELECT endpoint, p256dh, auth FROM push_subscriptions ORDER BY created_at')
      .all() as unknown as Array<{
      endpoint: string
      p256dh: string
      auth: string
    }>
  ).map((row) => ({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }))
}

export function deletePushSubscription(db: Database, endpoint: string): boolean {
  return Number(db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint).changes) === 1
}
