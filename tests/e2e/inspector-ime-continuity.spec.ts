import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { DesktopApi } from '../../src/shared/desktop-api'

test('Inspector keeps a complete Chinese text edit and commits it once after editing', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'ai-canvas-e2e-inspector-ime-'))
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
    cwd: resolve('.'),
    env: { ...process.env, AI_CANVAS_E2E: '1' }
  })
  try {
    const window = await app.firstWindow()
    await window.setViewportSize({ width: 1440, height: 900 })
    await window.getByRole('button', { name: /文字 T/ }).click()
    await window.getByRole('tab', { name: '属性' }).click()
    const content = window.getByRole('textbox', { name: '文字内容' })
    const expected = '轻盈飘逸的晨光标题'

    await content.fill(expected)
    await content.blur()
    await expect(content).toHaveValue(expected)
    await expect.poll(async () => window.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop
      const bootstrap = await api.getWorkspaceBootstrap()
      return bootstrap.scene.elements.some((element) => element.type === 'text' && element.content === '轻盈飘逸的晨光标题')
        ? '轻盈飘逸的晨光标题'
        : null
    })).toBe(expected)

    await expect(window.getByLabel('文字用途')).toHaveValue('standard')
    await expect(window.getByLabel('视觉权重')).toHaveValue('secondary')
  } finally {
    await app.close()
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
