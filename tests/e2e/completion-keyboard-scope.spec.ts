import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { DesktopApi } from '../../src/shared/desktop-api'

let app: ElectronApplication
let page: Page
test.beforeEach(async () => {
  const userData = await mkdtemp(join(tmpdir(), 'keyboard-'))
  app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], cwd: resolve('.'), env: { ...process.env, AI_CANVAS_E2E: 'r2', AI_CANVAS_STARTUP: 'library' } })
  await app.evaluate(() => {
    const scope = globalThis as typeof globalThis & { __keyboardNetwork: number }
    scope.__keyboardNetwork = 0
    scope.fetch = async () => { scope.__keyboardNetwork++; throw new Error('OFFLINE_KEYBOARD_NETWORK_BLOCKED') }
  })
  page = await app.firstWindow()
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.locator('.new-project-main').click()
  await page.getByRole('button', { name: '画布', exact: true }).click()
  await expect(page.getByTestId('canvas-stage')).toBeVisible()
  await page.getByRole('button', { name: '形状', exact: true }).click()
  await expect.poll(async () => (await mainScene()).elements.length).toBe(1)
})
test.afterEach(async () => {
  const attempts = await app.evaluate(() => (globalThis as typeof globalThis & { __keyboardNetwork: number }).__keyboardNetwork)
  expect(attempts).toBe(0)
  await app.close()
})
async function mainScene() {
  return page.evaluate(async () => (await (globalThis as unknown as { desktop: DesktopApi }).desktop.getWorkspaceBootstrap()).scene)
}

test('settings isolate every background canvas command and return focus on Escape', async () => {
  const before = await mainScene()
  await page.getByTestId('open-settings').click()
  const dialog = page.getByRole('dialog', { name: '供应商设置' })
  await expect(dialog.getByRole('button', { name: '关闭供应商设置' })).toBeFocused()
  await dialog.getByRole('button', { name: '外观', exact: true }).click()
  for (const key of ['Delete', 'Backspace', 'Control+x', 'Control+v', 'Control+z', 'Control+y', 'ArrowLeft', 't', 'b']) {
    await page.keyboard.press(key)
    expect(await mainScene(), `Main Scene changed on ${key} inside settings`).toEqual(before)
  }
  for (let i = 0; i < 35; i++) {
    await page.keyboard.press(i < 18 ? 'Tab' : 'Shift+Tab')
    expect(await dialog.evaluate((element) => element.contains(element.ownerDocument.activeElement))).toBe(true)
  }
  const optical = dialog.locator('summary', { hasText: '光学与动态' })
  await dialog.getByRole('button', { name: '关闭供应商设置' }).focus()
  for (let i = 0; i < 50 && !await optical.evaluate((element) => element === element.ownerDocument.activeElement); i++) await page.keyboard.press('Tab')
  await expect(optical).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(dialog.getByLabel('光学质量')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(page.getByTestId('open-settings')).toBeFocused()
  expect(await mainScene()).toEqual(before)
  await page.getByTestId('canvas-stage').focus()
  await page.keyboard.press('Delete')
  await expect.poll(async () => (await mainScene()).elements.length).toBe(0)
  await writeFile(test.info().outputPath('keyboard-main-facts.json'), JSON.stringify({ before, after: await mainScene(), network: 0 }, null, 2))
})

test('nested context and project delete dialogs close one layer and restore a reachable trigger', async () => {
  await page.getByRole('button', { name: '对话', exact: true }).click()
  await page.setViewportSize({ width: 850, height: 700 })
  await page.getByRole('button', { name: '创作记录', exact: true }).click()
  await page.getByRole('button', { name: '本轮上下文', exact: true }).click()
  const context = page.getByRole('dialog', { name: '本轮上下文' })
  await expect(context.getByRole('button', { name: '关闭本轮上下文' })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(context.getByRole('button', { name: '关闭本轮上下文' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(context).toHaveCount(0)
  await expect(page.getByRole('button', { name: '本轮上下文', exact: true })).toBeFocused()
  await expect(page.locator('.conversation-workspace')).toHaveClass(/is-record-open/)
  await page.keyboard.press('Escape')
  await expect(page.locator('.conversation-workspace')).not.toHaveClass(/is-record-open/)
  await page.getByRole('button', { name: '返回项目库', exact: true }).click()
  const more = page.getByRole('button', { name: '更多项目操作：未命名创作', exact: true })
  await more.click()
  await page.getByRole('menuitem', { name: '删除项目…', exact: true }).click()
  const confirmation = page.getByRole('alertdialog')
  await expect(confirmation.getByRole('button', { name: '取消', exact: true })).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(confirmation.getByRole('button', { name: '移到回收站', exact: true })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(confirmation.getByRole('button', { name: '取消', exact: true })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(confirmation).toHaveCount(0)
  await expect(more).toBeFocused()
})

test('Tab navigates controls and island keyboard movement never nudges the selected Scene object', async () => {
  const before = await mainScene()
  const select = page.getByRole('button', { name: '选择 V', exact: true })
  await select.focus()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('button', { name: '抓手 H', exact: true })).toBeFocused()
  await expect(page.locator('.canvas-workspace')).not.toHaveClass(/is-focus-mode/)
  await page.keyboard.press('Shift+Tab')
  await expect(select).toBeFocused()
  const grip = page.getByRole('toolbar', { name: '画布工具布局控制', exact: true })
  await grip.focus()
  await page.keyboard.press('ArrowRight')
  expect(await mainScene()).toEqual(before)
  await page.keyboard.press('Alt+ArrowUp')
  await expect(page.locator('[data-island-id="tools"]')).toHaveAttribute('data-island-mode', 'docked-top')
  expect(await mainScene()).toEqual(before)
  const focus = page.getByRole('button', { name: '进入专注', exact: true })
  await focus.focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('[data-island-id="tools"]')).toBeHidden()
  await page.keyboard.press('Space')
  await expect(page.locator('[data-island-id="tools"]')).toBeVisible()
  expect(await mainScene()).toEqual(before)
})

test('resize handles keep editing keys inside the control rather than deleting or panning the Scene', async () => {
  const before = await mainScene()
  const handle = page.getByRole('separator', { name: '调整画布工具大小', exact: true })
  await handle.focus()
  for (const key of ['Delete', 'Backspace', 't', 'b', 'h', 'v', 'Space', 'Control+Backspace']) {
    await page.keyboard.press(key)
    expect(await mainScene(), `Resize handle leaked ${key}`).toEqual(before)
    await expect(page.getByTestId('canvas-stage')).not.toHaveClass(/is-pan-ready/)
  }
})
