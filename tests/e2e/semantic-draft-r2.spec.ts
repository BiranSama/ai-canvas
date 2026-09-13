import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { DesktopApi } from '../../src/shared/desktop-api'

const REQUEST = '创建一张 4:5 人物编辑海报，主体是侧身人物，标题是 QUIET FORM，保留右侧留白与柔和侧光。先不要生成图片。'

test('AC-R2-07 creates a theme-neutral editable semantic draft and persists its planning context', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'ai-canvas-r2-semantic-draft-'))
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
    cwd: resolve('.'),
    env: { ...process.env, AI_CANVAS_E2E: '1' }
  })
  try {
    const window = await app.firstWindow()
    await window.getByRole('button', { name: '对话', exact: true }).evaluate((button) => button.click())
    await window.getByRole('textbox', { name: '对话输入' }).fill(REQUEST)
    await window.getByRole('button', { name: '发送要求' }).evaluate((button) => button.click())
    await expect(window.getByTestId('operation-receipt')).toBeVisible({ timeout: 10_000 })
    await window.getByRole('button', { name: '画布', exact: true }).evaluate((button) => button.click())

    const layers = window.getByRole('listbox', { name: '图层' }).getByRole('option')
    await expect(layers).toHaveCount(8)
    await expect(layers.getByText('人物主体组', { exact: true })).toBeVisible()
    await expect(layers.getByText('侧身人物', { exact: true })).toBeVisible()
    await expect(layers.getByText('主标题', { exact: true })).toBeVisible()
    await expect(layers.getByText('构图光影', { exact: true })).toBeVisible()
    await expect(window.locator('body')).not.toContainText('NIGHT VEIL')
    await expect(window.locator('body')).not.toContainText('香水瓶')

    const persisted = await window.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop
      const [bootstrap, jobs] = await Promise.all([api.getWorkspaceBootstrap(), api.listGenerationJobs()])
      return {
        jobs: jobs.length,
        context: bootstrap.scene.creativeContext,
        descriptions: bootstrap.scene.elements.map((element) => element.description),
        subjectFrame: bootstrap.scene.elements.find((element) => element.type === 'placeholder')?.type === 'placeholder'
          ? bootstrap.scene.elements.find((element) => element.type === 'placeholder')?.frameShape
          : null
      }
    })
    expect(persisted).toMatchObject({
      jobs: 0,
      context: {
        brief: { theme: 'portrait', generationIntent: 'none', text: [{ content: 'QUIET FORM', mode: 'reference', visualWeight: 'secondary' }] },
        plan: { canvas: { aspectWidth: 4, aspectHeight: 5 } }
      },
      subjectFrame: 'portrait'
    })
    expect(persisted.descriptions.every((description) => description.length > 0)).toBe(true)

    await layers.getByText('主标题', { exact: true }).evaluate((element) => element.click())
    await window.getByRole('tab', { name: /属性/ }).evaluate((button) => button.click())
    const textField = window.getByRole('textbox', { name: '文字内容' })
    await textField.fill('QUIET FORM / 02')
    await textField.blur()
    await expect(textField).toHaveValue('QUIET FORM / 02')
    await window.getByLabel('撤销', { exact: true }).evaluate((button) => button.click())
    await expect(textField).toHaveValue('QUIET FORM')
  } finally {
    await app.close()
    await rm(userData, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
  }
})
