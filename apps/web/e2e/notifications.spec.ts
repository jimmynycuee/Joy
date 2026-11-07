import { expect, test } from '@playwright/test'

const config = {
  autonomy_mode: 'normal',
  roles: Object.fromEntries(
    ['assistant_brain', 'background', 'orchestrator', 'implementer', 'reviewer', 'judge'].map((role) => [
      role,
      { provider: 'claude-cli', model: 'push-test-model', effort: 'low' },
    ]),
  ),
}

test('Joy is installable, its service worker shows pushed notifications, and a device can subscribe', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['notifications'])
  // Headless Chromium has no push service; stand in for the browser's subscribe call only.
  await page.addInitScript(() => {
    PushManager.prototype.subscribe = async function () {
      return {
        endpoint: 'https://push.example.test/send/device-1',
        toJSON: () => ({
          endpoint: 'https://push.example.test/send/device-1',
          keys: { p256dh: 'BPfake', auth: 'fake-auth' },
        }),
        unsubscribe: async () => true,
      } as unknown as PushSubscription
    }
  })
  const subscriptions: unknown[] = []
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path === '/api/push/key') {
      await route.fulfill({
        json: {
          publicKey:
            'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U',
        },
      })
    } else if (path === '/api/push/subscriptions') {
      subscriptions.push(request.postDataJSON())
      await route.fulfill({ status: 201, json: { subscribed: true } })
    } else if (path === '/api/config') {
      await route.fulfill({ json: { config } })
    } else if (path === '/api/secrets/openai-api-key') {
      await route.fulfill({ json: { set: false } })
    } else if (path === '/api/repos') {
      await route.fulfill({ json: { repos: [] } })
    } else if (path === '/api/tasks') {
      await route.fulfill({ json: { tasks: [] } })
    } else {
      await route.fulfill({ json: {} })
    }
  })

  await page.goto('/')
  const manifest = await page.evaluate(async () =>
    (await fetch(document.querySelector<HTMLLinkElement>('link[rel=manifest]')?.href ?? '')).json(),
  )
  expect(manifest).toMatchObject({ name: 'Joy', display: 'standalone' })
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope)
  expect(scope).toMatch(/\/$/)

  // Some headless Chromium builds cannot display notifications at all; probe before relying on it.
  const canShow = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready
    await registration.showNotification('probe', { tag: 'probe' }).catch(() => undefined)
    const shown = (await registration.getNotifications({ tag: 'probe' })).length > 0
    for (const notification of await registration.getNotifications()) notification.close()
    return shown
  })
  if (canShow) {
    // A real push event through the DevTools protocol: the service worker turns it into a notification.
    const cdp = await context.newCDPSession(page)
    await cdp.send('ServiceWorker.enable')
    const registrationId = await new Promise<string>((resolve) => {
      cdp.on(
        'ServiceWorker.workerRegistrationUpdated',
        (event: { registrations: Array<{ registrationId: string }> }) => {
          const first = event.registrations[0]
          if (first) resolve(first.registrationId)
        },
      )
    })
    await cdp.send('ServiceWorker.deliverPushMessage', {
      origin: new URL(page.url()).origin,
      registrationId,
      data: JSON.stringify({ title: '✅ Fix add()', body: 'Finished.', url: '/?task=t1' }),
    })
    await expect
      .poll(() =>
        page.evaluate(async () =>
          (await (await navigator.serviceWorker.ready).getNotifications()).map((n) => `${n.title}|${n.body}`),
        ),
      )
      .toEqual(['✅ Fix add()|Finished.'])
  } else {
    test
      .info()
      .annotations.push({ type: 'skip-part', description: 'this browser cannot display notifications' })
  }

  await page.getByRole('button', { name: '設定' }).click()
  const panel = page.getByTestId('notifications-panel')
  await panel.getByRole('button', { name: 'Turn on notifications' }).click()
  await expect(panel).toContainText('On for this device.')
  expect(subscriptions).toEqual([
    { endpoint: 'https://push.example.test/send/device-1', keys: { p256dh: 'BPfake', auth: 'fake-auth' } },
  ])
})
