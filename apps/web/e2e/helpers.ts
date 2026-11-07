import type { Page } from '@playwright/test'

export type SettingsSection = '一般' | '模型' | '權限與自主' | '通知' | '專案' | '資料與備份' | '進階'

/** Opens 設定 from the sidebar, then one of its sections when given. */
export async function openSettings(page: Page, section?: SettingsSection): Promise<void> {
  await page.getByRole('button', { name: '設定', exact: true }).click()
  if (section) await openSettingsSection(page, section)
}

export async function openSettingsSection(page: Page, section: SettingsSection): Promise<void> {
  await page
    .getByRole('navigation', { name: '設定分類' })
    .getByRole('button', { name: section, exact: true })
    .click()
}
