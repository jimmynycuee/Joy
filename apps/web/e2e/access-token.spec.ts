import { expect, test } from '@playwright/test'

const config = {
  autonomy_mode: 'normal',
  roles: Object.fromEntries(
    ['assistant_brain', 'background', 'orchestrator', 'implementer', 'reviewer', 'judge'].map((role) => [
      role,
      { provider: 'claude-cli', model: 'token-test-model', effort: 'low' },
    ]),
  ),
}

test('a refused token asks for a new one, and regenerating switches this device to the new token', async ({
  page,
}) => {
  let accepted = 'remote-device-token-abcdefghijkl'
  const seen: string[] = []
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    const auth = request.headers()['authorization'] ?? ''
    seen.push(auth)
    if (auth !== `Bearer ${accepted}`) {
      await route.fulfill({
        status: 401,
        json: { error: 'Authentication required: send the Joy access token' },
      })
    } else if (path === '/api/token/rotate') {
      accepted = 'rotated-token-0123456789abcdef'
      await route.fulfill({ json: { token: accepted } })
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
  const gate = page.getByTestId('token-gate')
  await expect(gate).toBeVisible()
  await gate.getByLabel('Access token').fill('remote-device-token-abcdefghijkl')
  await gate.getByRole('button', { name: 'Continue' }).click()
  await expect(gate).toHaveCount(0)

  await page.getByRole('button', { name: '設定' }).click()
  page.on('dialog', (dialog) => void dialog.accept())
  const panel = page.getByTestId('access-token-panel')
  await panel.getByRole('button', { name: 'Regenerate token' }).click()
  await expect(panel.getByTestId('new-token')).toHaveText('rotated-token-0123456789abcdef')
  // Later requests from this device use the new token.
  await page.getByRole('button', { name: '新任務' }).click()
  await expect.poll(() => seen.at(-1)).toBe('Bearer rotated-token-0123456789abcdef')
})
