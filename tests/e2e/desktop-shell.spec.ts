import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

test('launches the production canvas with native modules isolated in Main', async () => {
  test.setTimeout(60_000)
  const userData = await mkdtemp(join(tmpdir(), 'ai-canvas-e2e-shell-'))
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
    cwd: resolve('.'),
    env: { ...process.env, AI_CANVAS_E2E: '1' }
  })

  try {
    const window = await app.firstWindow()
    window.on('console', (message) => console.log(`[renderer:${message.type()}] ${message.text()}`))
    window.on('pageerror', (error) => console.log(`[renderer:error] ${error.message}`))
    await window.waitForLoadState('domcontentloaded')
    await expect(window.getByRole('button', { name: '画布', exact: true })).toHaveAttribute('aria-current', 'page')
    await expect(window.getByTestId('canvas-stage')).toBeVisible()
    await expect(window.getByRole('listbox', { name: '图层' })).toBeVisible()
    await expect(window.getByTitle(/SQLite \d.*Sharp \d/)).toBeVisible()
    await expect(window.getByRole('listbox', { name: '图层' }).getByRole('option')).toHaveCount(0)

    await window.getByRole('button', { name: '对话', exact: true }).evaluate((button) => button.click())
    await window.getByRole('textbox', { name: '对话输入' }).fill('创建一张 4:5 的植物展览海报，标题是 VERDANT，蕨叶标本放在中央偏下，后方有柔和轮廓光。先不要生成图片。')
    await window.getByRole('button', { name: '发送要求' }).evaluate((button) => button.click())
    await expect(window.getByTestId('operation-receipt')).toBeVisible({ timeout: 10_000 })
    await window.getByRole('button', { name: '画布', exact: true }).evaluate((button) => button.click())

    const stage = window.getByTestId('canvas-stage')
    const viewportScale = window.getByTestId('viewport-scale')
    const fittedScale = await viewportScale.textContent()
    await stage.locator('.konvajs-content').evaluate((surface) => {
      const rect = surface.getBoundingClientRect()
      const BrowserWheelEvent = Reflect.get(globalThis, 'WheelEvent') as new (
        type: string,
        init: unknown
      ) => Parameters<typeof surface.dispatchEvent>[0]
      surface.dispatchEvent(new BrowserWheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
        ctrlKey: true,
        deltaY: -100
      }))
    })
    if (fittedScale !== null) await expect(viewportScale).not.toHaveText(fittedScale)
    await window.getByRole('button', { name: '适合窗口' }).evaluate((button) => button.click())
    if (fittedScale !== null) {
      const initialFit = Number.parseInt(fittedScale, 10)
      await expect.poll(async () => Math.abs(Number.parseInt(await viewportScale.textContent() ?? '0', 10) - initialFit)).toBeLessThanOrEqual(1)
    }
    await viewportScale.evaluate((button: { click(): void }) => button.click())
    await expect(viewportScale).toHaveText('100%')
    await window.getByRole('button', { name: '适合窗口' }).evaluate((button) => button.click())

    const layerOptions = window.getByRole('listbox', { name: '图层' }).getByRole('option')
    const initialLayers = await layerOptions.count()
    await window.getByRole('button', { name: '导入图片' }).evaluate((button) => button.click())
    await expect(window.getByRole('dialog', { name: '选择图片用途' })).toBeVisible()
    await expect(window.getByRole('button', { name: '作为普通元素' })).toBeVisible()
    await expect(window.getByRole('button', { name: '设为画布背景' })).toBeVisible()
    await window.getByRole('button', { name: '取消', exact: true }).evaluate((button) => button.click())

    await window.getByRole('listbox', { name: '图层' }).getByText('主标题', { exact: true }).evaluate((button) => button.click())
    await window.getByRole('listbox', { name: '图层' }).getByText('构图光影', { exact: true }).evaluate((element) => {
      const BrowserMouseEvent = Reflect.get(globalThis, 'MouseEvent') as new (
        type: string,
        init: unknown
      ) => Parameters<typeof element.dispatchEvent>[0]
      element.dispatchEvent(new BrowserMouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }))
    })
    await window.getByRole('button', { name: '组合', exact: true }).evaluate((button) => button.click())
    await expect(layerOptions).toHaveCount(initialLayers + 1)
    await window.getByRole('tab', { name: /属性/ }).evaluate((button) => button.click())
    await window.getByRole('button', { name: '高级', exact: true }).evaluate((button) => button.click())
    const groupXField = window.locator('.compact-field').filter({ hasText: /^X$/ }).locator('input')
    const initialGroupX = await groupXField.inputValue()
    const nextGroupX = String(Number.parseFloat(initialGroupX) + 32)
    await groupXField.evaluate((input, value) => {
      const nativeSetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set
      nativeSetter?.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }, nextGroupX)
    await expect(groupXField).toHaveValue(nextGroupX)
    await window.getByLabel('撤销', { exact: true }).evaluate((button) => button.click())
    await expect(groupXField).toHaveValue(initialGroupX)
    await window.getByRole('tab', { name: /图层/ }).evaluate((button) => button.click())
    await window.getByRole('button', { name: '取消组合' }).evaluate((button) => button.click())
    await expect(layerOptions).toHaveCount(initialLayers)

    await window.getByRole('button', { name: '形状' }).evaluate((button) => button.click())
    await expect(layerOptions).toHaveCount(initialLayers + 1)
    await window.getByLabel('撤销', { exact: true }).evaluate((button) => button.click())
    await expect(layerOptions).toHaveCount(initialLayers)

    await window.evaluate(`(async () => {
      const canvas = document.createElement('canvas')
      canvas.width = 24
      canvas.height = 24
      const context = canvas.getContext('2d')
      context.fillStyle = '#7896B7'
      context.fillRect(0, 0, 24, 24)
      const blob = await new Promise((resolveBlob) => canvas.toBlob(resolveBlob, 'image/png'))
      if (blob === null) throw new Error('Could not create clipboard fixture.')
      const transfer = new DataTransfer()
      transfer.items.add(new File([blob], 'clipboard-fixture.png', { type: 'image/png' }))
      window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true }))
    })()`)
    await expect(layerOptions).toHaveCount(initialLayers + 1)
    await window.getByLabel('撤销', { exact: true }).evaluate((button) => button.click())
    await expect(layerOptions).toHaveCount(initialLayers)

    await window.evaluate(`(async () => {
      const canvas = document.createElement('canvas')
      canvas.width = 24
      canvas.height = 24
      const context = canvas.getContext('2d')
      context.fillStyle = '#A8B9CC'
      context.fillRect(0, 0, 24, 24)
      const blob = await new Promise((resolveBlob) => canvas.toBlob(resolveBlob, 'image/png'))
      if (blob === null) throw new Error('Could not create drop fixture.')
      const transfer = new DataTransfer()
      transfer.items.add(new File([blob], 'drop-fixture.png', { type: 'image/png' }))
      document.querySelector('.canvas-workspace')?.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }))
    })()`)
    await expect(layerOptions).toHaveCount(initialLayers + 1)
    await window.getByLabel('撤销', { exact: true }).evaluate((button) => button.click())
    await expect(layerOptions).toHaveCount(initialLayers)

    await window.getByRole('button', { name: '草图 B' }).evaluate((button) => button.click())
    const sketchSurface = window.getByTestId('canvas-stage').locator('.konvajs-content')
    const stageBox = await sketchSurface.boundingBox()
    if (stageBox === null) throw new Error('Canvas event surface is missing.')
    const sketchPath = [
      { x: stageBox.x + stageBox.width * 0.42, y: stageBox.y + stageBox.height * 0.42 },
      { x: stageBox.x + stageBox.width * 0.5, y: stageBox.y + stageBox.height * 0.54 },
      { x: stageBox.x + stageBox.width * 0.58, y: stageBox.y + stageBox.height * 0.46 }
    ]
    const dispatchSketchPointer = async (type: 'mousedown' | 'mousemove' | 'mouseup', point: { readonly x: number; readonly y: number }): Promise<void> => {
      await sketchSurface.evaluate((surface, event) => {
        const BrowserMouseEvent = Reflect.get(globalThis, 'MouseEvent') as new (
          type: string,
          init: unknown
        ) => Parameters<typeof surface.dispatchEvent>[0]
        surface.dispatchEvent(new BrowserMouseEvent(event.type, {
          bubbles: true,
          clientX: event.point.x,
          clientY: event.point.y,
          button: 0,
          buttons: event.type === 'mouseup' ? 0 : 1
        }))
      }, { type, point })
      await window.waitForTimeout(16)
    }
    await dispatchSketchPointer('mousedown', sketchPath[0]!)
    for (const point of sketchPath.slice(1)) await dispatchSketchPointer('mousemove', point)
    await dispatchSketchPointer('mouseup', sketchPath.at(-1)!)
    await expect(layerOptions).toHaveCount(initialLayers + 1)
    await expect(layerOptions.getByText('自由草图')).toBeVisible()
    await window.getByLabel('撤销', { exact: true }).evaluate((button) => button.click())
    await expect(layerOptions).toHaveCount(initialLayers)

    const fileInput = window.locator('input[type="file"]').last()
    await fileInput.setInputFiles(resolve('tests/visual/__screenshots__/m3-canvas-1024x700.png'))
    await expect(layerOptions).toHaveCount(initialLayers + 1)
    await expect(layerOptions.getByText('导入图片')).toBeVisible()
    await window.getByLabel('撤销', { exact: true }).evaluate((button) => button.click())
    await expect(layerOptions).toHaveCount(initialLayers)

    await layerOptions.getByText('蕨叶标本', { exact: true }).evaluate((button) => button.click())
    await window.getByRole('tab', { name: /属性/ }).evaluate((button) => button.click())
    await window.getByRole('button', { name: '高级', exact: true }).evaluate((button) => button.click())
    const xField = window.locator('.compact-field').filter({ hasText: /^X$/ }).locator('input')
    const initialX = await xField.inputValue()
    const nextX = String(Number.parseFloat(initialX) + 32)
    await xField.evaluate((input, value) => {
      const nativeSetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set
      nativeSetter?.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }, nextX)
    await expect(xField).toHaveValue(nextX)
    await window.getByLabel('撤销', { exact: true }).evaluate((button) => button.click())
    await expect(xField).toHaveValue(initialX)

    const exported = await window.evaluate(`(async () => {
      let captured = null
      const originalClick = HTMLAnchorElement.prototype.click
      HTMLAnchorElement.prototype.click = function captureExport() { captured = this.href }
      try {
        document.querySelector('.export-control > button')?.click()
        if (captured === null) throw new Error('Export did not produce a data URL.')
        const image = new Image()
        const loaded = new Promise((resolveLoaded, rejectLoaded) => {
          image.onload = () => resolveLoaded()
          image.onerror = () => rejectLoaded(new Error('Exported image could not be decoded.'))
        })
        image.src = captured
        await loaded
        const canvas = document.createElement('canvas')
        canvas.width = image.width
        canvas.height = image.height
        const context = canvas.getContext('2d')
        context?.drawImage(image, 0, 0)
        const pixel = context?.getImageData(20, 20, 1, 1).data
        const referenceOnlyPixel = context?.getImageData(512, 850, 1, 1).data
        return {
          mimePrefix: captured.slice(0, 22),
          width: image.width,
          height: image.height,
          topPixel: pixel === undefined ? [] : [...pixel],
          referenceOnlyPixel: referenceOnlyPixel === undefined ? [] : [...referenceOnlyPixel]
        }
      } finally {
        HTMLAnchorElement.prototype.click = originalClick
      }
    })()`)
    expect(exported).toEqual({
      mimePrefix: 'data:image/png;base64,',
      width: 1024,
      height: 1280,
      topPixel: [17, 23, 34, 255],
      referenceOnlyPixel: [17, 23, 34, 255]
    })

    const formatSelect = window.getByRole('combobox', { name: '导出格式' })
    for (const format of [
      { value: 'jpeg', prefix: 'data:image/jpeg;base64,' },
      { value: 'webp', prefix: 'data:image/webp;base64,' }
    ]) {
      await formatSelect.selectOption(format.value)
      if (format.value === 'jpeg') await expect(window.getByLabel('JPEG 背景色')).toBeVisible()
      const prefix = await window.evaluate(`(() => {
        let captured = null
        const originalClick = HTMLAnchorElement.prototype.click
        HTMLAnchorElement.prototype.click = function captureExport() { captured = this.href }
        try {
          document.querySelector('.export-control > button')?.click()
          return captured === null ? null : captured.slice(0, 23)
        } finally {
          HTMLAnchorElement.prototype.click = originalClick
        }
      })()`)
      expect(prefix).toBe(format.prefix)
    }

    await formatSelect.selectOption('png')
    await window.getByRole('tab', { name: /图层/ }).evaluate((button) => button.click())
    await window.locator('.layer-copy').filter({ hasText: '背景' }).first().click()
    await window.getByRole('button', { name: '隐藏背景' }).click()
    await stage.focus()
    await window.keyboard.press('Escape')
    await window.keyboard.press('Escape')
    await window.getByRole('tab', { name: /属性/ }).evaluate((button) => button.click())
    const transparentBackground = window.getByRole('checkbox', { name: /保留透明背景/ })
    await transparentBackground.evaluate((checkbox) => {
      if (!checkbox.checked) checkbox.click()
    })
    await expect(transparentBackground).toBeChecked()
    const transparentPixel = await window.evaluate(`(async () => {
      let captured = null
      const originalClick = HTMLAnchorElement.prototype.click
      HTMLAnchorElement.prototype.click = function captureExport() { captured = this.href }
      try {
        document.querySelector('.export-control > button')?.click()
        const image = new Image()
        const loaded = new Promise((resolveLoaded) => { image.onload = resolveLoaded })
        image.src = captured
        await loaded
        const canvas = document.createElement('canvas')
        canvas.width = image.width
        canvas.height = image.height
        const context = canvas.getContext('2d')
        context.drawImage(image, 0, 0)
        return [...context.getImageData(20, 20, 1, 1).data]
      } finally {
        HTMLAnchorElement.prototype.click = originalClick
      }
    })()`)
    expect(transparentPixel).toEqual([0, 0, 0, 0])

    const rendererCapabilities = await window.evaluate(() => {
      const rendererGlobal = globalThis as typeof globalThis & {
        readonly desktop: Record<string, unknown>
      }

      return {
        hasRequire: 'require' in rendererGlobal,
        hasProcess: 'process' in rendererGlobal,
        exposedMethods: Object.keys(rendererGlobal.desktop)
      }
    })
    expect(rendererCapabilities).toEqual({
      hasRequire: false,
      hasProcess: false,
      exposedMethods: [
        'getRuntimeInfo',
        'getAppearanceSettings',
        'setAppearanceSettings',
        'exportDiagnostics',
        'onAppearanceChanged',
        'listGenerationProviders',
        'listGenerationProfiles',
        'listGenerationJobs',
        'enqueueGeneration',
        'enqueueGenerationProfile',
        'previewGenerationReference',
        'cancelGeneration',
        'retryGeneration',
        'listGenerationResultFamilies',
        'setGenerationResultFavorite',
        'placeGenerationResult',
        'readGenerationAsset',
        'generateFromCanvas',
        'editFromCanvas',
        'getProviderSettings',
        'validateProviderConnection',
        'setProviderConfig',
        'setProviderExecutionPolicy',
        'setProviderSecret',
        'deleteProviderSecret',
        'listRecentProjects',
        'createProject',
        'openProject',
        'openRecentProject',
        'relocateRecentProject',
        'deleteRecentProject',
        'setProjectFavorite',
        'changeProjectLibraryLocation',
        'saveProjectAs',
        'importAsset',
        'getWorkspaceBootstrap',
        'saveProjectWorkContext',
        'onWindowClosing',
        'executeSceneCommands',
        'undoScene',
        'redoScene',
        'selectDesignDirection',
        'acceptDesignReview',
        'onSceneChanged',
        'getConversationSnapshot',
        'getAgentHarnessSnapshot',
        'getProjectKnowledge',
        'createProjectDirective',
        'updateProjectDirective',
        'createProjectMemory',
        'updateProjectMemory',
        'createMemoryCandidate',
        'resolveMemoryCandidate',
        'setOutboundPolicy',
        'replayAgentEvents',
        'startAgentRun',
        'inputAgentRun',
        'resolveTemporaryAgentTurn',
        'resumeAgentQueue',
        'onAgentEvent',
        'confirmAgentRun',
        'cancelAgentRun',
        'markActivityBatchUndone'
      ]
    })
  } finally {
    await app.close()
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
