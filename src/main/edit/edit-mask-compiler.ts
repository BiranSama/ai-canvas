import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import type { NormalizedTransform, Scene, SceneElement } from '../../domain'
import type { AssetStore } from '../storage/asset-store'
import type { AssetMetadata } from '../storage/project-repository'

interface Point {
  readonly x: number
  readonly y: number
}

type MaskElement = Extract<SceneElement, { readonly type: 'mask' }>
type ImageElement = Extract<SceneElement, { readonly type: 'image' }>

export interface EditMaskCompilation {
  readonly id: string
  readonly asset: AssetMetadata
  readonly width: number
  readonly height: number
  readonly contributingMaskIds: readonly string[]
}

export interface EditMaskCompilerOptions {
  readonly assetStore: AssetStore
  readonly stagingDirectory: string
  readonly idFactory?: () => string
}

function rotate(point: Point, center: Point, degrees: number): Point {
  const radians = degrees * Math.PI / 180
  const cosine = Math.cos(radians)
  const sine = Math.sin(radians)
  const dx = point.x - center.x
  const dy = point.y - center.y
  return {
    x: center.x + dx * cosine - dy * sine,
    y: center.y + dx * sine + dy * cosine
  }
}

function localToCanvas(transform: NormalizedTransform, point: Point): Point {
  const center = { x: transform.x + transform.width / 2, y: transform.y + transform.height / 2 }
  return rotate({
    x: transform.x + point.x * transform.width,
    y: transform.y + point.y * transform.height
  }, center, transform.rotation)
}

function canvasToLocal(transform: NormalizedTransform, point: Point): Point {
  const center = { x: transform.x + transform.width / 2, y: transform.y + transform.height / 2 }
  const unrotated = rotate(point, center, -transform.rotation)
  return {
    x: (unrotated.x - transform.x) / transform.width,
    y: (unrotated.y - transform.y) / transform.height
  }
}

function polygonSvg(width: number, height: number, points: readonly Point[], blurSigma: number): Buffer {
  const coordinates = points
    .map((point) => `${Math.max(-width, Math.min(width * 2, point.x * width)).toFixed(3)},${Math.max(-height, Math.min(height * 2, point.y * height)).toFixed(3)}`)
    .join(' ')
  const filter = blurSigma >= 0.3
    ? `<defs><filter id="feather" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${blurSigma.toFixed(3)}"/></filter></defs>`
    : ''
  const filterAttribute = blurSigma >= 0.3 ? ' filter="url(#feather)"' : ''
  return Buffer.from(`<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">${filter}<rect width="100%" height="100%" fill="black"/><polygon points="${coordinates}" fill="white"${filterAttribute}/></svg>`)
}

async function rasterizeMask(
  mask: MaskElement,
  target: ImageElement,
  targetAsset: AssetMetadata,
  canvasWidth: number,
  canvasHeight: number,
  width: number,
  height: number
): Promise<Buffer> {
  const combined = Buffer.alloc(width * height)
  for (const path of mask.paths) {
    const elementWidth = target.transform.width * canvasWidth
    const elementHeight = target.transform.height * canvasHeight
    const croppedWidth = targetAsset.width * target.crop.width
    const croppedHeight = targetAsset.height * target.crop.height
    const scale = target.fit === 'cover'
      ? Math.max(elementWidth / croppedWidth, elementHeight / croppedHeight)
      : target.fit === 'contain'
        ? Math.min(elementWidth / croppedWidth, elementHeight / croppedHeight)
        : 0
    const renderedWidth = target.fit === 'fill' ? elementWidth : croppedWidth * scale
    const renderedHeight = target.fit === 'fill' ? elementHeight : croppedHeight * scale
    const offsetX = (elementWidth - renderedWidth) / 2
    const offsetY = (elementHeight - renderedHeight) / 2
    const points = path.points.map((point) => {
      const local = canvasToLocal(target.transform, localToCanvas(mask.transform, point))
      return {
        x: target.crop.x + ((local.x * elementWidth - offsetX) / renderedWidth) * target.crop.width,
        y: target.crop.y + ((local.y * elementHeight - offsetY) / renderedHeight) * target.crop.height
      }
    })
    const sigma = Math.min(100, mask.feather * Math.min(width, height) * 0.08)
    const pixels = await sharp(polygonSvg(width, height, points, sigma)).greyscale().removeAlpha().raw().toBuffer()
    for (let index = 0; index < combined.length; index += 1) {
      combined[index] = Math.max(combined[index] ?? 0, pixels[index] ?? 0)
    }
  }
  return combined
}

export class EditMaskCompiler {
  readonly #assetStore: AssetStore
  readonly #stagingDirectory: string
  readonly #idFactory: () => string

  constructor(options: EditMaskCompilerOptions) {
    this.#assetStore = options.assetStore
    this.#stagingDirectory = options.stagingDirectory
    this.#idFactory = options.idFactory ?? randomUUID
  }

  async compile(scene: Scene, targetElementId: string, targetAsset: AssetMetadata): Promise<EditMaskCompilation> {
    const target = scene.elements.find((element) => element.id === targetElementId)
    if (target?.type !== 'image') throw new Error('局部修改需要先选择一个图片元素。')
    if (target.assetId !== targetAsset.id) throw new Error('所选图片与源资源不一致，请重新选择。')
    const masks = scene.elements
      .filter((element): element is MaskElement => element.type === 'mask' && element.visible && element.targetElementId === target.id)
      .sort((left, right) => left.zIndex - right.zIndex)
    if (masks.length === 0) throw new Error('请先为所选图片绘制至少一个修改蒙版。')

    const width = targetAsset.width
    const height = targetAsset.height
    const output = Buffer.alloc(width * height)
    for (const mask of masks) {
      const pixels = await rasterizeMask(
        mask,
        target,
        targetAsset,
        scene.canvas.outputWidth,
        scene.canvas.outputHeight,
        width,
        height
      )
      for (let index = 0; index < output.length; index += 1) {
        const value = pixels[index] ?? 0
        output[index] = mask.mode === 'protect'
          ? Math.round((output[index] ?? 0) * (1 - value / 255))
          : Math.max(output[index] ?? 0, value)
      }
    }
    if (!output.some((value) => value > 0)) throw new Error('当前蒙版没有可修改区域；请添加“修改”或“生成”区域。')

    const id = this.#idFactory()
    await mkdir(this.#stagingDirectory, { recursive: true })
    const stagingPath = join(this.#stagingDirectory, `${id}.png`)
    try {
      await sharp(output, { raw: { width, height, channels: 1 } }).png().toFile(stagingPath)
      const asset = await this.#assetStore.importImage({ sourcePath: stagingPath, sourceType: 'reference', sourceId: `mask:${id}` })
      return { id, asset, width, height, contributingMaskIds: masks.map((mask) => mask.id) }
    } finally {
      await rm(stagingPath, { force: true }).catch(() => undefined)
    }
  }
}
