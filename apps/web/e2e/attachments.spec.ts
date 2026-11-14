import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

// A real 1×1 PNG, so thumbnails actually load.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
const repo = { id: 'attach-repo', path: '/tmp/attach-project', defaultBranch: 'main' }
const config = { autonomy_mode: 'normal', roles: {} }

function taskOf(status: string) {
  return {
    id: 'attach-task',
    repoId: repo.id,
    title: 'Fix the header',
    prompt: 'The header overlaps the menu.',
    mode: 'single',
    status,
    createdAt: new Date(Date.now() - 60_000).toISOString(),
  }
}

interface Calls {
  uploads: Array<{ name: string; size: number }>
  deletes: string[]
  taskBodies: Array<Record<string, unknown>>
  messageBodies: Array<Record<string, unknown>>
}

async function mockApi(
  page: Page,
  options: { failNames?: string[]; details?: Record<string, unknown> } = {},
): Promise<Calls> {
  const calls: Calls = { uploads: [], deletes: [], taskBodies: [], messageBodies: [] }
  let next = 0
  const task = taskOf('done')
  // Live updates are not needed here; answering the socket in the page keeps the dev server's proxy idle.
  await page.routeWebSocket(/\/ws/, () => {})
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    const method = request.method()
    if (path === '/api/attachments' && method === 'POST') {
      const name = decodeURIComponent(request.headers()['x-joy-filename'] ?? '')
      const size = request.postDataBuffer()?.byteLength ?? 0
      calls.uploads.push({ name, size })
      if (options.failNames?.includes(name)) {
        await route.fulfill({ status: 415, json: { error: 'Only images and text files can be attached' } })
        return
      }
      const mediaType = name.endsWith('.png') || name === '' ? 'image/png' : 'text/plain'
      await route.fulfill({
        status: 201,
        json: { attachment: { id: `att-${++next}`, name: name || 'image.png', mediaType, size } },
      })
    } else if (path.startsWith('/api/attachments/') && method === 'DELETE') {
      calls.deletes.push(path.slice('/api/attachments/'.length))
      await route.fulfill({ json: { ok: true } })
    } else if (path.startsWith('/api/attachments/')) {
      await route.fulfill({ status: 200, contentType: 'image/png', body: PNG })
    } else if (path === '/api/tasks' && method === 'POST') {
      calls.taskBodies.push(request.postDataJSON() as Record<string, unknown>)
      await route.fulfill({ status: 201, json: { task: taskOf('queued') } })
    } else if (path === `/api/tasks/${task.id}/messages` && method === 'POST') {
      calls.messageBodies.push(request.postDataJSON() as Record<string, unknown>)
      await route.fulfill({ status: 202, json: { task, message: { id: 'm9', delivery: 'follow_up' } } })
    } else if (path === '/api/repos') {
      await route.fulfill({ json: { repos: [repo] } })
    } else if (path === '/api/tasks') {
      await route.fulfill({ json: { tasks: options.details ? [task] : [] } })
    } else if (path === '/api/config') {
      await route.fulfill({ json: { config } })
    } else if (path === `/api/tasks/${task.id}`) {
      await route.fulfill({
        json: options.details ?? { task, repo, attempts: [], reviews: [], events: [], attachments: [] },
      })
    } else {
      await route.fulfill({ json: {} })
    }
  })
  return calls
}

/** Pastes files the way a browser does for ⌘V of a screenshot. */
async function pasteImage(page: Page, name: string) {
  await page.getByLabel('任務內容').evaluate(
    (element, args) => {
      const bytes = Uint8Array.from(atob(args.base64), (c) => c.charCodeAt(0))
      const data = new DataTransfer()
      data.items.add(new File([bytes], args.name, { type: 'image/png' }))
      element.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
      )
    },
    { base64: PNG.toString('base64'), name },
  )
}

test('attaches by picking, pasting and dropping, removes one, and sends the rest with the task', async ({
  page,
}) => {
  const calls = await mockApi(page)
  await page.goto('/')
  const composer = page.locator('form.composer')
  await expect(composer.getByRole('button', { name: '附加檔案' })).toBeVisible()

  // Pick: an image and a code file.
  await page.getByTestId('attachment-input').setInputFiles([
    { name: 'header.png', mimeType: 'image/png', buffer: PNG },
    { name: 'header.css', mimeType: 'text/css', buffer: Buffer.from('h1 { margin: 0 }') },
  ])
  const tray = page.getByTestId('attachment-tray')
  await expect(tray.locator('li')).toHaveCount(2)
  await expect(tray.locator('img[alt="header.png"]')).toBeVisible()
  await expect(tray.locator('li', { hasText: 'header.css' })).toContainText('16 B')

  // Paste a screenshot.
  await pasteImage(page, 'pasted.png')
  await expect(tray.locator('li')).toHaveCount(3)

  // Drop a file on the box.
  await composer.evaluate((form) => {
    const data = new DataTransfer()
    data.items.add(new File(['notes'], 'notes.md', { type: 'text/markdown' }))
    form.dispatchEvent(new DragEvent('dragover', { dataTransfer: data, bubbles: true, cancelable: true }))
    form.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }))
  })
  await expect(tray.locator('li')).toHaveCount(4)
  await expect(tray.locator('li[data-status="ready"]')).toHaveCount(4)
  expect(calls.uploads.map((upload) => upload.name)).toEqual([
    'header.png',
    'header.css',
    'pasted.png',
    'notes.md',
  ])

  // Remove the CSS file: it is freed on the server and not sent.
  await tray.getByRole('button', { name: '移除 header.css' }).click()
  await expect(tray.locator('li')).toHaveCount(3)
  expect(calls.deletes).toEqual(['att-2'])

  await page.getByLabel('任務內容').fill('Fix the header')
  await composer.getByRole('button', { name: '開始任務' }).click()
  await expect.poll(() => calls.taskBodies.length).toBe(1)
  expect(calls.taskBodies[0]).toMatchObject({
    prompt: 'Fix the header',
    attachments: ['att-1', 'att-3', 'att-4'],
  })
})

test('a failed upload shows an alert icon and blocks sending until it is removed', async ({ page }) => {
  const calls = await mockApi(page, { failNames: ['tool.bin'] })
  await page.goto('/')
  await page.getByLabel('任務內容').fill('Look')
  await page
    .getByTestId('attachment-input')
    .setInputFiles([
      { name: 'tool.bin', mimeType: 'application/octet-stream', buffer: Buffer.from([0, 1, 2]) },
    ])
  const chip = page.getByTestId('attachment-tray').locator('li')
  await expect(chip).toHaveAttribute('data-status', 'error')
  await expect(chip.getByRole('img', { name: 'Only images and text files can be attached' })).toBeVisible()
  const send = page.getByRole('button', { name: '開始任務' })
  await expect(send).toBeDisabled()
  await chip.getByRole('button', { name: '移除 tool.bin' }).click()
  await expect(send).toBeEnabled()
  await send.click()
  await expect.poll(() => calls.taskBodies.length).toBe(1)
  expect(calls.taskBodies[0]?.attachments).toBeUndefined()
})

test('an unsent draft keeps its uploaded files across a reload', async ({ page }) => {
  await mockApi(page)
  await page.goto('/')
  await page
    .getByTestId('attachment-input')
    .setInputFiles([{ name: 'keep.png', mimeType: 'image/png', buffer: PNG }])
  await expect(page.getByTestId('attachment-tray').locator('li[data-status="ready"]')).toHaveCount(1)
  await page.reload()
  const restored = page.getByTestId('attachment-tray').locator('li')
  await expect(restored).toHaveCount(1)
  // The thumbnail now comes from the server.
  await expect(restored.locator('img[alt="keep.png"]')).toBeVisible()
})

test('the thread shows files on messages, enlarges images, and sends an image-only message', async ({
  page,
}) => {
  const task = taskOf('done')
  const details = {
    task,
    repo,
    attempts: [],
    reviews: [],
    attachments: [
      { id: 'first-shot', name: 'before.png', mediaType: 'image/png', size: PNG.byteLength },
      { id: 'later-log', name: 'error.log', mediaType: 'text/plain', size: 2048, messageId: 'm1' },
    ],
    events: [
      {
        taskId: task.id,
        seq: 1,
        type: 'started',
        payload: {},
        ts: new Date(Date.now() - 50_000).toISOString(),
      },
      {
        taskId: task.id,
        seq: 2,
        type: 'user.message',
        payload: {
          id: 'm1',
          text: 'Here is the log',
          delivery: 'follow_up',
          attachments: [{ id: 'later-log', name: 'error.log', mediaType: 'text/plain', size: 2048 }],
        },
        ts: new Date(Date.now() - 40_000).toISOString(),
      },
    ],
  }
  const calls = await mockApi(page, { details })
  await page.goto(`/?task=${task.id}`)
  await expect(page.getByRole('heading', { name: task.title })).toBeVisible()

  const files = page.getByTestId('message-attachments')
  await expect(files).toHaveCount(2)
  await expect(files.nth(1).getByRole('button', { name: /error\.log/ })).toContainText('2.0 KB')

  await files.first().getByRole('button', { name: '放大 before.png' }).click()
  const lightbox = page.getByRole('dialog', { name: 'before.png' })
  await expect(lightbox.locator('img')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(lightbox).toBeHidden()

  await page
    .getByTestId('attachment-input')
    .setInputFiles([{ name: 'after.png', mimeType: 'image/png', buffer: PNG }])
  await expect(page.getByTestId('attachment-tray').locator('li[data-status="ready"]')).toHaveCount(1)
  await page.getByRole('button', { name: '送出' }).click()
  await expect.poll(() => calls.messageBodies.length).toBe(1)
  expect(calls.messageBodies[0]).toEqual({ text: '', attachments: ['att-1'] })
  await expect(page.getByTestId('attachment-tray')).toHaveCount(0)
})
