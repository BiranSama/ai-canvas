import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { enterPackagedWorkspace, packagedTestEnvironment } from './packaged-test-helpers'

const executablePath = process.env.AI_CANVAS_PACKAGED_PATH

test('draws a mask and completes a non-destructive edit in the packaged Windows app', async () => {
  test.setTimeout(60_000)
  test.skip(executablePath === undefined, 'Set AI_CANVAS_PACKAGED_PATH after package:win:dir')
  if (executablePath === undefined) return
  const userData = await mkdtemp(join(tmpdir(), 'ai-canvas-packaged-local-edit-'))
  const app = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${userData}`],
    env: packagedTestEnvironment
  })
  try {
    const window = await app.firstWindow()
    await enterPackagedWorkspace(window)
    await window.getByRole('button', { name: '生成', exact: true }).click()
    await window.getByTestId('generation-prompt').fill('Stable source for a packaged local edit')
    await window.getByTestId('generation-submit').click()
    await expect(window.getByTestId('generation-result')).toHaveCount(1, { timeout: 15_000 })
    await window.getByTestId('insert-generation-result').click()
    await window.getByRole('button', { name: '蒙版' }).click()
    const stage = await window.getByTestId('canvas-stage').boundingBox()
    if (stage === null) throw new Error('Canvas stage is missing.')
    const centerX = stage.x + stage.width * .5
    const centerY = stage.y + stage.height * .44
    await window.mouse.move(centerX - 28, centerY - 18)
    await window.mouse.down()
    await window.mouse.move(centerX + 28, centerY - 18, { steps: 4 })
    await window.mouse.move(centerX + 28, centerY + 18, { steps: 4 })
    await window.mouse.move(centerX - 28, centerY + 18, { steps: 4 })
    await window.mouse.move(centerX - 28, centerY - 18, { steps: 4 })
    await window.mouse.up()
    await window.getByRole('textbox', { name: '创作输入' }).fill('把蒙版区域改成柔和的蓝色玻璃')
    await window.getByTestId('local-edit-submit').click()
    await expect(window.getByTestId('generation-result')).toHaveCount(2, { timeout: 15_000 })
    await expect(window.getByText(/非破坏式局部修改/)).toBeVisible()
  } finally {
    await app.close()
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
