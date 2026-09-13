import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { DesktopApi } from '../../src/shared/desktop-api'

test('Diagnostic Export v1 stays explicit, bounded, Main-only and offline', async ({ browserName }, testInfo) => {
  void browserName
  const userData = await mkdtemp(join(tmpdir(), 'ai-canvas-e2e-diagnostic-export-'))
  const outputPath = join(userData, 'diagnostic-export.json')
  const externalRequests: string[] = []
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
    cwd: resolve('.'),
    env: {
      ...process.env,
      AI_CANVAS_E2E: '1',
      AI_CANVAS_E2E_DIAGNOSTIC_EXPORT_PATH: outputPath
    }
  })
  try {
    const window = await app.firstWindow()
    window.on('request', (request) => {
      if (/^https?:/i.test(request.url())) externalRequests.push(request.url())
    })
    await window.getByTestId('open-settings').evaluate((button) => button.click())
    await expect(window.getByRole('dialog', { name: '供应商设置' })).toBeVisible()
    await window.getByRole('button', { name: '隐私与高级' }).evaluate((button) => button.click())
    await expect(window.getByTestId('export-diagnostics')).toBeVisible()
    for (const viewport of [
      { width: 1024, height: 700 },
      { width: 1280, height: 800 },
      { width: 1440, height: 900 },
      { width: 1920, height: 1080 },
      { width: 2560, height: 1440 }
    ] as const) {
      await window.setViewportSize(viewport)
      const exportButton = window.getByTestId('export-diagnostics')
      await exportButton.scrollIntoViewIfNeeded()
      const box = await exportButton.boundingBox()
      if (box === null) throw new Error('Diagnostic export action is not measurable.')
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.y).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width)
      expect(box.y + box.height).toBeLessThanOrEqual(viewport.height)
      await window.screenshot({
        path: testInfo.outputPath(`diagnostic-export-${viewport.width}x${viewport.height}.png`),
        animations: 'disabled'
      })
    }

    const apiBoundary = await window.evaluate(() => {
      const renderer = globalThis as typeof globalThis & { readonly desktop: DesktopApi }
      return {
        exportArity: renderer.desktop.exportDiagnostics.length,
        methods: Object.keys(renderer.desktop)
      }
    })
    expect(apiBoundary.exportArity).toBe(0)
    expect(apiBoundary.methods.some((method) => /read.*diagnostic|diagnostic.*path/i.test(method))).toBe(false)

    await window.getByTestId('export-diagnostics').evaluate((button) => button.click())
    await expect(window.getByTestId('diagnostic-export-result')).toContainText('已保存 diagnostic-export.json')

    const bytes = await readFile(outputPath, 'utf8')
    const exported = JSON.parse(bytes) as {
      readonly schemaVersion: number
      readonly diagnostics: { readonly records: readonly unknown[] }
      readonly project: Readonly<Record<string, unknown>>
    }
    expect((await stat(outputPath)).size).toBeLessThanOrEqual(2 * 1024 * 1024)
    expect(exported).toMatchObject({ schemaVersion: 1, diagnostics: { records: expect.any(Array) } })
    expect(bytes).not.toMatch(/authorization\s*[:=]\s*bearer|data:image|[A-Za-z]:[\\/]|\\\\Users\\|https?:\/\//i)
    expect(exported.project).not.toHaveProperty('scene')
    expect(exported.project).not.toHaveProperty('database')
    expect(externalRequests).toEqual([])
  } finally {
    await app.close()
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
