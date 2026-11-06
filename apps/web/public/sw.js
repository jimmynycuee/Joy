// Joy's service worker (T4.2): shows Web Push notifications and opens the task they are about. It caches nothing:
// Joy is useless offline, and a stale UI talking to a newer server is worse than no UI.
self.addEventListener('push', (event) => {
  let message = { title: 'Joy', body: '', url: '/' }
  try {
    message = { ...message, ...event.data.json() }
  } catch {
    message.body = event.data ? event.data.text() : ''
  }
  event.waitUntil(
    self.registration.showNotification(message.title, {
      body: message.body,
      icon: '/icon.svg',
      data: { url: message.url },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = (event.notification.data && event.notification.data.url) || '/'
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      for (const client of windows) {
        if ('focus' in client) {
          client.postMessage({ type: 'joy-open', url })
          return client.focus()
        }
      }
      return self.clients.openWindow(url)
    }),
  )
})
