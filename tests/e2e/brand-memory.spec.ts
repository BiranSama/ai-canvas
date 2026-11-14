import { expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import type { DesktopApi } from '../../src/shared/desktop-api'
import { currentScene as scene, openCoffeePoster } from '../helpers/render-compare'
import { openEditor } from '../helpers/workbench-ui'

test('fills in the brand with a logo in settings, then offers it in the editor: logo, colours and fonts', async () => {
  test.setTimeout(120_000)
  const exportDirectory = await mkdtemp(join(tmpdir(), 'ai-canvas-brand-export-'))
  const { app, page, userData } = await openCoffeePoster(exportDirectory, 'ai-canvas-brand-')
  try {
    // 品牌与记忆: name, a colour, copy and banned words, saved together; the logo goes up on its own.
    await page.getByTestId('open-settings').evaluate((button) => button.click())
    await page.getByRole('button', { name: '品牌与记忆' }).evaluate((button) => button.click())
    const settings = page.getByTestId('brand-memory-settings')
    await expect(settings).toBeVisible()
    await settings.getByLabel('品牌名').fill('晨雾咖啡')
    await settings.getByRole('button', { name: /加一个颜色/ }).click()
    await settings.getByLabel('主色 1', { exact: true }).fill('#aa3300')
    await settings.getByLabel('常用文案').fill('每天新鲜烘焙')
    await settings.getByLabel('禁用词').fill('最、第一')
    await settings.getByRole('button', { name: /保存品牌/ }).click()
    await expect(page.getByTestId('provider-settings-status')).toContainText('品牌已保存')
    const logo = await sharp({ create: { width: 320, height: 80, channels: 4, background: { r: 30, g: 70, b: 140, alpha: 1 } } }).png().toBuffer()
    await settings.getByLabel('选择 Logo 文件').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: logo })
    await expect(settings.getByRole('img', { name: '品牌 Logo' })).toBeVisible()
    const saved = await page.evaluate(async () => (await (globalThis as unknown as { desktop: DesktopApi }).desktop.getUserMemory()).brand)
    expect(saved).toMatchObject({ name: '晨雾咖啡', colors: ['#aa3300'], copy: ['每天新鲜烘焙'], bannedWords: ['最', '第一'], logo: { width: 320, height: 80 } })
    // A brand font is picked the same way; set here through the bridge so the test does not depend on installed fonts.
    await page.evaluate(async () => {
      const desktop = (globalThis as unknown as { desktop: DesktopApi }).desktop
      const { brand } = await desktop.getUserMemory()
      await desktop.saveBrandKit({ name: brand.name, colors: [...brand.colors], titleFont: 'Brand Serif Test', bodyFont: '', copy: [...brand.copy], bannedWords: [...brand.bannedWords] })
    })
    await page.getByRole('button', { name: '关闭设置' }).evaluate((button) => button.click())

    // Every colour picker offers the brand colour first.
    await expect(page.locator('datalist#brand-colors option')).toHaveCount(1)
    await expect(page.locator('datalist#brand-colors option')).toHaveAttribute('value', '#aa3300')

    // 插入 Logo, from the layer panel's new menu: a layer named Logo, a fifth of the width, its shape kept.
    await openEditor(page)
    await page.getByRole('tab', { name: '图层' }).click()
    await page.getByRole('toolbar', { name: '图层操作' }).getByRole('button', { name: '新建调整图层' }).click()
    await page.getByRole('menu', { name: '新建调整图层' }).getByRole('menuitem', { name: '插入 Logo' }).click()
    await expect.poll(async () => (await scene(page)).elements.at(-1)?.name).toBe('Logo')
    const placed = (await scene(page)).elements.at(-1)!
    expect(placed.type).toBe('image')
    expect(placed.transform.width).toBeCloseTo(0.2, 3)
    await expect(page.getByLabel('前景色', { exact: true })).toHaveAttribute('list', 'brand-colors')

    // The brand's font comes first in the font list.
    const title = (await scene(page)).elements.find((element) => element.type === 'text')!
    await page.locator(`[data-layer-id="${title.id}"] .layer-copy`).click()
    await page.getByRole('tab', { name: /属性/ }).click()
    await page.getByRole('button', { name: '高级', exact: true }).click()
    await page.getByRole('button', { name: /^字体：/ }).click()
    const list = page.getByRole('dialog', { name: '选择字体' })
    await expect(list.locator('.font-picker-section').first()).toHaveText('品牌字体')
    await expect(list.getByRole('option').first()).toContainText('Brand Serif Test')
  } finally {
    await app.close()
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    await rm(exportDirectory, { recursive: true, force: true })
  }
})

test('turning 使用品牌 off for a project leaves its editor without the brand', async () => {
  test.setTimeout(90_000)
  const exportDirectory = await mkdtemp(join(tmpdir(), 'ai-canvas-brand-off-export-'))
  const { app, page, userData } = await openCoffeePoster(exportDirectory, 'ai-canvas-brand-off-')
  try {
    await page.evaluate(async () => {
      const desktop = (globalThis as unknown as { desktop: DesktopApi }).desktop
      await desktop.saveBrandKit({ name: '晨雾咖啡', colors: ['#aa3300'], titleFont: '', bodyFont: '', copy: [], bannedWords: [] })
    })
    await expect(page.locator('datalist#brand-colors option')).toHaveCount(1)
    await page.getByTestId('open-settings').evaluate((button) => button.click())
    await page.getByRole('button', { name: '项目记忆' }).evaluate((button) => button.click())
    await page.getByLabel('这个作品使用品牌').uncheck()
    await expect(page.getByTestId('provider-settings-status')).toContainText('不再参考品牌')
    await page.getByRole('button', { name: '关闭设置' }).evaluate((button) => button.click())
    await expect(page.locator('datalist#brand-colors option')).toHaveCount(0)
  } finally {
    await app.close()
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    await rm(exportDirectory, { recursive: true, force: true })
  }
})
