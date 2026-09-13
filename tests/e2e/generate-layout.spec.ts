import { openGenerationOptions } from '../helpers/workbench-ui'
import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

test('keeps the completed generation result and right-side actions inside 1024 by 700', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'ai-canvas-e2e-generate-layout-'))
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
    cwd: resolve('.'),
    env: { ...process.env, AI_CANVAS_E2E: '1' }
  })

  try {
    const window = await app.firstWindow()
    await window.setViewportSize({ width: 1024, height: 700 })
    await window.getByRole('button', { name: '生成', exact: true }).click()
    await window.getByTestId('generation-prompt').fill('Compact editorial portrait with soft window light')
    await openGenerationOptions(window)
    await window.getByLabel('生成数量').selectOption('1')
    await window.getByTestId('generation-submit').click()
    await expect(window.getByTestId('generation-result')).toHaveCount(1, { timeout: 15_000 })
    await expect(window.getByRole('button', { name: '放入画布' })).toBeVisible()

    const assetPresentation = await window.evaluate(`(() => {
      const focus = document.querySelector('.result-focus')
      const focusedImage = focus?.querySelector(':scope > img')
      const filmstripImage = document.querySelector('.result-filmstrip img')
      if (focus === null || focusedImage === null || filmstripImage === null) throw new Error('Generation images are missing.')
      const focusRect = focus.getBoundingClientRect()
      const imageRect = focusedImage.getBoundingClientRect()
      return {
        focus: { left: focusRect.left, top: focusRect.top, right: focusRect.right, bottom: focusRect.bottom },
        image: { left: imageRect.left, top: imageRect.top, right: imageRect.right, bottom: imageRect.bottom },
        renderedRatio: imageRect.width / imageRect.height,
        naturalRatio: focusedImage.naturalWidth / focusedImage.naturalHeight,
        objectFit: getComputedStyle(focusedImage).objectFit,
        focusSource: focusedImage.src.slice(0, 32),
        filmstripSource: filmstripImage.src.slice(0, 32)
      }
    })()`) as {
      readonly focus: { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number }
      readonly image: { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number }
      readonly renderedRatio: number
      readonly naturalRatio: number
      readonly objectFit: string
      readonly focusSource: string
      readonly filmstripSource: string
    }
    expect(assetPresentation.focusSource).toContain('data:image/png;base64,')
    expect(assetPresentation.filmstripSource).toContain('data:image/webp;base64,')
    expect(assetPresentation.naturalRatio).toBeGreaterThan(0)
    expect(assetPresentation.objectFit).toBe('contain')
    expect(assetPresentation.image.left).toBeGreaterThanOrEqual(assetPresentation.focus.left)
    expect(assetPresentation.image.top).toBeGreaterThanOrEqual(assetPresentation.focus.top)
    expect(assetPresentation.image.right).toBeLessThanOrEqual(assetPresentation.focus.right)
    expect(assetPresentation.image.bottom).toBeLessThanOrEqual(assetPresentation.focus.bottom)
    const actionRow = await window.locator('.result-action-row').boundingBox()
    expect(actionRow!.y).toBeGreaterThanOrEqual(assetPresentation.focus.bottom)

    const selectors = {
      switcher: '.view-switcher',
      headerActions: '.header-actions',
      workspace: '.generate-workspace',
      composer: '.generation-composer',
      results: '.generation-results',
      focus: '.result-focus',
      resultActions: '.result-actions',
      filmstrip: '.result-filmstrip'
    }
    const entries = await Promise.all(Object.entries(selectors).map(async ([name, selector]) => {
      const box = await window.locator(selector).boundingBox()
      if (box === null) throw new Error(`Missing ${selector}`)
      return [name, { left: box.x, top: box.y, right: box.x + box.width, bottom: box.y + box.height }] as const
    }))
    const rects = Object.fromEntries(entries) as Record<keyof typeof selectors, { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number }>

    expect(rects.switcher.right).toBeLessThanOrEqual(rects.headerActions.left + 1)
    for (const [name, rect] of Object.entries(rects)) {
      expect(rect.left, `${name} left edge`).toBeGreaterThanOrEqual(-1)
      expect(rect.top, `${name} top edge`).toBeGreaterThanOrEqual(-1)
      expect(rect.right, `${name} right edge`).toBeLessThanOrEqual(1025)
      expect(rect.bottom, `${name} bottom edge`).toBeLessThanOrEqual(701)
    }
  } finally {
    await app.close()
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
