import { readPsd, type Layer } from 'ag-psd'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'
import '../../src/main/psd/psd-import'
import { ExportError, ExportService, type ExportDialogs } from '../../src/main/export/export-service'
import { buildPdf } from '../../src/main/export/pdf-writer'
import { buildPsd, type PsdFontLookup } from '../../src/main/export/psd-writer'
import { exportPsdWriteSchema, type PsdDocument, type PsdLayer } from '../../src/shared/artwork-export'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function folder(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'export-'))
  roots.push(root)
  return root
}

function solid(width: number, height: number, rgba: readonly [number, number, number, number]): Uint8Array<ArrayBuffer> {
  const pixels = new Uint8Array(width * height * 4)
  for (let index = 0; index < pixels.length; index += 4) pixels.set(rgba, index)
  return pixels
}

/** Each object's offset in the cross-reference table points at the object. */
function checkXref(pdf: Buffer): void {
  const text = pdf.toString('latin1')
  const start = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(text)![1])
  const table = text.slice(start).split('\n')
  expect(table[0]).toBe('xref')
  const count = Number(table[1]!.split(' ')[1])
  for (let id = 1; id < count; id += 1) {
    const offset = Number(table[2 + id]!.slice(0, 10))
    expect(text.slice(offset, offset + `${id} 0 obj`.length)).toBe(`${id} 0 obj`)
  }
}

describe('PDF writer', () => {
  it('puts one JPEG over the whole page, with the title readable in Chinese', async () => {
    const jpeg = new Uint8Array(await sharp({ create: { width: 40, height: 50, channels: 3, background: '#C04030' } }).jpeg().toBuffer())
    const pdf = Buffer.from(buildPdf({ title: '咖啡店海报', width: 595.276, height: 744.094, picture: { kind: 'jpeg', bytes: jpeg, width: 40, height: 50 }, createdAt: new Date('2026-11-05T08:00:00Z') }))
    const text = pdf.toString('latin1')
    expect(text.startsWith('%PDF-1.4')).toBe(true)
    expect(text).toContain('/MediaBox [0 0 595.276 744.094]')
    expect(text).toContain('/Width 40 /Height 50 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode')
    expect(text).toContain('/Title <FEFF549655615E976D7762A5>')
    expect(text).toContain('(D:20261105080000Z)')
    expect(text).not.toContain('/SMask')
    checkXref(pdf)
  })

  it('keeps transparency with a soft mask', () => {
    const pixels = new Uint8Array([255, 0, 0, 255, 0, 0, 255, 0])
    const pdf = Buffer.from(buildPdf({ title: 't', width: 100, height: 50, picture: { kind: 'rgba', pixels, width: 2, height: 1 } }))
    const text = pdf.toString('latin1')
    expect(text).toContain('/Filter /FlateDecode /SMask 7 0 R')
    expect(text).toContain('/ColorSpace /DeviceGray')
    checkXref(pdf)
  })
})

const fonts: PsdFontLookup = async (family, weight) => ({ postScriptName: `${family.replace(/\s+/g, '')}${weight >= 600 ? '-Bold' : ''}`, fauxBold: false })

function layer(name: string, change: Partial<PsdLayer> = {}): PsdLayer {
  return { kind: 'layer', name, hidden: false, opacity: 1, blendMode: 'normal', left: 0, top: 0, width: 2, height: 2, pixels: solid(2, 2, [10, 20, 30, 255]), mask: null, text: null, ...change }
}

describe('PSD writer', () => {
  it('writes layers, nested groups, masks and editable text that read back as they were', async () => {
    const mask = new Uint8Array([255, 0, 0, 255])
    const document: PsdDocument = {
      width: 8,
      height: 6,
      composite: solid(8, 6, [200, 190, 180, 255]),
      children: [
        layer('背景色', { width: 8, height: 6, pixels: solid(8, 6, [250, 250, 247, 255]) }),
        {
          kind: 'group', name: '标题组', hidden: false, opacity: 1, children: [
            layer('色块', { left: 3, top: 2, blendMode: 'multiply', opacity: 0.5, mask: { left: 3, top: 2, width: 2, height: 2, pixels: mask, disabled: true } }),
            { kind: 'group', name: '里面', hidden: true, opacity: 1, children: [layer('藏起来', { hidden: true })] }
          ]
        },
        layer('标题', {
          left: 1, top: 1,
          text: {
            content: '秋日\n拿铁', orientation: 'horizontal', fontFamily: 'Microsoft YaHei', fontWeight: 700, fontSize: 48, color: '#3A2A20',
            letterSpacing: 4.8, lineHeight: 1.2, align: 'center', box: { x: 1, y: 1, width: 6, height: 4 }, rotation: 0, textHeight: 2,
            stroke: { color: '#FFFFFF', width: 3 }, shadow: { color: '#000000', blur: 6, opacity: 0.62 }
          }
        })
      ]
    }
    // What the page sends passes the schema Main checks it with.
    expect(exportPsdWriteSchema.safeParse({ target: '00000000-0000-4000-8000-000000000000', document }).success).toBe(true)
    const psd = readPsd(await buildPsd(document, fonts), { useImageData: true })
    expect(psd.width).toBe(8)
    expect(psd.height).toBe(6)
    const names = (layers: readonly Layer[] | undefined): unknown[] => (layers ?? []).map((item) => item.children === undefined ? item.name : { [item.name!]: names(item.children) })
    expect(names(psd.children)).toEqual(['背景色', { 标题组: ['色块', { 里面: ['藏起来'] }] }, '标题'])
    const group = psd.children![1]!
    const block = group.children![0]!
    expect(block).toMatchObject({ blendMode: 'multiply', left: 3, top: 2, right: 5, bottom: 4 })
    expect(block.opacity).toBeCloseTo(0.5, 2)
    expect(block.mask).toMatchObject({ left: 3, top: 2, right: 5, bottom: 4, defaultColor: 0, disabled: true })
    expect([...block.mask!.imageData!.data].filter((_value, index) => index % 4 === 0)).toEqual([255, 0, 0, 255])
    expect(group.children![1]).toMatchObject({ hidden: true })
    const title = psd.children![2]!
    expect(title.text?.text).toBe('秋日\n拿铁')
    expect(title.text?.style?.font?.name).toBe('MicrosoftYaHei-Bold')
    expect(title.text?.style?.fontSize).toBe(48)
    expect(title.text?.style?.tracking).toBe(100)
    expect(title.text?.style?.leading).toBeCloseTo(57.6)
    expect(title.text?.paragraphStyle?.justification).toBe('center')
    expect(title.effects?.stroke?.[0]).toMatchObject({ enabled: true, position: 'center', size: { units: 'Pixels', value: 3 } })
    expect(title.effects?.dropShadow?.[0]?.opacity).toBeCloseTo(0.62, 2)
    expect([...psd.imageData!.data.slice(0, 4)]).toEqual([200, 190, 180, 255])
  })
})

class TestDialogs implements ExportDialogs {
  file: string | null = null
  folder: string | null = null
  async saveFile(): Promise<string | null> { return this.file }
  async chooseFolder(): Promise<string | null> { return this.folder }
}

describe('export service', () => {
  it('writes once where the person chose, adding the extension it needs', async () => {
    const root = await folder()
    const dialogs = new TestDialogs()
    dialogs.file = join(root, '海报')
    const service = new ExportService(dialogs, fonts)
    const choice = await service.chooseFile({ suggestedName: '海报', kind: 'png' })
    expect(choice).toMatchObject({ cancelled: false, path: join(root, '海报.png') })
    if (choice.cancelled) return
    const written = await service.writeImage({ target: choice.target, format: 'png', width: 2, height: 2, pixels: solid(2, 2, [1, 2, 3, 255]) })
    expect(written.path).toBe(join(root, '海报.png'))
    expect((await sharp(await readFile(written.path)).metadata()).format).toBe('png')
    expect(service.canReveal(written.path)).toBe(true)
    expect(service.canReveal(join(root, 'other.png'))).toBe(false)
    // The target was for one file.
    await expect(service.writeImage({ target: choice.target, format: 'png', width: 2, height: 2, pixels: solid(2, 2, [1, 2, 3, 255]) })).rejects.toThrow(ExportError)
    dialogs.file = null
    expect(await service.chooseFile({ suggestedName: '海报', kind: 'pdf' })).toEqual({ cancelled: true })
  })

  it('encodes JPEG and WebP, and refuses a target it never gave', async () => {
    const root = await folder()
    const service = new ExportService(new TestDialogs(), fonts, root)
    for (const format of ['jpeg', 'webp'] as const) {
      const choice = await service.chooseFile({ suggestedName: 'a', kind: format })
      if (choice.cancelled) throw new Error('no dialog in this test')
      const { path } = await service.writeImage({ target: choice.target, format, width: 4, height: 4, pixels: solid(4, 4, [200, 100, 50, 255]) })
      expect((await sharp(await readFile(path)).metadata()).format).toBe(format)
    }
    await expect(service.writePdf({ target: '00000000-0000-4000-8000-000000000000', title: 'x', pageWidth: 10, pageHeight: 10, width: 1, height: 1, transparent: false, pixels: solid(1, 1, [0, 0, 0, 255]) })).rejects.toThrow('失效')
  })

  it('only ever adds new files to a chosen folder', async () => {
    const root = await folder()
    await writeFile(join(root, '海报-横幅-1920x1080.png'), 'already here')
    const dialogs = new TestDialogs()
    dialogs.folder = root
    const service = new ExportService(dialogs, fonts)
    const choice = await service.chooseFolder()
    if (choice.cancelled) throw new Error('chosen above')
    const pixels = solid(2, 2, [9, 9, 9, 255])
    const first = await service.writeImage({ target: choice.target, fileName: '海报-横幅-1920x1080', format: 'png', width: 2, height: 2, pixels })
    const second = await service.writeImage({ target: choice.target, fileName: '海报-横幅-1920x1080', format: 'png', width: 2, height: 2, pixels })
    expect(first.path).toBe(join(root, '海报-横幅-1920x1080 (2).png'))
    expect(second.path).toBe(join(root, '海报-横幅-1920x1080 (3).png'))
    expect(await readFile(join(root, '海报-横幅-1920x1080.png'), 'utf8')).toBe('already here')
    // A file name that tries to leave the folder stays inside it.
    const escaped = await service.writeImage({ target: choice.target, fileName: '../outside', format: 'png', width: 2, height: 2, pixels })
    expect(escaped.path.startsWith(root)).toBe(true)
    await expect(service.writeImage({ target: choice.target, format: 'png', width: 2, height: 2, pixels })).rejects.toThrow('起名')
  })

  it('writes a PSD and a PDF', async () => {
    const root = await folder()
    const service = new ExportService(new TestDialogs(), fonts, root)
    const psdChoice = await service.chooseFile({ suggestedName: '作品', kind: 'psd' })
    const pdfChoice = await service.chooseFile({ suggestedName: '作品', kind: 'pdf' })
    if (psdChoice.cancelled || pdfChoice.cancelled) throw new Error('no dialog in this test')
    const psd = await service.writePsd({ target: psdChoice.target, document: { width: 2, height: 2, composite: solid(2, 2, [1, 1, 1, 255]), children: [layer('一层')] } })
    expect(readPsd(await readFile(psd.path), { skipLayerImageData: true, skipCompositeImageData: true }).children?.map((item) => item.name)).toEqual(['一层'])
    const pdf = await service.writePdf({ target: pdfChoice.target, title: '作品', pageWidth: 72, pageHeight: 72, width: 2, height: 2, transparent: false, pixels: solid(2, 2, [255, 0, 0, 255]) })
    expect((await readFile(pdf.path)).toString('latin1', 0, 8)).toBe('%PDF-1.4')
  })
})
