import { describe, expect, it } from 'vitest'
import { exportFileName, safeFileStem } from '../../src/shared/artwork-export'
import { pdfLayout, pdfPageFits, pdfTooLarge, printedResolution, scaledSize, SIZE_PRESETS, validExportSize } from '../../src/shared/export-presets'

describe('export sizes and pages', () => {
  it('scales the picture up to the edge limit and no further', () => {
    expect(scaledSize(1080, 1350, 2)).toEqual({ width: 2160, height: 2700, scale: 2 })
    const capped = scaledSize(8000, 6000, 3)
    expect(capped.width).toBe(16_384)
    expect(capped.scale).toBeCloseTo(16_384 / 8000)
  })

  it('accepts sizes the canvas can have', () => {
    expect(validExportSize(64, 16_384)).toBe(true)
    expect(validExportSize(63, 100)).toBe(false)
    expect(validExportSize(100.5, 100)).toBe(false)
    expect(SIZE_PRESETS.every((preset) => validExportSize(preset.width, preset.height))).toBe(true)
  })

  it('makes a screen PDF page the canvas at 96 pixels an inch', () => {
    expect(pdfLayout({ outputWidth: 960, outputHeight: 1200 }, { kind: 'screen' })).toMatchObject({ pageWidth: 720, pageHeight: 900, width: 960, height: 1200, dpi: null })
  })

  it('prints at 300 DPI on the chosen width, the height by the canvas ratio', () => {
    const a4 = pdfLayout({ outputWidth: 1024, outputHeight: 1280 }, { kind: 'print', widthMm: 210 })
    expect(a4.pageWidth).toBeCloseTo(595.276, 2)
    expect(a4.heightMm).toBeCloseTo(262.5, 3)
    expect(a4).toMatchObject({ width: 2480, height: 3100, dpi: 300 })
    // Past the edge limit the resolution drops, and says so.
    const poster = pdfLayout({ outputWidth: 1000, outputHeight: 3000 }, { kind: 'print', widthMm: 594 })
    expect(Math.max(poster.width, poster.height)).toBeLessThanOrEqual(16_384)
    expect(poster.dpi).toBeLessThan(300)
  })

  it('refuses a page past what a PDF can hold, and says how wide this picture can go', () => {
    const canvas = { outputWidth: 1024, outputHeight: 1280 }
    const huge = pdfLayout(canvas, { kind: 'print', widthMm: 5000 })
    expect(pdfPageFits(huge)).toBe(false)
    expect(pdfTooLarge(huge)).toContain('宽度最多 4064 mm')
    expect(pdfPageFits(pdfLayout(canvas, { kind: 'print', widthMm: 4064 }))).toBe(true)
    expect(pdfPageFits(pdfLayout(canvas, { kind: 'screen' }))).toBe(true)
  })

  it('finds images that would print soft', () => {
    const page = { widthMm: 210, heightMm: 297 }
    const half = { fit: 'cover' as const, crop: { width: 1, height: 1 }, transform: { width: 0.5, height: 0.5 } }
    // Half an A4 width is 105 mm ≈ 4.13 in: 1240 pixels across give about 300 DPI.
    expect(printedResolution({ width: 1240, height: 1754 }, half, page)).toBeCloseTo(300, -1)
    expect(printedResolution({ width: 400, height: 400 }, half, page)).toBeLessThan(150)
    // Fitting inside uses the roomier direction; a crop uses fewer of the image's pixels.
    expect(printedResolution({ width: 1240, height: 400 }, { ...half, fit: 'contain' }, page)).toBeCloseTo(300, -1)
    expect(printedResolution({ width: 1240, height: 1754 }, { ...half, crop: { width: 0.5, height: 0.5 } }, page)).toBeCloseTo(150, -1)
  })

  it('names files the way every system accepts', () => {
    expect(safeFileStem('  春季/新品: 海报?  ')).toBe('春季-新品- 海报-')
    expect(safeFileStem('...')).toBe('未命名作品')
    expect(exportFileName('咖啡店海报', 'jpeg')).toBe('咖啡店海报.jpg')
    expect(exportFileName('咖啡店海报', 'psd')).toBe('咖啡店海报.psd')
  })
})
