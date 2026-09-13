import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

test('Chinese composition survives autosave in both shared composers without sending candidate Enter', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'ai-canvas-e2e-composer-ime-'))
  const app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], cwd: resolve('.'), env: { ...process.env, AI_CANVAS_E2E: '1' } })
  try {
    const page = await app.firstWindow()
    await page.setViewportSize({ width: 1440, height: 900 })
    const cdp = await page.context().newCDPSession(page)
    for (const [view, label] of [['对话', '对话输入'], ['画布', '创作输入']] as const) {
      await page.getByRole('button', { name: view, exact: true }).click()
      const input = page.getByRole('textbox', { name: label, exact: true })
      await input.fill('')
      await input.focus()
      await cdp.send('Input.imeSetComposition', { text: 'shanhai', selectionStart: 7, selectionEnd: 7 })
      // Exceeds both the 150ms persistence debounce and field commit delay.
      await page.waitForTimeout(600)
      await expect(input).toBeFocused()
      await expect(input).toHaveValue('shanhai')
      await input.dispatchEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true, cancelable: true })
      await expect(input).toBeFocused()
      await cdp.send('Input.insertText', { text: '山海' })
      await page.waitForTimeout(600)
      await expect(input).toBeFocused()
      await expect(input).toHaveValue('山海')
      await page.keyboard.insertText('，暗色调')
      await page.waitForTimeout(600)
      await expect(input).toBeFocused()
      await expect(input).toHaveValue('山海，暗色调')
      await expect(page.getByRole('button', { name: view === '对话' ? '发送要求' : '发送创作指令', exact: true })).toBeEnabled()
      await page.screenshot({ path: test.info().outputPath(`${view}-ime.png`) })
    }
    await page.getByRole('button', { name: '对话', exact: true }).click()
    await expect(page.getByRole('textbox', { name: '对话输入' })).toHaveValue('山海，暗色调')
  } finally {
    await app.close()
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
