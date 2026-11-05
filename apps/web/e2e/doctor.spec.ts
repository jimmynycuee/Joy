import { expect, test } from '@playwright/test'

const doctor = {
  checkedAt: '2026-01-02T03:04:05.000Z',
  checks: [
    {
      id: 'node',
      label: 'Node.js',
      status: 'missing',
      version: '20.11.1',
      summary: 'Node.js 20.11.1 is below Joy’s declared runtime requirement (22.13.0).',
      repair: 'Upgrade to Node.js 22.13.0 or later, then restart Joy.',
    },
    {
      id: 'git',
      label: 'Git',
      status: 'ok',
      version: '2.48.1',
      summary: 'Git 2.48.1 is available.',
      repair: 'No action needed.',
    },
    {
      id: 'gh-auth',
      label: 'GitHub CLI sign-in',
      status: 'untested',
      summary: 'GitHub CLI authentication could not be confirmed.',
      repair: 'Run `gh auth login --hostname github.com`, then check again.',
    },
    {
      id: 'claude-cli',
      label: 'Claude Code CLI',
      status: 'missing',
      summary: 'Claude Code CLI is not installed or not available on PATH.',
      repair: 'Install Claude Code CLI or set its executable path in Joy’s provider settings.',
    },
    {
      id: 'codex-cli',
      label: 'Codex CLI',
      status: 'untested',
      version: '0.104.0',
      summary: 'Codex CLI 0.104.0 is installed; Joy has not validated compatibility with this version.',
      repair: 'No installation repair is needed; CLI version compatibility remains untested.',
    },
    {
      id: 'keychain',
      label: 'OS keychain',
      status: 'missing',
      summary: 'The OS keychain could not be accessed by Joy.',
      repair: 'Start and unlock a Secret Service such as GNOME Keyring or KWallet, then run the check again.',
    },
    {
      id: 'data-directory',
      label: 'Joy data directory',
      status: 'ok',
      summary: 'Joy can write to its data directory.',
      repair: 'No action needed.',
    },
  ],
}

test('homepage shows setup status and actionable repair guidance', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1400 })
  let requests = 0
  await page.route('**/api/doctor', async (route) => {
    requests++
    await route.fulfill({ json: { doctor } })
  })

  await page.goto('/')
  const panel = page.getByTestId('doctor-checks')
  await expect(panel.getByRole('heading', { name: 'Environment checks' })).toBeVisible()
  await expect(panel).toContainText('Node.js')
  await expect(panel).toContainText('GitHub CLI sign-in')
  await expect(panel).toContainText('Claude Code CLI')
  await expect(panel).toContainText('Codex CLI')
  await expect(panel).toContainText('OS keychain')
  await expect(panel).toContainText('Joy data directory')
  const nodeCheck = panel.getByRole('listitem').filter({ hasText: 'Node.js' })
  await expect(nodeCheck.getByText('Missing', { exact: true })).toBeVisible()
  await expect(panel.getByText('OK', { exact: true })).toHaveCount(2)
  await expect(panel.getByText('Missing', { exact: true })).toHaveCount(3)
  await expect(panel).toContainText('Upgrade to Node.js 22.13.0 or later')
  await expect(panel.getByText('Untested', { exact: true })).toHaveCount(2)
  await expect(panel).toContainText('gh auth login --hostname github.com')
  await expect(panel).toContainText('Start and unlock a Secret Service')
  await page.screenshot({ path: 'test-results/t1.13-doctor.png', fullPage: true })

  await page.getByRole('button', { name: 'Refresh environment checks' }).click()
  await expect.poll(() => requests).toBe(2)
})
