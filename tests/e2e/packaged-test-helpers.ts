import { expect, type Page } from '@playwright/test'
import { openEditor } from '../helpers/workbench-ui'

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
  // A new project opens on 对话; these packaged checks work in the editor.
  await expect(window.getByRole('navigation', { name: '工作视图' }).getByRole('button', { name: '对话', exact: true })).toHaveAttribute('aria-current', 'page', { timeout: 15_000 })
  await openEditor(window)
  await expect(window.getByTestId('canvas-stage')).toBeVisible()
}
