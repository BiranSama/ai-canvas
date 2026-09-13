import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

test('keeps canvas controls usable at 150 percent device scale', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'ai-canvas-e2e-hidpi-'))
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
    cwd: resolve('.'),
    env: { ...process.env, AI_CANVAS_E2E: '1' }
  })

  try {
    const window = await app.firstWindow()
    await window.setViewportSize({ width: 1280, height: 800 })
    const cdp = await app.context().newCDPSession(window)
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1280,
      height: 800,
      deviceScaleFactor: 1.5,
      mobile: false
    })
    expect(await window.evaluate('globalThis.devicePixelRatio') as number).toBeGreaterThanOrEqual(1.5)
    await expect(window.getByTestId('canvas-stage')).toBeVisible()
    await expect(window.getByRole('button', { name: '导出', exact: true })).toBeVisible()
    await expect(window.getByRole('textbox', { name: '创作输入' })).toBeVisible()
    await window.getByRole('button', { name: '文字 T' }).evaluate((button) => button.click())
    await expect(window.getByRole('button', { name: '撤销' })).toBeEnabled()
  } finally {
    await app.close()
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
