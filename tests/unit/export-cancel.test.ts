import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMerchantExampleScene } from '../../src/renderer/src/fixtures/merchant-examples'

/*
 * An export cancelled at its last step, after the picture is drawn and
 * before Main is asked to write, saves nothing.
 */

const drawing = vi.hoisted(() => ({ onRender: (): void => undefined, renders: 0 }))

vi.mock('../../src/renderer/src/canvas/artwork-render', () => ({
  ArtworkSession: {
    prepare: async () => ({
      render: ({ width, height }: { width: number; height: number }) => {
        drawing.renders += 1
        drawing.onRender()
        return { width, height }
      },
      dispose: () => undefined
    })
  },
  canvasPixels: (canvas: { width: number; height: number }) => {
    const data = new Uint8ClampedArray(canvas.width * canvas.height * 4)
    for (let index = 3; index < data.length; index += 4) data[index] = 255
    return { width: canvas.width, height: canvas.height, data }
  }
}))

const { exportImage, exportPsd } = await import('../../src/renderer/src/export/export-artwork')

const desktop = {
  chooseExportFile: vi.fn(async () => ({ cancelled: false as const, target: '00000000-0000-4000-8000-000000000000', path: '/out/a' })),
  writeExportImage: vi.fn(async () => ({ path: '/out/a.png' })),
  writeExportPsd: vi.fn(async () => ({ path: '/out/a.psd' }))
}

beforeEach(() => {
  drawing.renders = 0
  drawing.onRender = () => undefined
  for (const mock of Object.values(desktop)) mock.mockClear()
  Object.defineProperty(window, 'desktop', { configurable: true, value: desktop })
})

describe('cancelling an export at its last step', () => {
  // A small canvas keeps the fake pixels small.
  const scene = (() => {
    const coffee = createMerchantExampleScene('coffee-poster')
    return { ...coffee, canvas: { ...coffee.canvas, outputWidth: 64, outputHeight: 80 } }
  })()

  it('writes no picture', async () => {
    const controller = new AbortController()
    drawing.onRender = () => controller.abort()
    await expect(exportImage(scene, '海报', { format: 'png', scale: 1, jpegBackground: '#FFFFFF' }, controller.signal, () => undefined)).rejects.toMatchObject({ name: 'AbortError' })
    expect(desktop.writeExportImage).not.toHaveBeenCalled()
  })

  it('writes no PSD when cancelled while the composite is drawn', async () => {
    const controller = new AbortController()
    let layers = 0
    const total = scene.elements.filter((element) => element.type !== 'placeholder').length
    // Every layer is drawn, then the composite last: cancel during that one.
    drawing.onRender = () => {
      layers += 1
      if (layers > total) controller.abort()
    }
    await expect(exportPsd(scene, '海报', { editableText: false }, controller.signal, () => undefined)).rejects.toMatchObject({ name: 'AbortError' })
    expect(drawing.renders).toBeGreaterThan(total)
    expect(desktop.writeExportPsd).not.toHaveBeenCalled()
  })
})
