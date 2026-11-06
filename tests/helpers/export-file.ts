import { expect, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import sharp from 'sharp'

/*
 * Exports through the real 导出 panel and reads back the file Main wrote.
 * End-to-end runs never show a save dialog: Main saves into a folder of
 * the run, and the panel says where.
 */

export type ExportedKind = 'image' | 'psd' | 'pdf'

async function press(locator: ReturnType<Page['locator']>): Promise<void> {
  // Glass panels can sit over the header; a click from the page itself does not depend on hit testing.
  await locator.evaluate((element: { click(): void }) => element.click())
}

/** Opens the panel, chooses what to export, exports and closes it again; the saved file's path. */
export async function exportThroughPanel(page: Page, choose: { readonly kind: ExportedKind; readonly format?: 'PNG' | 'JPEG' | 'WebP'; readonly scale?: 1 | 2 | 3 } = { kind: 'image' }): Promise<string> {
  await press(page.locator('.export-control > button'))
  const sheet = page.getByRole('dialog', { name: '导出' })
  await expect(sheet).toBeVisible()
  await press(sheet.getByRole('button', { name: choose.kind === 'image' ? /^图片/ : choose.kind === 'psd' ? /^PSD/ : /^PDF/ }))
  if (choose.kind === 'image') {
    await press(sheet.getByRole('radio', { name: choose.format ?? 'PNG', exact: true }))
    await press(sheet.getByRole('radio', { name: new RegExp(`^${choose.scale ?? 1}×`) }))
  }
  await press(sheet.getByRole('button', { name: '导出', exact: true }))
  const saved = sheet.locator('[data-saved-path]')
  await expect(saved).toBeVisible({ timeout: 60_000 })
  const path = await saved.getAttribute('data-saved-path')
  await press(sheet.getByRole('button', { name: '关闭导出' }))
  await expect(sheet).toHaveCount(0)
  if (path === null) throw new Error('The export panel did not say where it saved.')
  return path
}

/** The picture as exported to PNG at 1×, as pixels. */
export async function exportedPixels(page: Page): Promise<{ readonly data: Buffer; readonly width: number; readonly height: number }> {
  const path = await exportThroughPanel(page)
  const { data, info } = await sharp(await readFile(path)).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  return { data, width: info.width, height: info.height }
}
