import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { DesktopApi } from '../../src/shared/desktop-api'

test('a continued result records its parent, requested change, preserved facts and image-only reference mode', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'ai-canvas-e2e-continuity-'))
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
    cwd: resolve('.'),
    env: { ...process.env, AI_CANVAS_E2E: '1' }
  })
  try {
    const window = await app.firstWindow()
    await window.setViewportSize({ width: 1440, height: 900 })
    await window.getByRole('button', { name: '生成', exact: true }).click()
    await window.getByTestId('generation-prompt').fill('克制的晨间咖啡海报，陶瓷杯居中偏下，标题只作为轻盈的排版参考')
    await window.getByTestId('generation-submit').click()
    await expect(window.getByTestId('generation-result')).toHaveCount(1, { timeout: 15_000 })
    await window.getByRole('button', { name: '继续变化' }).click()

    const hybridMode = window.getByRole('radio', { name: '同时参考' })
    const visualMode = window.getByRole('radio', { name: '画面参考' })
    const structureMode = window.getByRole('radio', { name: '结构参考' })
    await expect(hybridMode).toHaveCount(0)
    await expect(visualMode).toHaveAttribute('aria-checked', 'true')
    await expect(structureMode).toHaveCount(0)
    await window.getByRole('textbox', { name: '本次变化' }).fill('让标题更飘逸，侧光更柔和')
    await window.getByRole('textbox', { name: '保持不变' }).fill('保持咖啡杯身份、4:5 比例和暖白底色')
    await window.getByRole('textbox', { name: '保持不变' }).blur()
    await window.getByTestId('generation-submit').click()
    await expect(window.getByTestId('generation-result')).toHaveCount(2, { timeout: 15_000 })

    const derivedResult = window.locator('[data-testid="generation-result"][data-parent-result]:not([data-parent-result=""])')
    await expect(derivedResult).toHaveCount(1)
    await derivedResult.click()
    await expect(window.getByTestId('variation-receipt')).toContainText('让标题更飘逸，侧光更柔和')
    await expect(window.getByTestId('variation-receipt')).toContainText('画面参考')

    const family = await window.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop
      return (await api.listGenerationResultFamilies())[0]
    })
    expect(family?.members).toEqual(expect.arrayContaining([
      expect.objectContaining({ parentResultId: null }),
      expect.objectContaining({
        parentResultId: expect.any(String),
        referenceMode: 'visual',
        variationInstruction: '让标题更飘逸，侧光更柔和',
        preserveConstraints: '保持咖啡杯身份、4:5 比例和暖白底色'
      })
    ]))
  } finally {
    await app.close()
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
