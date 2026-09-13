import { describe, expect, it } from 'vitest'
import { calculateOutputSize, createCanvasResizeCommands, parseAspectRatio } from '../../src/domain'
import { createNightVeilScene } from '../../src/renderer/src/fixtures/night-veil'

describe('aspect ratio value and canvas resize strategies', () => {
  it('accepts separators and decimals, then emits a bounded simplified ratio', () => {
    expect(parseAspectRatio('7：5').value).toEqual({ width: 7, height: 5 })
    expect(parseAspectRatio('1.5 x 1').value).toEqual({ width: 3, height: 2 })
    expect(parseAspectRatio('0:1').error).not.toBeNull()
    expect(parseAspectRatio('wide').error).not.toBeNull()
  })

  it('projects a custom ratio to an exact local output size', () => {
    expect(calculateOutputSize({ width: 7, height: 5 }, 1400)).toEqual({ width: 1400, height: 1000 })
    expect(calculateOutputSize({ width: 4, height: 5 }, 1280)).toEqual({ width: 1024, height: 1280 })
  })

  it('creates one atomic command list for each resize strategy', () => {
    const scene = createNightVeilScene()
    const nextCanvas = { ...scene.canvas, aspectWidth: 3, aspectHeight: 2, outputWidth: 1280, outputHeight: 853 }
    expect(createCanvasResizeCommands(scene, nextCanvas, 'keep-position')).toHaveLength(1)
    expect(createCanvasResizeCommands(scene, nextCanvas, 'keep-center').length).toBeGreaterThan(1)
    expect(createCanvasResizeCommands(scene, nextCanvas, 'fit-content').length).toBeGreaterThan(1)
  })
})
