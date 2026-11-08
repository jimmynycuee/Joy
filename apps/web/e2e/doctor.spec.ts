import { expect, test } from '@playwright/test'

const doctor = {
  checkedAt: '2026-01-02T03:04:05.000Z',
  checks: [
    {
      id: 'node',
      label: 'Node.js',
      status: 'missing',
      version: '20.11.1',
      summary: 'Node.js 20.11.1 低於 Joy 要求的版本（22.13.0）。',
      repair: '升級到 Node.js 22.13.0 以上版本，然後重新啟動 Joy。',
    },
    {
      id: 'git',
      label: 'Git',
      status: 'ok',
      version: '2.48.1',
      summary: 'Git 2.48.1 可以使用。',
      repair: '不需要處理。',
    },
    {
      id: 'gh-auth',
      label: 'GitHub CLI 登入',
      status: 'untested',
      summary: '無法確認 GitHub CLI 是否已登入。',
      repair: '執行 `gh auth login --hostname github.com` 後再檢查一次；網路問題也可能讓這項無法判斷。',
    },
    {
      id: 'claude-cli',
      label: 'Claude Code CLI',
      status: 'missing',
      summary: 'Claude Code CLI 未安裝，或 PATH 上找不到。',
      repair: '安裝 Claude Code CLI，或在 Joy 的 provider 設定中指定它的執行檔路徑。',
    },
    {
      id: 'codex-cli',
      label: 'Codex CLI',
      status: 'untested',
      version: '0.104.0',
      summary: 'Codex CLI 0.104.0 尚未和 Joy 一起測試過，輸出格式可能已經改變。',
      repair: '安裝測試過的版本，或重新錄製 contract fixture 並更新 TESTED_CLI_VERSIONS。',
    },
    {
      id: 'keychain',
      label: '系統鑰匙圈',
      status: 'missing',
      summary: 'Joy 無法存取系統鑰匙圈。',
      repair: '啟動並解鎖 Secret Service（例如 GNOME Keyring 或 KWallet），然後再檢查一次。',
    },
    {
      id: 'data-directory',
      label: 'Joy 資料目錄',
      status: 'ok',
      summary: 'Joy 可以寫入它的資料目錄。',
      repair: '不需要處理。',
    },
  ],
}

test('settings show setup status and actionable repair guidance', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1400 })
  let requests = 0
  await page.route('**/api/doctor', async (route) => {
    requests++
    await route.fulfill({ json: { doctor } })
  })

  await page.goto('/')
  // The new-task page only flags that something needs fixing; the details live in Settings.
  await page.getByRole('button', { name: /有 3 項環境設定需要處理/ }).click()
  const panel = page.getByTestId('doctor-checks')
  await expect(panel.getByRole('heading', { name: '環境檢查' })).toBeVisible()
  await expect(panel).toContainText('Node.js')
  await expect(panel).toContainText('GitHub CLI 登入')
  await expect(panel).toContainText('Claude Code CLI')
  await expect(panel).toContainText('Codex CLI')
  await expect(panel).toContainText('系統鑰匙圈')
  await expect(panel).toContainText('Joy 資料目錄')
  const nodeCheck = panel.getByRole('listitem').filter({ hasText: 'Node.js' })
  await expect(nodeCheck.getByText('缺少', { exact: true })).toBeVisible()
  await expect(panel.getByText('正常', { exact: true })).toHaveCount(2)
  await expect(panel.getByText('缺少', { exact: true })).toHaveCount(3)
  await expect(panel).toContainText('升級到 Node.js 22.13.0 以上版本')
  // A check that needs nothing does not repeat the "nothing to do" line.
  await expect(panel).not.toContainText('不需要處理')
  await expect(panel.getByText('未驗證', { exact: true })).toHaveCount(2)
  await expect(panel).toContainText('gh auth login --hostname github.com')
  await expect(panel).toContainText('啟動並解鎖 Secret Service')
  await page.screenshot({ path: 'test-results/t1.13-doctor.png', fullPage: true })

  await page.getByRole('button', { name: '重新檢查環境' }).click()
  await expect.poll(() => requests).toBe(2)
})
