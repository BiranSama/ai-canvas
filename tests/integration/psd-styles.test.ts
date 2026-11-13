import { readPsd, writePsdUint8Array, type Layer } from 'ag-psd'
import { describe, expect, it } from 'vitest'
import { blendModeSchema, type LayerStyle } from '../../src/domain'
import { buildPsd } from '../../src/main/export/psd-writer'
import { readPsdForImport } from '../../src/main/psd/psd-import'
import { fromPsdEffects, toPsdEffects } from '../../src/main/psd/psd-styles'
import type { PsdDocument, PsdLayer } from '../../src/shared/artwork-export'

/*
 * Layer styles, clipping masks and blend modes go out to Photoshop as its
 * own layer effects, clipping and modes, and come back as they went:
 * written to a real PSD and read again with ag-psd.
 */

/** Every style, each with settings away from where it opens. */
const STYLE: LayerStyle = {
  dropShadow: { enabled: true, blendMode: 'multiply', color: '#102030', opacity: 0.6, angle: 135, distance: 14, spread: 20, size: 12 },
  innerShadow: { enabled: false, blendMode: 'color-burn', color: '#200000', opacity: 0.4, angle: -45, distance: 6, choke: 10, size: 4 },
  outerGlow: { enabled: true, blendMode: 'screen', color: '#FFE080', opacity: 0.8, spread: 5, size: 18 },
  stroke: { enabled: true, size: 5, position: 'inside', color: '#FFFFFF', opacity: 0.9 },
  colorOverlay: { enabled: true, blendMode: 'color', color: '#2060C0', opacity: 0.4 },
  gradientOverlay: { enabled: true, blendMode: 'overlay', opacity: 0.7, style: 'radial', angle: 30, scale: 80, reverse: true, stops: [{ offset: 0, color: '#FF0000' }, { offset: 0.4, color: '#00FF00' }, { offset: 1, color: '#0000FF' }] }
}

const fonts = async (): Promise<{ postScriptName: string; fauxBold: boolean }> => ({ postScriptName: 'Arial', fauxBold: false })

function layer(name: string, change: Partial<PsdLayer> = {}): PsdLayer {
  return { kind: 'layer', name, hidden: false, opacity: 1, blendMode: 'normal', left: 0, top: 0, width: 4, height: 4, pixels: new Uint8Array(64).fill(200), mask: null, text: null, ...change }
}

function documentOf(children: PsdDocument['children']): PsdDocument {
  return { width: 4, height: 4, composite: new Uint8Array(64), children }
}

describe('layer styles, clipping and blend modes in a PSD', () => {
  it('come back from Photoshop layer effects as they went', async () => {
    const bytes = await buildPsd(documentOf([layer('样式', { style: STYLE })]), fonts)
    const written = readPsd(bytes, { skipLayerImageData: true, skipCompositeImageData: true }).children![0]!
    expect(written.effects?.dropShadow?.[0]).toMatchObject({ enabled: true, blendMode: 'multiply', angle: 135, distance: { value: 14 }, choke: { value: 20 }, size: { value: 12 }, useGlobalLight: false, layerConceals: true })
    expect(written.effects?.innerShadow?.[0]?.enabled).toBe(false)
    expect(written.effects?.stroke?.[0]).toMatchObject({ position: 'inside', fillType: 'color', size: { value: 5 } })
    expect(written.effects?.gradientOverlay?.[0]).toMatchObject({ type: 'radial', reverse: true, scale: 80, align: true })
    const back = fromPsdEffects(written.effects)
    expect(back.dropped).toEqual([])
    expect(back.approximated).toEqual([])
    expect(back.style).toEqual(STYLE)
    // As the project opens it.
    const opened = await readPsdForImport(bytes)
    expect(opened.layers[0]).toMatchObject({ kind: 'pixels', style: STYLE })
  })

  it('says which of Photoshop\'s effects did not come, and brings the rest', () => {
    const shadow = toPsdEffects({ dropShadow: STYLE.dropShadow })!.dropShadow![0]!
    const back = fromPsdEffects({
      dropShadow: [shadow, { ...shadow, distance: { units: 'Pixels', value: 40 } }],
      bevel: { enabled: true }, satin: { enabled: true }, innerGlow: { enabled: true }, patternOverlay: { enabled: true },
      stroke: [{ enabled: true, size: { units: 'Pixels', value: 3 }, position: 'outside', fillType: 'gradient', opacity: 1 }],
      solidFill: [{ enabled: true, blendMode: 'linear burn', color: { r: 10, g: 20, b: 30 }, opacity: 1 }]
    })
    expect(back.style?.dropShadow?.distance).toBe(14)
    expect(back.dropped).toEqual(['第二个起的投影', '内发光', '斜面和浮雕', '光泽', '图案叠加'])
    expect([...back.approximated].sort()).toEqual(['描边', '颜色叠加'].sort())
    expect(back.style?.colorOverlay).toMatchObject({ blendMode: 'normal', color: '#0A141E' })
    // With every effect switched off in Photoshop, they come switched off.
    expect(fromPsdEffects({ disabled: true, dropShadow: [shadow] }).style?.dropShadow?.enabled).toBe(false)
    // Photoshop's 缩放效果 scales the sizes.
    expect(fromPsdEffects({ scale: 2, dropShadow: [shadow] }).style?.dropShadow).toMatchObject({ distance: 28, size: 24 })
  })

  it('writes guides and a text\'s flip and skew, and opens the guides again', async () => {
    const text = {
      content: '晨雾', orientation: 'horizontal' as const, fontFamily: 'Arial', fontWeight: 400, fontSize: 24, color: '#202020', fillOpacity: 1, letterSpacing: 0, lineHeight: 1.2, align: 'start' as const,
      box: { x: 1, y: 1, width: 4, height: 4 }, rotation: 90, textHeight: 3, stroke: null, shadow: null,
      // Mirrored left to right in its box: x' = 4 - x.
      shear: [-1, 0, 0, 1, 4, 0] as [number, number, number, number, number, number]
    }
    const bytes = await buildPsd({ ...documentOf([layer('标题', { text })]), guides: [{ axis: 'x', position: 2 }, { axis: 'y', position: 3.5 }] }, fonts)
    const psd = readPsd(bytes, { skipLayerImageData: true, skipCompositeImageData: true })
    expect(psd.imageResources?.gridAndGuidesInformation?.guides).toEqual([{ location: 2, direction: 'vertical' }, { location: 3.5, direction: 'horizontal' }])
    // Turned a quarter after the flip, about the box's top-left corner (1, 1): [xx, xy, yx, yy, tx, ty].
    const transform = psd.children![0]!.text!.transform!
    expect(transform.map((value) => Math.round(value * 1e6) / 1e6 + 0)).toEqual([0, -1, -1, 0, 1, 5])
    const opened = await readPsdForImport(bytes)
    expect(opened.guides).toEqual([{ axis: 'x', position: 2 }, { axis: 'y', position: 3.5 }])
  })

  it('keeps a text layer\'s own stroke and shadow next to its layer styles', async () => {
    const text = {
      content: '晨雾', orientation: 'horizontal' as const, fontFamily: 'Arial', fontWeight: 400, fontSize: 24, color: '#202020', fillOpacity: 1, letterSpacing: 0, lineHeight: 1.2, align: 'start' as const,
      box: { x: 0, y: 0, width: 4, height: 4 }, rotation: 0, textHeight: 3, stroke: { color: '#FF0000', width: 2, opacity: 1 }, shadow: null
    }
    const written = readPsd(await buildPsd(documentOf([layer('标题', { text, style: { stroke: STYLE.stroke } })]), fonts), { skipLayerImageData: true, skipCompositeImageData: true }).children![0]!
    expect(written.effects?.stroke?.map((stroke) => stroke.position)).toEqual(['center', 'inside'])
  })

  it('writes clipping masks as Photoshop\'s and opens them clipped again', async () => {
    const bytes = await buildPsd(documentOf([
      layer('底'),
      layer('剪贴的图', { clipping: true, blendMode: 'overlay' }),
      { kind: 'adjustment', name: '剪贴的反相', hidden: false, opacity: 0.5, blendMode: 'normal', clipping: true, settings: { kind: 'invert' }, mask: null },
      layer('上面的图')
    ]), fonts)
    const written = readPsd(bytes, { skipLayerImageData: true, skipCompositeImageData: true }).children as Layer[]
    expect(written.map((child) => child.clipping === true)).toEqual([false, true, true, false])
    const opened = await readPsdForImport(bytes)
    expect(opened.layers.map((child) => [child.name, child.clipped])).toEqual([['底', false], ['剪贴的图', true], ['剪贴的反相', true], ['上面的图', false]])
    expect(opened.approximations.join('；')).not.toContain('剪贴蒙版')
  })

  it('keeps an adjustment clipped to a styled base as a layer above it, so it goes on after the styles', async () => {
    const bytes = await buildPsd(documentOf([
      layer('底', { style: { colorOverlay: { enabled: true, blendMode: 'normal', color: '#FF0000', opacity: 1 } } }),
      { kind: 'adjustment', name: '反相', hidden: false, opacity: 1, blendMode: 'normal', clipping: true, settings: { kind: 'invert' }, mask: null }
    ]), fonts)
    const opened = await readPsdForImport(bytes)
    expect(opened.layers.map((child) => [child.kind, child.name, child.clipped])).toEqual([['pixels', '底', false], ['adjustment', '反相', true]])
    expect(opened.layers[0]?.kind === 'pixels' && opened.layers[0].adjustments).toEqual([])
  })

  it('writes styles that are switched off, and opens them switched off', async () => {
    const off: LayerStyle = { stroke: { ...STYLE.stroke!, enabled: false }, dropShadow: { ...STYLE.dropShadow!, enabled: false } }
    const opened = await readPsdForImport(await buildPsd(documentOf([layer('关着的', { style: off })]), fonts))
    expect(opened.layers[0]).toMatchObject({ kind: 'pixels', style: off })
  })

  it('carries all sixteen blend modes', async () => {
    const modes = blendModeSchema.options
    const bytes = writePsdUint8Array({
      width: 4, height: 4,
      children: modes.map((mode, index) => ({ name: `层 ${index}`, left: 0, top: 0, right: 4, bottom: 4, imageData: { width: 4, height: 4, data: new Uint8ClampedArray(64).fill(200) }, blendMode: toPsd(mode) }))
    }, { noBackground: true })
    const opened = await readPsdForImport(bytes)
    expect(opened.layers.map((child) => child.blendMode)).toEqual([...modes])
    expect(opened.approximations.join('；')).not.toContain('混合模式')
  })
})

function toPsd(mode: (typeof blendModeSchema.options)[number]): NonNullable<Layer['blendMode']> {
  return mode === 'color-burn' ? 'color burn' : mode === 'color-dodge' ? 'color dodge' : mode === 'soft-light' ? 'soft light' : mode === 'hard-light' ? 'hard light' : mode
}
