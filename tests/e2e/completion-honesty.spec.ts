import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { DesktopApi } from '../../src/shared/desktop-api'

test.setTimeout(65000)
let app: ElectronApplication
let page: Page
async function launch(userData: string) {
  app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], cwd: resolve('.'), env: { ...process.env, AI_CANVAS_E2E: 'r2', AI_CANVAS_STARTUP: 'library' } })
  await app.evaluate(() => {
    const state = globalThis as typeof globalThis & { __completionNetwork: number }
    state.__completionNetwork = 0
    state.fetch = async () => { state.__completionNetwork++; throw new Error('OFFLINE_COMPLETION_UI') }
  })
  page = await app.firstWindow(); await page.setViewportSize({ width: 1440, height: 900 })
}
async function bootstrap() { return page.evaluate(() => (globalThis as unknown as { desktop: DesktopApi }).desktop.getWorkspaceBootstrap()) }
async function conversation() { return page.evaluate(() => (globalThis as unknown as { desktop: DesktopApi }).desktop.getConversationSnapshot()) }
async function network() { expect(await app.evaluate(() => (globalThis as typeof globalThis & { __completionNetwork: number }).__completionNetwork)).toBe(0) }
test.afterEach(async () => { if (app?.windows().length) { await network(); await app.close() } })

test('preserves visual musts, accepts a concrete version with a real click, and expires that acceptance after canvas editing and restart', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'review-ui-'))
  await launch(userData); await page.locator('.new-project-main').click()
  await page.getByRole('button', { name: '对话', exact: true }).click()
  await page.getByLabel('对话输入').fill('创建一张 4:5 人物海报，主体是侧身人物，保留人物面部自然且符合品牌调性。先不要生成图片。')
  await page.getByRole('button', { name: '发送要求', exact: true }).click()
  const review = page.getByRole('region', { name: '完成与验收事实' }).last()
  await expect(review).toContainText('人物面部自然且符合品牌调性')
  await expect(review).toContainText('操作已执行')
  await expect(review).toContainText('结构检查通过')
  await expect(review).toContainText('视觉效果待复核')
  await page.screenshot({ path: test.info().outputPath('visual-must-before-accept.png') })
  const before = await bootstrap()
  await review.getByRole('button', { name: '接受这版作品', exact: true }).click()
  await expect(review).toContainText('你已接受这版作品')
  const accepted = await conversation()
  expect(accepted.messages.findLast((message) => message.receipt?.completion?.userAcceptance !== null)?.receipt?.completion?.userAcceptance?.sceneRevision).toBe(before.scene.revision)
  expect((await bootstrap()).scene).toEqual(before.scene)
  await page.getByRole('button', { name: '画布', exact: true }).click()
  await page.getByRole('button', { name: '形状', exact: true }).click()
  await expect.poll(async () => (await bootstrap()).scene.revision).toBeGreaterThan(before.scene.revision)
  await page.getByRole('button', { name: '对话', exact: true }).click()
  await expect(review).toContainText('此前版本已接受')
  await expect(review).toContainText('作品已修改')
  await expect(review.getByRole('button', { name: '接受这版作品', exact: true })).toHaveCount(0)
  await network(); await app.close()
  await launch(userData)
  await page.locator(`[data-project-id="${before.projectId}"]`).getByRole('button').first().click()
  const restoredReview = page.getByRole('region', { name: '完成与验收事实' }).last()
  await expect(restoredReview).toContainText('此前版本已接受')
  await expect(restoredReview).toContainText('人物面部自然且符合品牌调性')
  await page.screenshot({ path: test.info().outputPath('review-after-edit-and-restart.png') })
  const jobs = await page.evaluate(() => (globalThis as unknown as { desktop: DesktopApi }).desktop.listGenerationJobs())
  expect(jobs).toHaveLength(0)
  await writeFile(test.info().outputPath('completion-main-facts.json'), JSON.stringify({ before, accepted, afterRestart: await conversation(), jobs, network: 0 }, null, 2))
})

test('ordinary explanation remains text and creates no empty operation receipt or execution completion panel', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'explain-ui-'))
  await launch(userData); await page.locator('.new-project-main').click()
  await page.getByRole('button', { name: '对话', exact: true }).click()
  const before = await bootstrap()
  await page.getByLabel('对话输入').fill('解释一下画布比例是什么意思，先不要生成图片。')
  await page.getByRole('button', { name: '发送要求', exact: true }).click()
  await expect.poll(async () => (await conversation()).runs[0]?.status).toBe('completed')
  await expect(page.locator('.conversation-message.is-assistant')).toHaveCount(1)
  await expect(page.getByTestId('operation-receipt')).toHaveCount(0)
  await expect(page.getByTestId('agent-status')).toHaveCount(0)
  expect((await bootstrap()).scene).toEqual(before.scene)
  expect((await conversation()).messages.at(-1)).toMatchObject({ kind: 'text', receipt: null })
  await page.screenshot({ path: test.info().outputPath('ordinary-explanation.png') })
})
