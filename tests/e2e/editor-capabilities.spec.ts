import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { DesktopApi } from '../../src/shared/desktop-api'

test('AC-R1-03/04/05 edits geometry, complete text properties and layer actions through one scene', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'ai-canvas-e2e-editor-'))
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
    cwd: resolve('.'),
    env: { ...process.env, AI_CANVAS_E2E: '1' }
  })
  try {
    const window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await window.setViewportSize({ width: 1440, height: 900 })
    await expect(window.getByTestId('canvas-stage')).toBeVisible()
    await window.getByRole('button', { name: '文字 T', exact: true }).click()

    const layers = window.getByRole('listbox', { name: '图层' })
    const textRow = window.getByRole('option').filter({ hasText: '文字' }).first()
    await textRow.locator('.layer-copy').dblclick()
    const rename = window.getByRole('textbox', { name: '重命名文字' })
    await rename.fill('主标题')
    await rename.press('Enter')
    await expect(layers.getByText('主标题', { exact: true })).toBeVisible()

    await window.getByRole('tab', { name: /属性/ }).click()
    await window.getByRole('button', { name: '高级', exact: true }).click()
    await window.getByLabel('文字内容').fill('AFTER RAIN')
    await window.getByLabel('字体').fill('Georgia')
    await window.getByLabel('字号 px').fill('96')
    await window.getByLabel('字重').selectOption('700')
    const textColor = window.getByLabel('文字颜色')
    await textColor.evaluate((input, value) => {
      const nativeSetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set
      nativeSetter?.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
    }, '#203452')
    await expect.poll(async () => window.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop
      const bootstrap = await api.getWorkspaceBootstrap()
      const title = bootstrap.scene.elements.find((element) => element.type === 'text' && element.content === 'AFTER RAIN')
      return title?.type === 'text' ? title.fill : null
    })).toBe('#203452')
    await window.getByLabel('对齐').selectOption('start')
    await window.getByLabel('换行').selectOption('character')
    await window.locator('summary', { hasText: 'AI 文字风格' }).click()
    await window.getByLabel('风格描述').fill('深蓝高对比衬线字，带克制的纸张压印感')
    await window.getByLabel('呈现方式').selectOption('ai-material')

    const widthField = window.locator('.compact-field').filter({ hasText: /^W$/ }).locator('input')
    const heightField = window.locator('.compact-field').filter({ hasText: /^H$/ }).locator('input')
    const initialHeight = Number(await heightField.inputValue())
    await window.getByRole('button', { name: '自由改变宽高' }).click()
    await widthField.fill(String(Number(await widthField.inputValue()) + 120))
    await expect.poll(async () => Number(await heightField.inputValue())).not.toBe(initialHeight)

    await window.getByRole('tab', { name: /图层/ }).click()
    await window.getByRole('button', { name: '复制主标题' }).click()
    await expect(layers.getByText('主标题 副本', { exact: true })).toBeVisible()
    await window.getByRole('button', { name: '置底主标题 副本' }).click()
    await window.getByRole('button', { name: '删除主标题 副本' }).click()
    await expect(layers.getByText('主标题 副本', { exact: true })).toHaveCount(0)

    await window.getByRole('button', { name: '形状', exact: true }).click()
    await layers.getByText('主标题', { exact: true }).click()
    await window.getByRole('option').filter({ has: window.locator('strong', { hasText: /^形状$/ }) }).click({ modifiers: ['Control'] })
    await window.getByRole('button', { name: '组合', exact: true }).click()
    await expect(window.getByRole('option').filter({ has: window.locator('strong', { hasText: /^组合$/ }) })).toBeVisible()
    await window.getByRole('button', { name: '折叠组合' }).click()
    await expect(layers.getByText('主标题', { exact: true })).toHaveCount(0)
    await window.getByRole('button', { name: '展开组合' }).click()
    await expect(layers.getByText('主标题', { exact: true })).toBeVisible()

    const compiled = await window.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop
      const bootstrap = await api.getWorkspaceBootstrap()
      const result = await api.generateFromCanvas({
        scene: bootstrap.scene,
        originalRequirement: '按当前排版生成完整封面',
        providerId: 'mock',
        model: 'mock-balanced',
        count: 1,
        sourceMessageId: null
      })
      const title = bootstrap.scene.elements.find((element) => element.type === 'text' && element.content === 'AFTER RAIN')
      return { prompt: result.sentPrompt, title }
    })
    expect(compiled.prompt).toContain('AFTER RAIN')
    expect(compiled.prompt).toContain('当前占位字体和字号不是最终形态')
    expect(compiled.prompt).not.toContain('Georgia')
    expect(compiled.prompt).not.toContain('96px')
    expect(compiled.title).toMatchObject({ fontFamily: 'Georgia', fontSize: 96, fontWeight: 700, fill: '#203452', renderStrategy: 'ai-material' })
  } finally {
    await app.close()
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
