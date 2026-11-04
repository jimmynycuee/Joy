import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { createServiceWorkerSource } from './pwa.js'

type WorkerEvent = { waitUntil(promise: Promise<unknown>): void }
type RequestEvent = {
  request: { url: string; method: string; mode: string }
  respondWith(promise: Promise<unknown>): void
}
type WorkerHandler = (event: WorkerEvent | RequestEvent) => void

describe('local PWA service worker', () => {
  it('precaches the app shell and serves cached navigation when offline', async () => {
    const appShell = ['/', '/manifest.webmanifest', '/assets/app.js']
    const source = createServiceWorkerSource(appShell, 'test-revision')
    const listeners = new Map<string, WorkerHandler>()
    const cached = new Map<string, { url: string }>()
    const cacheKey = (request: string | { url: string }) =>
      typeof request === 'string'
        ? new URL(request, 'http://joy.local').pathname
        : new URL(request.url).pathname
    const cache = {
      addAll: vi.fn(async (urls: string[]) => {
        for (const url of urls) cached.set(cacheKey(url), { url })
      }),
      match: vi.fn(async (request: string | { url: string }) => cached.get(cacheKey(request))),
    }
    const cacheStorage = {
      delete: vi.fn(async () => true),
      keys: vi.fn(async () => ['joy-app-shell-v0']),
      match: vi.fn(async (request: string | { url: string }) => cached.get(cacheKey(request))),
      open: vi.fn(async () => cache),
    }
    const self = {
      addEventListener: (type: string, handler: WorkerHandler) => listeners.set(type, handler),
      clients: { claim: vi.fn(async () => undefined) },
      location: { origin: 'http://joy.local' },
      skipWaiting: vi.fn(async () => undefined),
    }
    const networkFetch = vi.fn(async () => {
      throw new Error('offline')
    })

    runInNewContext(source, { caches: cacheStorage, fetch: networkFetch, Response, URL, self })

    let installPromise: Promise<unknown> | undefined
    listeners.get('install')?.({ waitUntil: (promise) => (installPromise = promise) })
    await installPromise
    expect(cache.addAll).toHaveBeenCalledWith(appShell)
    expect(self.skipWaiting).toHaveBeenCalledOnce()

    let navigationResponse: Promise<unknown> | undefined
    listeners.get('fetch')?.({
      request: { method: 'GET', mode: 'navigate', url: 'http://joy.local/' },
      respondWith: (promise) => (navigationResponse = promise),
    })
    await expect(navigationResponse).resolves.toEqual({ url: '/' })
    expect(networkFetch).toHaveBeenCalledOnce()
  })

  it('does not intercept local API or WebSocket requests', () => {
    const listeners = new Map<string, WorkerHandler>()
    const self = {
      addEventListener: (type: string, handler: WorkerHandler) => listeners.set(type, handler),
      clients: { claim: vi.fn() },
      location: { origin: 'http://joy.local' },
      skipWaiting: vi.fn(),
    }
    runInNewContext(createServiceWorkerSource(['/'], 'test-revision'), {
      caches: { match: vi.fn(), open: vi.fn(), keys: vi.fn(), delete: vi.fn() },
      fetch: vi.fn(),
      Response,
      URL,
      self,
    })

    for (const path of ['/api/tasks', '/ws?taskId=local']) {
      const respondWith = vi.fn()
      listeners.get('fetch')?.({
        request: { method: 'GET', mode: 'cors', url: `http://joy.local${path}` },
        respondWith,
      })
      expect(respondWith).not.toHaveBeenCalled()
    }
  })
})
