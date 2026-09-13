import { expect, type Page } from '@playwright/test'

const inheritedEnvironment = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
)

export const packagedTestEnvironment: { [key: string]: string } = {
  ...inheritedEnvironment,
  AI_CANVAS_E2E: 'r2',
  AI_CANVAS_STARTUP: 'library'
}

export async function enterPackagedWorkspace(window: Page): Promise<void> {
  await expect(window.getByRole('heading', { name: '项目' })).toBeVisible({ timeout: 15_000 })
  await window.getByRole('button', { name: '空白画布', exact: true }).click()
  await expect(window.getByRole('button', { name: '画布', exact: true })).toHaveAttribute('aria-current', 'page', { timeout: 15_000 })
  await expect(window.getByTestId('canvas-stage')).toBeVisible()
}
