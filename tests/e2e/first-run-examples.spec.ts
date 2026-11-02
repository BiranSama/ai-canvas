import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

test('a new install offers to connect a service, opens a merchant example and guides the first message', async () => {
  test.setTimeout(90_000)
  const userData = await mkdtemp(join(tmpdir(), 'ai-canvas-first-run-'))
  let app: ElectronApplication | null = null
  try {
    app = await electron.launch({
      args: ['.', `--user-data-dir=${userData}`],
      cwd: resolve('.'),
      env: { ...process.env, AI_CANVAS_E2E: 'r2', AI_CANVAS_STARTUP: 'library' }
    })
    const window = await app.firstWindow()
    await window.setViewportSize({ width: 1440, height: 900 })

    // The text model has no key yet: the card asks for one, vendor first.
    const card = window.getByRole('region', { name: '连上服务' })
    await expect(card).toBeVisible()
    await expect(card.getByRole('button', { name: /火山方舟/ })).toHaveAttribute('aria-pressed', 'true')
    await expect(card.getByLabel('同一个 Key 也用来生图（火山方舟 Seedream）')).toBeChecked()
    await card.getByRole('button', { name: /Kimi/ }).click()
    await expect(card.getByRole('textbox', { name: '模型名' })).toBeVisible()
    await expect(card.getByRole('button', { name: '保存并测试连接' })).toBeDisabled()

    // 「先用示例看看」 puts it away and brings the examples into view.
    await card.getByRole('button', { name: '先用示例看看' }).click()
    await expect(card).toHaveCount(0)
    const examples = window.getByRole('region', { name: '从示例开始' })
    await expect(examples).toBeInViewport()
    await expect(examples.getByRole('button', { name: /^从示例开始：/ })).toHaveCount(4)

    await examples.getByRole('button', { name: '从示例开始：咖啡店海报' }).click()
    await expect(window.getByRole('navigation', { name: '工作视图' }).getByRole('button', { name: '对话' })).toHaveAttribute('aria-current', 'page')
    await expect(window.locator('.conversation-title p')).toContainText('4:5')
    await expect(window.locator('.conversation-title p')).not.toContainText(' 0 个元素')

    // The guide brings the example's own prompts; one fills the composer.
    const guide = window.getByRole('region', { name: '新手指引' })
    await expect(guide).toBeVisible()
    await guide.getByRole('button', { name: '把标题换成我的店名' }).click()
    await expect(window.getByRole('textbox', { name: '对话输入' })).toHaveValue('把标题换成我的店名')
    await guide.getByRole('button', { name: '知道了' }).click()
    await expect(guide).toHaveCount(0)

    // 高级 says this build does not update itself.
    await window.getByRole('button', { name: '设置', exact: true }).evaluate((button: { click(): void }) => button.click())
    const settings = window.getByRole('dialog', { name: '设置', exact: true })
    await settings.getByRole('button', { name: '高级', exact: true }).click()
    await expect(settings.getByLabel('版本与更新')).toContainText('开发版不会自动更新。')
    await expect(settings.getByRole('button', { name: '检查更新' })).toHaveCount(0)
  } finally {
    await app?.close()
    await rm(userData, { recursive: true, force: true })
  }
})
