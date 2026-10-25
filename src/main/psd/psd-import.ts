import { getCompositeImageData, getLayerImageData, getLayerMaskImageData, initializeCanvas, readPsd, type Layer, type PixelData } from 'ag-psd'
import sharp from 'sharp'
import type { PsdDocumentImport, PsdGroupImport, PsdLayerImport } from '../../shared/psd-import'
import type { BlendMode } from '../../domain'

/*
 * Reads a PSD into what a project needs: one PNG per pixel layer, at its
 * place on the canvas, with its name, opacity, visibility, blend mode and
 * group. The file comes from the user, so the structure is read first
 * without decoding any bitmap and checked against limits, then each layer
 * is decoded, turned into a PNG and let go before the next.
 *
 * What the scene cannot hold is simplified and listed: layer styles,
 * adjustment and fill layers, clipping masks, nested groups and blend
 * modes beyond the five the canvas has. Whenever something was, the PSD's
 * own flattened image comes along too, so the original look is at hand.
 */

export interface PsdImportLimits {
  readonly maxEdge: number
  readonly maxLayers: number
  readonly maxDecodedBytes: number
}

const DEFAULT_LIMITS: PsdImportLimits = { maxEdge: 30_000, maxLayers: 2_000, maxDecodedBytes: 2 * 1024 * 1024 * 1024 }

// Layers decode into plain pixel arrays; nothing here draws, so ag-psd gets no real canvas.
type CreateImageData = NonNullable<Parameters<typeof initializeCanvas>[1]>
initializeCanvas(
  () => { throw new Error('This PSD stores a layer in a form that needs a canvas to decode.') },
  ((width: number, height: number) => ({ width, height, data: new Uint8ClampedArray(width * height * 4), colorSpace: 'srgb' })) as unknown as CreateImageData
)
const SUPPORTED_COLOR_MODES = new Set([1, 3, 4]) // grayscale, RGB, CMYK

const BLEND_MODES: Readonly<Partial<Record<NonNullable<Layer['blendMode']>, BlendMode>>> = {
  normal: 'normal',
  'pass through': 'normal',
  multiply: 'multiply',
  screen: 'screen',
  overlay: 'overlay',
  'soft light': 'soft-light'
}

export class PsdImportError extends Error {}

/** 8-bit RGBA from whatever depth ag-psd decoded: 16-bit takes the high byte, 32-bit float is clamped. */
function toBytes(pixels: PixelData): Uint8Array {
  const { data } = pixels
  if (data instanceof Uint8Array || data instanceof Uint8ClampedArray) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  const bytes = new Uint8Array(data.length)
  if (data instanceof Uint16Array) for (let index = 0; index < data.length; index += 1) bytes[index] = data[index]! >> 8
  else for (let index = 0; index < data.length; index += 1) bytes[index] = Math.round(Math.min(1, Math.max(0, data[index]!)) * 255)
  return bytes
}

/** Multiplies the layer's alpha by its enabled layer mask, which can have its own bounds and a colour outside them. */
function applyMask(rgba: Uint8Array, layer: Layer, width: number, height: number): boolean {
  const mask = layer.mask
  if (mask === undefined || mask.disabled === true) return false
  const maskPixels = getLayerMaskImageData(layer)
  if (maskPixels === undefined) return false
  const maskBytes = toBytes(maskPixels)
  const maskLeft = mask.left ?? 0
  const maskTop = mask.top ?? 0
  const outside = mask.defaultColor ?? 0
  const layerLeft = layer.left ?? 0
  const layerTop = layer.top ?? 0
  for (let y = 0; y < height; y += 1) {
    const my = layerTop + y - maskTop
    for (let x = 0; x < width; x += 1) {
      const mx = layerLeft + x - maskLeft
      const value = mx >= 0 && my >= 0 && mx < maskPixels.width && my < maskPixels.height ? maskBytes[(my * maskPixels.width + mx) * 4]! : outside
      const alpha = (y * width + x) * 4 + 3
      rgba[alpha] = Math.round(rgba[alpha]! * value / 255)
    }
  }
  return true
}

async function png(rgba: Uint8Array, width: number, height: number): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await sharp(Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength), { raw: { width, height, channels: 4 } }).png({ compressionLevel: 6 }).toBuffer())
}

function isOpaque(rgba: Uint8Array): boolean {
  for (let alpha = 3; alpha < rgba.length; alpha += 4) if (rgba[alpha] !== 255) return false
  return true
}

export async function readPsdForImport(bytes: Uint8Array, limits: PsdImportLimits = DEFAULT_LIMITS): Promise<PsdDocumentImport> {
  let psd
  try {
    psd = readPsd(bytes, { useRawData: true, useRawThumbnail: true, skipThumbnail: true, skipLinkedFilesData: true })
  } catch (error) {
    throw new PsdImportError(`这个 PSD 读不出来：${error instanceof Error ? error.message : String(error)}`)
  }
  if (psd.width <= 0 || psd.height <= 0 || psd.width > limits.maxEdge || psd.height > limits.maxEdge) throw new PsdImportError(`画布 ${psd.width}×${psd.height} 超出支持的范围（每边最多 ${limits.maxEdge} 像素）。`)
  if (psd.colorMode !== undefined && !SUPPORTED_COLOR_MODES.has(psd.colorMode)) throw new PsdImportError('只支持 RGB、灰度和 CMYK 模式的 PSD，请先在 Photoshop 里转成 RGB。')

  const notes = { styles: 0, adjustments: 0, clipped: 0, nested: 0, blends: 0, deepColor: (psd.bitsPerChannel ?? 8) > 8, text: 0, masks: 0 }
  const layers: PsdLayerImport[] = []
  const groups: PsdGroupImport[] = []
  let layerCount = 0
  let decodedBytes = 0
  let bottomOpaque: boolean | null = null

  // ag-psd lists children bottom first, which is also the order layers are added in.
  // Group opacity and visibility are folded into the layers, since the canvas
  // draws a group's layers on their own.
  const visit = async (layer: Layer, group: { readonly index: number, readonly visible: boolean, readonly opacity: number } | null): Promise<void> => {
    layerCount += 1
    if (layerCount > limits.maxLayers) throw new PsdImportError(`图层超过 ${limits.maxLayers} 个，暂不支持。`)
    const visible = layer.hidden !== true && (group?.visible ?? true)
    const opacity = (layer.opacity ?? 1) * (group?.opacity ?? 1)
    if (layer.children !== undefined) {
      // The scene has one level of groups, so a group inside a group joins its parent.
      let index = group?.index
      if (index === undefined) {
        groups.push({ name: layer.name?.trim() || '组', visible })
        index = groups.length - 1
      } else {
        notes.nested += 1
      }
      for (const child of layer.children) await visit(child, { index, visible, opacity })
      return
    }
    if (layer.adjustment !== undefined) { notes.adjustments += 1; return }
    const left = layer.left ?? 0
    const top = layer.top ?? 0
    const width = (layer.right ?? 0) - left
    const height = (layer.bottom ?? 0) - top
    if (width <= 0 || height <= 0) return
    if (width > limits.maxEdge || height > limits.maxEdge) throw new PsdImportError(`图层「${layer.name ?? ''}」尺寸 ${width}×${height} 超出支持的范围。`)
    decodedBytes += width * height * 4
    if (decodedBytes > limits.maxDecodedBytes) throw new PsdImportError('这个 PSD 解开后需要的内存太大，暂不支持。')
    const pixels = getLayerImageData(layer)
    if (pixels === undefined) { notes.adjustments += 1; return }
    const rgba = new Uint8Array(toBytes(pixels))
    if (applyMask(rgba, layer, width, height)) notes.masks += 1
    if (layer.effects !== undefined && layer.effects.disabled !== true && Object.keys(layer.effects).some((key) => key !== 'disabled' && key !== 'scale')) notes.styles += 1
    if (layer.clipping === true) notes.clipped += 1
    if (layer.text !== undefined) notes.text += 1
    const blendMode = BLEND_MODES[layer.blendMode ?? 'normal']
    if (blendMode === undefined) notes.blends += 1
    if (layers.length === 0) bottomOpaque = left <= 0 && top <= 0 && left + width >= psd.width && top + height >= psd.height && opacity >= 1 && isOpaque(rgba)
    layers.push({
      name: layer.name?.trim() || `图层 ${layers.length + 1}`,
      left, top, width, height,
      opacity: Math.max(0, Math.min(1, opacity)),
      visible,
      blendMode: blendMode ?? 'normal',
      groupIndex: group?.index ?? null,
      png: await png(rgba, width, height)
    })
  }
  for (const layer of psd.children ?? []) await visit(layer, null)

  const approximations = [
    notes.styles > 0 ? `${notes.styles} 个图层的图层样式（投影、描边等）没有带过来` : null,
    notes.adjustments > 0 ? `${notes.adjustments} 个调整图层或填充图层没有带过来` : null,
    notes.clipped > 0 ? `${notes.clipped} 个剪贴蒙版按普通图层导入` : null,
    notes.nested > 0 ? `${notes.nested} 个嵌套的组合并到了外层组` : null,
    notes.blends > 0 ? `${notes.blends} 个图层的混合模式暂不支持，按正常处理` : null,
    notes.deepColor ? `${psd.bitsPerChannel} 位色深转成了 8 位` : null
  ].filter((note): note is string => note !== null)
  const keptAsPictures = [
    notes.text > 0 ? `${notes.text} 个文字图层按画好的样子保留成图片` : null,
    notes.masks > 0 ? `${notes.masks} 个图层蒙版合进了图层的透明度` : null
  ].filter((note): note is string => note !== null)

  // When something was simplified, bring Photoshop's own flattened image as a hidden reference.
  let composite: Uint8Array<ArrayBuffer> | null = null
  if (approximations.length > 0 || layers.length === 0) {
    const flattened = getCompositeImageData(psd)
    if (flattened !== undefined && flattened.width === psd.width && flattened.height === psd.height) composite = await png(new Uint8Array(toBytes(flattened)), psd.width, psd.height)
  }
  if (layers.length === 0 && composite === null) throw new PsdImportError('这个 PSD 里没有能导入的图层。')
  return { width: psd.width, height: psd.height, layers, groups, composite, approximations, keptAsPictures, opaqueBackground: bottomOpaque === true }
}
