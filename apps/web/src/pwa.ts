export function createServiceWorkerSource(precacheUrls: readonly string[], revision: string): string {
  const appShell = JSON.stringify([...new Set(precacheUrls)])

  return `const CACHE_PREFIX = 'joy-app-shell-'
const CACHE_NAME = 'joy-app-shell-${revision}'
const APP_SHELL = ${appShell}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME)
    await cache.addAll(APP_SHELL)
    await self.skipWaiting()
  })())
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const cacheNames = await caches.keys()
    await Promise.all(cacheNames
      .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
      .map((name) => caches.delete(name)))
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  const url = new URL(request.url)
  if (request.method !== 'GET' || url.origin !== self.location.origin) return
  if (url.pathname === '/api' || url.pathname.startsWith('/api/') || url.pathname === '/ws') return

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(async () => (await caches.match('/')) ?? Response.error()))
    return
  }

  if (!APP_SHELL.includes(url.pathname)) return
  event.respondWith((async () => (await caches.match(request)) ?? fetch(request))())
})
`
}
