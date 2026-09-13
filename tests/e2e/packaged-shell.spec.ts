import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { enterPackagedWorkspace, packagedTestEnvironment } from './packaged-test-helpers'

const executablePath = process.env.AI_CANVAS_PACKAGED_PATH

test('launches the packaged Windows canvas with native modules ready', async () => {
  test.skip(executablePath === undefined, 'Set AI_CANVAS_PACKAGED_PATH after package:win:dir')
  if (executablePath === undefined) return

  const userData = await mkdtemp(join(tmpdir(), 'ai-canvas-packaged-shell-'))
  const app = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${userData}`],
    env: packagedTestEnvironment
  })

  try {
    const window = await app.firstWindow()
    await expect(window.getByRole('img', { name: 'AI Canvas' })).toBeVisible()
    await expect(window.getByRole('img', { name: 'AI Canvas' })).toHaveJSProperty('naturalWidth', 1254)
    await enterPackagedWorkspace(window)
    await expect(window.getByTitle(/SQLite \d.*Sharp \d/)).toBeVisible()
  } finally {
    await app.close()
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
