import { expect, test } from '@playwright/test'

test('local dev serves an install-ready manifest without registering a cached dev worker', async ({
  page,
}) => {
  await page.goto('/')

  const manifestLink = page.locator('link[rel="manifest"]')
  await expect(manifestLink).toHaveAttribute('href', '/manifest.webmanifest')
  const manifestResponse = await page.request.get('/manifest.webmanifest')
  expect(manifestResponse.ok()).toBeTruthy()
  expect(await manifestResponse.json()).toMatchObject({
    display: 'standalone',
    name: 'Joy — local agent workspace',
    short_name: 'Joy',
    start_url: '/',
    scope: '/',
    icons: [
      { sizes: '192x192', type: 'image/png' },
      { sizes: '512x512', type: 'image/png' },
    ],
  })
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.getRegistrations().then((items) => items.length)))
    .toBe(0)
})
