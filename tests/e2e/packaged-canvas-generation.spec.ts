import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { enterPackagedWorkspace, packagedTestEnvironment } from './packaged-test-helpers'

const executablePath = process.env.AI_CANVAS_PACKAGED_PATH

test('compiles the canvas and generates a new result inside the packaged Windows app', async () => {
  test.skip(executablePath === undefined, 'Set AI_CANVAS_PACKAGED_PATH after package:win:dir')
  if (executablePath === undefined) return

  const userData = await mkdtemp(join(tmpdir(), 'ai-canvas-packaged-reference-'))
  const app = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${userData}`],
    env: packagedTestEnvironment
  })
  try {
    const window = await app.firstWindow()
    await enterPackagedWorkspace(window)
    await window.getByRole('button', { name: '生成画布' }).click()
    await expect(window.getByTestId('generation-result')).toHaveCount(1, { timeout: 15_000 })
    await expect(window.getByText('画布参考已编译并保存')).toBeVisible()
  } finally {
    await app.close()
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
