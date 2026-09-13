import { _electron as electron, expect, test, type Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const historicalStageCopy = /(^|[^a-z0-9])(?:MVP|R1|R2|AH1|G2|G3)(?=$|[^a-z0-9])/i
const rawDevelopmentCopy = /(^|[^a-z0-9])mock(?=$|[^a-z0-9])|not supported in/i

async function expectProductSurface(page: Page): Promise<void> {
  const visibleCopy = await page.locator('body').innerText()
  expect(visibleCopy).not.toMatch(historicalStageCopy)
  expect(visibleCopy).not.toMatch(rawDevelopmentCopy)

  const unnamedButtons = await page.locator('button:visible').evaluateAll((buttons) => buttons
    .filter((button) => {
      const label = button.getAttribute('aria-label')
        ?? button.getAttribute('title')
        ?? button.textContent
      return label?.trim().length === 0
    })
    .map((button) => button.outerHTML.slice(0, 240)))
  expect(unnamedButtons).toEqual([])
}

test('normal product surfaces stay free of historical stage and raw development copy', async () => {
  test.setTimeout(90_000)
  const userData = await mkdtemp(join(tmpdir(), 'ai-canvas-product-baseline-'))
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
    cwd: resolve('.'),
    env: { ...process.env, AI_CANVAS_E2E: 'product-baseline', AI_CANVAS_STARTUP: 'library' }
  })
  const externalRequests: string[] = []

  try {
    const window = await app.firstWindow()
    window.on('request', (request) => {
      if (/^https?:/i.test(request.url())) externalRequests.push(request.url())
    })
    await window.waitForLoadState('domcontentloaded')
    await expectProductSurface(window)

    await window.getByRole('button', { name: '打开设置' }).evaluate((button) => button.click())
    const settings = window.getByRole('dialog', { name: '供应商设置' })
    await expect(settings).toBeVisible()
    for (const section of ['供应商', 'Agent 上下文', '生成档位', '项目与存储', '外观', '隐私与高级']) {
      await settings.getByRole('button', { name: section, exact: true }).evaluate((button) => button.click())
      await expectProductSurface(window)
    }
    await settings.getByRole('button', { name: '关闭供应商设置' }).evaluate((button) => button.click())

    await window.getByRole('button', { name: '新建项目' }).evaluate((button) => button.click())
    await expect(window.getByTestId('canvas-stage')).toBeVisible({ timeout: 10_000 })
    await expectProductSurface(window)

    for (const view of ['对话', '画布', '生成']) {
      await window.getByRole('button', { name: view, exact: true }).evaluate((button) => button.click())
      await expectProductSurface(window)
    }

    await window.getByTestId('open-settings').evaluate((button) => button.click())
    await expect(window.getByRole('dialog', { name: '供应商设置' })).toBeVisible()
    await expectProductSurface(window)
    expect(externalRequests).toEqual([])
  } finally {
    await app.close()
    await rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
