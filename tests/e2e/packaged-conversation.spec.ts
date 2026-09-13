import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { enterPackagedWorkspace, packagedTestEnvironment } from './packaged-test-helpers'

const executablePath = process.env.AI_CANVAS_PACKAGED_PATH

test('runs the persistent conversation-to-canvas agent inside the packaged Windows app', async () => {
  test.skip(executablePath === undefined, 'Set AI_CANVAS_PACKAGED_PATH after package:win:dir')
  if (executablePath === undefined) return

  const userData = await mkdtemp(join(tmpdir(), 'ai-canvas-packaged-agent-'))
  const app = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${userData}`],
    env: packagedTestEnvironment
  })
  try {
    const window = await app.firstWindow()
    await enterPackagedWorkspace(window)
    await window.getByRole('button', { name: '对话' }).click()
    await window.getByRole('textbox', { name: '对话输入' }).fill('创建一张 4:5 的香水海报，标题是 NIGHT VEIL，瓶子放中央偏下，瓶后有柔和轮廓光。先不要生成图片。')
    await window.getByRole('button', { name: '发送要求' }).click()
    await expect(window.getByTestId('operation-receipt')).toBeVisible({ timeout: 10_000 })
    await window.getByRole('button', { name: '画布', exact: true }).click()
    await expect(window.getByRole('listbox', { name: '图层' }).getByRole('option')).toHaveCount(8)
  } finally {
    await app.close()
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
