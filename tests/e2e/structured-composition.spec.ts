import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { DesktopApi } from '../../src/shared/desktop-api'

test('SD1 creates a shallow semantic Group and supports precise in-group editing', async ({ browserName }, testInfo) => {
  void browserName
  const userData = await mkdtemp(join(tmpdir(), 'ai-canvas-e2e-structured-composition-'))
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
    cwd: resolve('.'),
    env: { ...process.env, AI_CANVAS_E2E: '1' }
  })
  try {
    const window = await app.firstWindow()
    await window.setViewportSize({ width: 1440, height: 900 })
    await window.getByRole('button', { name: '对话', exact: true }).click()
    await window.getByRole('textbox', { name: '对话输入' }).fill('创建一张 4:5 的晨间咖啡海报，主体是陶瓷咖啡杯，标题是 MORNING RITUAL，带柔和侧光。先不要生成图片。')
    await window.getByRole('button', { name: '发送要求' }).click()
    await expect(window.getByTestId('operation-receipt')).toBeVisible({ timeout: 10_000 })

    await window.getByRole('button', { name: '画布', exact: true }).click()
    const layerList = window.getByRole('listbox', { name: '图层' })
    const groupRow = layerList.getByRole('option').filter({ hasText: '咖啡杯组' })
    await expect(groupRow).toHaveCount(1)
    await groupRow.click()
    await window.keyboard.press('Enter')
    await expect(window.getByRole('status', { name: '组内编辑' })).toContainText('正在编辑：咖啡杯组')

    const cupRow = layerList.getByRole('option').filter({ hasText: '陶瓷咖啡杯' })
    await cupRow.click()
    const before = await window.evaluate(async () => {
      const renderer = globalThis as typeof globalThis & { readonly desktop: DesktopApi }
      return renderer.desktop.getWorkspaceBootstrap()
    })
    const beforeCup = before.scene.elements.find((element) => element.name === '陶瓷咖啡杯')
    const beforeGroup = before.scene.elements.find((element) => element.name === '咖啡杯组')
    expect(beforeCup?.groupId).toBe(beforeGroup?.id)

    await window.keyboard.press('ArrowRight')
    await expect.poll(async () => {
      const bootstrap = await window.evaluate(async () => {
        const renderer = globalThis as typeof globalThis & { readonly desktop: DesktopApi }
        return renderer.desktop.getWorkspaceBootstrap()
      })
      return bootstrap.scene.revision
    }).toBeGreaterThan(before.scene.revision)
    const after = await window.evaluate(async () => {
      const renderer = globalThis as typeof globalThis & { readonly desktop: DesktopApi }
      return renderer.desktop.getWorkspaceBootstrap()
    })
    const afterCup = after.scene.elements.find((element) => element.name === '陶瓷咖啡杯')
    const afterGroup = after.scene.elements.find((element) => element.name === '咖啡杯组')
    expect(afterCup?.transform.x).toBeGreaterThan(beforeCup?.transform.x ?? 0)
    if (afterGroup?.type !== 'group') throw new Error('Semantic Group was not preserved.')
    const children = after.scene.elements.filter((element) => afterGroup.childIds.includes(element.id))
    const left = Math.min(...children.map((element) => element.transform.x))
    const top = Math.min(...children.map((element) => element.transform.y))
    const right = Math.max(...children.map((element) => element.transform.x + element.transform.width))
    const bottom = Math.max(...children.map((element) => element.transform.y + element.transform.height))
    expect(afterGroup.transform).toEqual({ x: left, y: top, width: right - left, height: bottom - top, rotation: 0 })
    await window.screenshot({ path: testInfo.outputPath('structured-composition-group-editing-1440x900.png'), animations: 'disabled' })

    await window.getByRole('button', { name: '退出组内编辑' }).click()
    await expect(window.getByRole('status', { name: '组内编辑' })).toHaveCount(0)
    await expect(groupRow).toHaveAttribute('aria-selected', 'true')
  } finally {
    await app.close()
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
