import { randomUUID } from 'node:crypto'
import { open, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import sharp from 'sharp'
import {
  EXPORT_EXTENSIONS,
  MAX_EXPORT_BYTES,
  safeFileStem,
  type ExportFileChoice,
  type ExportImageWrite,
  type ExportPdfWrite,
  type ExportPsdWrite,
  type ExportTargetChoice,
  type ExportWriteResult,
  type PsdNode
} from '../../shared/artwork-export'
import { buildPdf } from './pdf-writer'
import { buildPsd, type PsdFontLookup } from './psd-writer'

/*
 * Saves what the export panel drew. Every place written to is one the
 * person picked in a system dialog: Main hands the page an opaque target
 * for it, a file target is good for one write, and a folder target only
 * ever adds new files to that folder, never replacing one already there.
 */

export interface ExportDialogs {
  saveFile(options: { readonly title: string; readonly defaultPath: string; readonly buttonLabel: string; readonly filters: readonly { readonly name: string; readonly extensions: readonly string[] }[] }): Promise<string | null>
  chooseFolder(options: { readonly title: string; readonly buttonLabel: string }): Promise<string | null>
}

type Target = { readonly kind: 'file'; readonly path: string } | { readonly kind: 'folder'; readonly path: string }

const FILTERS: Readonly<Record<ExportFileChoice['kind'], { readonly name: string; readonly extensions: readonly string[] }>> = {
  png: { name: 'PNG 图片', extensions: ['png'] },
  jpeg: { name: 'JPEG 图片', extensions: ['jpg', 'jpeg'] },
  webp: { name: 'WebP 图片', extensions: ['webp'] },
  psd: { name: 'Photoshop 文件', extensions: ['psd'] },
  pdf: { name: 'PDF 文件', extensions: ['pdf'] }
}

export class ExportError extends Error {}

function psdBytes(nodes: readonly PsdNode[]): number {
  return nodes.reduce((total, node) => total + (node.kind === 'group' ? psdBytes(node.children) : node.pixels.byteLength + (node.mask?.pixels.byteLength ?? 0)), 0)
}

export class ExportService {
  readonly #dialogs: ExportDialogs
  readonly #fonts: PsdFontLookup
  /** In end-to-end tests, the folder every choice lands in, with no dialog. */
  readonly #testDirectory: string | null
  readonly #targets = new Map<string, Target>()
  readonly #written = new Set<string>()

  constructor(dialogs: ExportDialogs, fonts: PsdFontLookup, testDirectory: string | null = null) {
    this.#dialogs = dialogs
    this.#fonts = fonts
    this.#testDirectory = testDirectory
  }

  async chooseFile(choice: ExportFileChoice): Promise<ExportTargetChoice> {
    const extension = EXPORT_EXTENSIONS[choice.kind]
    const name = `${safeFileStem(choice.suggestedName)}.${extension}`
    const chosen = this.#testDirectory !== null
      ? join(this.#testDirectory, name)
      : await this.#dialogs.saveFile({ title: '导出', defaultPath: name, buttonLabel: '导出', filters: [FILTERS[choice.kind]] })
    if (chosen === null || chosen === '') return { cancelled: true }
    const accepted = FILTERS[choice.kind].extensions.map((value) => `.${value}`)
    const path = accepted.includes(extname(chosen).toLowerCase()) ? chosen : `${chosen}.${extension}`
    return this.#remember({ kind: 'file', path })
  }

  async chooseFolder(): Promise<ExportTargetChoice> {
    const chosen = this.#testDirectory ?? await this.#dialogs.chooseFolder({ title: '选择导出到哪个文件夹', buttonLabel: '导出到这里' })
    if (chosen === null || chosen === '') return { cancelled: true }
    return this.#remember({ kind: 'folder', path: chosen })
  }

  #remember(target: Target): ExportTargetChoice {
    const id = randomUUID()
    this.#targets.set(id, target)
    return { cancelled: false, target: id, path: target.path }
  }

  async writeImage(input: ExportImageWrite): Promise<ExportWriteResult> {
    const raw = sharp(Buffer.from(input.pixels.buffer, input.pixels.byteOffset, input.pixels.byteLength), { raw: { width: input.width, height: input.height, channels: 4 }, limitInputPixels: false })
    const bytes = input.format === 'png'
      ? await raw.png({ compressionLevel: 6 }).toBuffer()
      : input.format === 'jpeg'
        // The page drew it over the chosen background; full colour resolution keeps small text crisp.
        ? await raw.flatten({ background: '#ffffff' }).jpeg({ quality: 94, chromaSubsampling: '4:4:4' }).toBuffer()
        : await raw.webp({ quality: 94 }).toBuffer()
    return this.#write(input.target, input.fileName, EXPORT_EXTENSIONS[input.format], bytes)
  }

  async writePdf(input: ExportPdfWrite): Promise<ExportWriteResult> {
    const picture = input.transparent
      ? { kind: 'rgba' as const, pixels: input.pixels, width: input.width, height: input.height }
      : {
          kind: 'jpeg' as const,
          bytes: new Uint8Array(await sharp(Buffer.from(input.pixels.buffer, input.pixels.byteOffset, input.pixels.byteLength), { raw: { width: input.width, height: input.height, channels: 4 }, limitInputPixels: false })
            .flatten({ background: '#ffffff' })
            .jpeg({ quality: 95, chromaSubsampling: '4:4:4' })
            .toBuffer()),
          width: input.width,
          height: input.height
        }
    const bytes = buildPdf({ title: input.title, width: input.pageWidth, height: input.pageHeight, picture })
    return this.#write(input.target, undefined, 'pdf', bytes)
  }

  async writePsd(input: ExportPsdWrite): Promise<ExportWriteResult> {
    if (psdBytes(input.document.children) + input.document.composite.byteLength > MAX_EXPORT_BYTES) {
      throw new ExportError('这个作品的图层太多太大，一个 PSD 装不下。可以先合并一些图层，或把画布改小一点再导出。')
    }
    let bytes: Uint8Array
    try {
      bytes = await buildPsd(input.document, this.#fonts)
    } catch (error) {
      throw new ExportError(`PSD 没写出来：${error instanceof Error ? error.message : String(error)}`)
    }
    return this.#write(input.target, undefined, 'psd', bytes)
  }

  /** Shows a file this run exported in the system's file manager; nothing else. */
  canReveal(path: string): boolean {
    return this.#written.has(path)
  }

  async #write(targetId: string, fileName: string | undefined, extension: string, bytes: Uint8Array): Promise<ExportWriteResult> {
    const target = this.#targets.get(targetId)
    if (target === undefined) throw new ExportError('这个保存位置已经用过或失效了，请重新导出。')
    if (target.kind === 'file') {
      if (fileName !== undefined) throw new ExportError('导出到单个文件时不能另起文件名。')
      this.#targets.delete(targetId)
      await writeFile(target.path, bytes)
      this.#written.add(target.path)
      return { path: target.path }
    }
    if (fileName === undefined) throw new ExportError('导出到文件夹时要给每个文件起名。')
    const path = await this.#createNew(target.path, safeFileStem(fileName), extension, bytes)
    this.#written.add(path)
    return { path }
  }

  /** Writes a file that did not exist: the name as given, then 「name (2)」 and so on. */
  async #createNew(folder: string, stem: string, extension: string, bytes: Uint8Array): Promise<string> {
    for (let attempt = 1; attempt <= 999; attempt += 1) {
      const path = join(folder, attempt === 1 ? `${stem}.${extension}` : `${stem} (${attempt}).${extension}`)
      let file
      try {
        file = await open(path, 'wx')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
        throw error
      }
      try {
        await file.writeFile(bytes)
      } finally {
        await file.close()
      }
      return path
    }
    throw new ExportError(`文件夹里已经有太多叫「${stem}」的文件了，换个文件夹再试。`)
  }
}
