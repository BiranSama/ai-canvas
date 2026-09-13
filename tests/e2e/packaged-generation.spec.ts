import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { enterPackagedWorkspace, packagedTestEnvironment } from './packaged-test-helpers'

const executablePath = process.env.AI_CANVAS_PACKAGED_PATH

test('runs a Mock generation inside the packaged Windows app', async () => {
  test.skip(executablePath === undefined, 'Set AI_CANVAS_PACKAGED_PATH after package:win:dir')
  if (executablePath === undefined) return

  const userData = await mkdtemp(join(tmpdir(), 'ai-canvas-packaged-generation-'))
  const app = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${userData}`],
    env: packagedTestEnvironment
  })

  try {
    const window = await app.firstWindow()
    await enterPackagedWorkspace(window)
    await window.locator('.view-switcher button').nth(2).click()
    await window.getByTestId('generation-prompt').fill('Packaged local Mock generation')
    await window.getByTestId('generation-submit').click()
    await expect(window.getByTestId('generation-result')).toHaveCount(1, { timeout: 15_000 })
    const status = await window.evaluate(() => {
      const renderer = globalThis as typeof globalThis & {
        readonly desktop: { readonly listGenerationJobs: () => Promise<readonly { readonly status: string }[]> }
      }
      return renderer.desktop.listGenerationJobs().then((jobs) => jobs[0]?.status)
    })
    expect(status).toBe('completed')
  } finally {
    await app.close()
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
