import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { enterPackagedWorkspace, packagedTestEnvironment } from './packaged-test-helpers'

const executablePath = process.env.AI_CANVAS_PACKAGED_PATH

test('keeps settings, artwork export and project restart working in the packaged Windows app', async () => {
  test.setTimeout(60_000)
  test.skip(executablePath === undefined, 'Set AI_CANVAS_PACKAGED_PATH after package:win:dir')
  if (executablePath === undefined) return

  const userData = await mkdtemp(join(tmpdir(), 'ai-canvas-packaged-product-flow-'))
  const launch = (): Promise<ElectronApplication> => electron.launch({
    executablePath,
    args: [`--user-data-dir=${userData}`],
    env: packagedTestEnvironment
  })
  let app = await launch()

  try {
    let window = await app.firstWindow()
    const externalRequests: string[] = []
    window.on('request', (request) => {
      if (/^https?:/i.test(request.url())) externalRequests.push(request.url())
    })
    await enterPackagedWorkspace(window)

    await window.getByTestId('open-settings').click()
    const settings = window.getByRole('dialog', { name: '供应商设置' })
    await expect(settings).toBeVisible()
    await expect(settings.locator('[data-provider-slot="llm"]')).toBeVisible()
    await expect(settings.locator('[data-provider-slot="image"]')).toBeVisible()
    await settings.getByRole('button', { name: '关闭供应商设置' }).click()

    const exported = await window.evaluate(`(async () => {
      let captured = null
      const originalClick = HTMLAnchorElement.prototype.click
      HTMLAnchorElement.prototype.click = function captureExport() { captured = this.href }
      try {
        document.querySelector('.export-control > button')?.click()
        if (captured === null) throw new Error('Export did not produce a data URL.')
        const image = new Image()
        const loaded = new Promise((resolve, reject) => {
          image.onload = () => resolve()
          image.onerror = () => reject(new Error('Exported image could not be decoded.'))
        })
        image.src = captured
        await loaded
        return { prefix: captured.slice(0, 22), width: image.width, height: image.height }
      } finally {
        HTMLAnchorElement.prototype.click = originalClick
      }
    })()`)
    expect(exported).toEqual({ prefix: 'data:image/png;base64,', width: 1024, height: 1280 })
    expect(externalRequests).toEqual([])

    await app.close()
    app = await launch()
    window = await app.firstWindow()
    await expect(window.getByRole('heading', { name: '项目' })).toBeVisible({ timeout: 15_000 })
    const project = window.getByRole('button', { name: '打开项目：未命名创作' })
    await expect(project).toBeVisible()
    await project.click()
    await expect(window.getByTestId('canvas-stage')).toBeVisible({ timeout: 15_000 })
  } finally {
    await app.close()
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
