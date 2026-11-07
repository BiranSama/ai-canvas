import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test'
import Database from 'better-sqlite3'
import { mkdtemp, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import type { Scene } from '../../src/domain'
import type { DesktopApi } from '../../src/shared/desktop-api'

/*
 * For e2e tests that check the canvas's export against Main's renderer: the
 * coffee poster example opened in a fresh app, the project's assets on disk,
 * and pictures as raw RGBA to compare.
 */

export const POSTER_WIDTH = 1024
export const POSTER_HEIGHT = 1280

export async function openCoffeePoster(exportDirectory: string, prefix = 'ai-canvas-render-'): Promise<{ app: ElectronApplication; page: Page; userData: string }> {
  const userData = await mkdtemp(join(tmpdir(), prefix))
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
    cwd: resolve('.'),
    env: { ...process.env, AI_CANVAS_E2E: 'r2', AI_CANVAS_STARTUP: 'library', AI_CANVAS_E2E_EXPORT_DIR: exportDirectory }
  })
  const page = await app.firstWindow()
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.getByRole('region', { name: '连上服务' }).getByRole('button', { name: '先用示例看看' }).click()
  await page.getByRole('region', { name: '从示例开始' }).getByRole('button', { name: '从示例开始：咖啡店海报' }).click()
  await expect(page.locator('.conversation-title p')).toContainText('4:5')
  return { app, page, userData }
}

export function currentScene(page: Page): Promise<Scene> {
  return page.evaluate(async () => (await (globalThis as unknown as { desktop: DesktopApi }).desktop.getWorkspaceBootstrap()).scene)
}

/** Finds a project's asset files, for Main's renderer run in the test. */
export async function projectAssets(userData: string, projectId: string): Promise<(assetId: string) => Promise<string | null>> {
  for (const entry of await readdir(join(userData, 'projects'), { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith('.aicanvas')) continue
    const folder = join(userData, 'projects', entry.name)
    const db = new Database(join(folder, 'project.db'), { readonly: true })
    const matches = (db.prepare('SELECT id FROM projects').get() as { id: string }).id === projectId
    const rows = db.prepare('SELECT id, relative_path FROM assets').all() as { id: string; relative_path: string }[]
    db.close()
    if (matches) return async (assetId) => { const row = rows.find((candidate) => candidate.id === assetId); return row === undefined ? null : join(folder, row.relative_path) }
  }
  throw new Error('The project folder was not found.')
}

export async function rawPixels(source: string | Buffer): Promise<Buffer> {
  return sharp(typeof source === 'string' ? await readFile(source) : source).ensureAlpha().raw().toBuffer()
}

/** The largest difference between two pictures of this width, and where it is. */
export function worstDifference(left: Buffer, right: Buffer, width = POSTER_WIDTH): { readonly value: number; readonly x: number; readonly y: number } {
  let worst = { value: 0, x: 0, y: 0 }
  for (let index = 0; index < left.length; index += 1) {
    const value = Math.abs(left[index]! - right[index]!)
    if (value > worst.value) worst = { value, x: Math.floor(index / 4) % width, y: Math.floor(index / 4 / width) }
  }
  return worst
}
