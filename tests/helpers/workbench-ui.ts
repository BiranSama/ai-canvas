import { expect, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { writeFile } from 'node:fs/promises'

/** Follow the current disclosure flow before interacting with request options. */
export async function openGenerationOptions(page: Page) {
  const parameters = page.locator('.generation-compact-summary')
  if (await parameters.count() && await parameters.getAttribute('aria-expanded') === 'false') await parameters.click()
  const options = page.locator('details.generation-options')
  await expect(options).toBeVisible()
  if (await options.getAttribute('open') === null) await options.locator('summary').click()
  await expect(options).toHaveAttribute('open', '')
}

export async function openConversationRecord(page: Page) {
  const toggle = page.getByRole('button', { name: '创作记录', exact: true })
  if (await toggle.isVisible()) await toggle.click()
  await expect(page.getByLabel('对话输入', { exact: true })).toBeVisible()
}

export async function openDirectionReview(page: Page) {
  await openConversationRecord(page)
  const disclosure = page.locator('details.design-review-record').last()
  await expect(disclosure).toBeAttached()
  if (await disclosure.getAttribute('open') === null) await disclosure.locator(':scope > summary').click()
}

/** Real hit geometry: scroll inside instruments, never accept an off-window target. */
export async function hitWorkbenchControl(target: Locator) {
  await target.scrollIntoViewIfNeeded()
  const bounds = await target.boundingBox()
  expect(bounds).not.toBeNull()
  const name = await target.getAttribute('aria-label') ?? await target.textContent()
  expect(bounds!.height, `${name} height`).toBeGreaterThanOrEqual(39.5)
  expect(bounds!.width, `${name} width`).toBeGreaterThanOrEqual(39.5)
  const viewport = await target.evaluate((node) => ({ width: node.ownerDocument.defaultView!.innerWidth, height: node.ownerDocument.defaultView!.innerHeight }))
  expect(bounds!.x, `${name} left`).toBeGreaterThanOrEqual(-1)
  expect(bounds!.y, `${name} top`).toBeGreaterThanOrEqual(-1)
  expect(bounds!.x + bounds!.width, `${name} right`).toBeLessThanOrEqual(viewport.width + 1)
  expect(bounds!.y + bounds!.height, `${name} bottom`).toBeLessThanOrEqual(viewport.height + 1)
  await expect.poll(() => target.evaluate((node) => {
    const rect = node.getBoundingClientRect()
    const top = node.ownerDocument.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
    return node.contains(top) ? true : `${node.getAttribute('aria-label') || node.textContent} blocked by ${top?.outerHTML.slice(0, 400)}`
  })).toBe(true)
  await target.click()
}

export async function captureWorkbench(app: ElectronApplication, path: string) {
  const snapshot = await app.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]!
    await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    const image = await window.webContents.capturePage()
    return { png: image.toPNG().toString('base64'), imageSize: image.getSize(), contentSize: window.getContentSize(), zoom: window.webContents.getZoomFactor() }
  })
  await writeFile(path, Buffer.from(snapshot.png, 'base64'))
  return { imageSize: snapshot.imageSize, contentSize: snapshot.contentSize, zoom: snapshot.zoom }
}
