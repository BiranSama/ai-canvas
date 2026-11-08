import { getCompositeImageData, getLayerImageData, getLayerMaskImageData, initializeCanvas, readPsd, type Layer, type PixelData } from 'ag-psd'
import sharp from 'sharp'
import type { PsdAdjustmentImport, PsdDocumentImport, PsdGroupImport, PsdLayerImport } from '../../shared/psd-import'
import { LAYER_STYLE_KINDS, MAX_LAYER_ADJUSTMENTS, type AdjustmentSettings } from '../../domain'
import { fromPsdAdjustment } from './psd-adjustments'
import { fromPsdBlendMode } from './psd-blend'
import { fromPsdEffects } from './psd-styles'
import { ADJUSTMENT_LABELS } from '../../shared/adjustments'

/*
 * Reads a PSD into what a project needs: one PNG per pixel layer, at its
 * place on the canvas, with its name, opacity, visibility, blend mode,
 * group and layer mask. The file comes from the user, so the structure is read first
 * without decoding any bitmap and checked against limits, then each layer
 * is decoded, turned into a PNG and let go before the next.
 *
 * Adjustment layers of the kinds the canvas has come along as adjustment
 * layers; one clipped to a pixel layer, in normal blend at full opacity and
 * without a mask, becomes that layer's own adjustment, which does the same.
 *
 * What the scene cannot hold is simplified and listed: layer styles, other
 * adjustment and fill layers, clipping masks, nested groups and blend modes
 * beyond the five the canvas has. Whenever something was, the PSD's own
 * flattened image comes along too, so the original look is at hand.
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

/**
 * The layer's mask over the layer's own pixels, as gray values. A
 * Photoshop mask can have its own bounds and a colour outside them; a
 * turned-off mask comes along turned off.
 */
function layerMask(layer: Layer, width: number, height: number): { readonly gray: Uint8Array<ArrayBuffer>; readonly enabled: boolean } | null {
  const mask = layer.mask
  if (mask === undefined) return null
  const maskPixels = getLayerMaskImageData(layer)
  if (maskPixels === undefined) return null
  const maskBytes = toBytes(maskPixels)
  const maskLeft = mask.left ?? 0
  const maskTop = mask.top ?? 0
  const outside = mask.defaultColor ?? 0
  const layerLeft = layer.left ?? 0
  const layerTop = layer.top ?? 0
  const gray = new Uint8Array(width * height)
  for (let y = 0; y < height; y += 1) {
    const my = layerTop + y - maskTop
    for (let x = 0; x < width; x += 1) {
      const mx = layerLeft + x - maskLeft
      gray[y * width + x] = mx >= 0 && my >= 0 && mx < maskPixels.width && my < maskPixels.height ? maskBytes[(my * maskPixels.width + mx) * 4]! : outside
    }
  }
  return { gray, enabled: mask.disabled !== true }
}

/** Adjustments whose Photoshop formula is not published: the canvas draws them close to it, not exactly. */
const APPROXIMATE: ReadonlySet<AdjustmentSettings['kind']> = new Set(['brightness-contrast', 'vibrance', 'color-balance', 'black-white'])

/** The most pixels a side of an adjustment layer's mask has, as the canvas keeps it. */
const ADJUSTMENT_MASK_EDGE = 4096

/** An adjustment layer's mask over the whole document, at most ADJUSTMENT_MASK_EDGE a side, as gray values. */
function documentMask(layer: Layer, documentWidth: number, documentHeight: number): { readonly gray: Uint8Array<ArrayBuffer>; readonly width: number; readonly height: number; readonly enabled: boolean } | null {
  const mask = layer.mask
  if (mask === undefined) return null
  const maskPixels = getLayerMaskImageData(layer)
  if (maskPixels === undefined) return null
  const maskBytes = toBytes(maskPixels)
  const scale = Math.min(1, ADJUSTMENT_MASK_EDGE / Math.max(documentWidth, documentHeight))
  const width = Math.max(1, Math.round(documentWidth * scale))
  const height = Math.max(1, Math.round(documentHeight * scale))
  const left = mask.left ?? 0
  const top = mask.top ?? 0
  const outside = mask.defaultColor ?? 255
  const gray = new Uint8Array(width * height)
  for (let y = 0; y < height; y += 1) {
    const my = Math.floor((y + 0.5) / scale) - top
    for (let x = 0; x < width; x += 1) {
      const mx = Math.floor((x + 0.5) / scale) - left
      gray[y * width + x] = mx >= 0 && my >= 0 && mx < maskPixels.width && my < maskPixels.height ? maskBytes[(my * maskPixels.width + mx) * 4]! : outside
    }
  }
  return { gray, width, height, enabled: mask.disabled !== true }
}

async function grayPng(gray: Uint8Array<ArrayBuffer>, width: number, height: number): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await sharp(Buffer.from(gray.buffer), { raw: { width, height, channels: 1 } }).png({ compressionLevel: 6 }).toBuffer())
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

  const notes = { styles: new Set<string>(), styleApprox: new Set<string>(), adjustments: 0, clipped: 0, nested: 0, blends: 0, deepColor: (psd.bitsPerChannel ?? 8) > 8, text: 0, simplified: new Set<string>(), approximate: new Set<string>() }
  const layers: (PsdLayerImport | PsdAdjustmentImport)[] = []
  /*
   * The clipping mask being read: whether its base came in as a picture, so
   * the layers clipped to it can stay clipped, and, while nothing else has
   * come in above the base, the base's own adjustments, which take the
   * adjustment layers clipped right above it.
   */
  let chain: { readonly base: boolean; collapse: { settings: AdjustmentSettings; enabled: boolean }[] | null } | null = null
  /** A clipped layer stays clipped when its base came in; otherwise it comes as a plain layer. */
  const clippedHere = (layer: Layer): boolean => {
    if (layer.clipping !== true) return false
    if (chain?.base === true) return true
    notes.clipped += 1
    return false
  }
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
      chain = null
      for (const child of layer.children) await visit(child, { index, visible, opacity })
      chain = null
      return
    }
    // A layer that is not clipped is the base of whatever is clipped above it; only a picture can be one here.
    if (layer.clipping !== true) chain = { base: false, collapse: null }
    if (layer.adjustment !== undefined) {
      const imported = fromPsdAdjustment(layer.adjustment)
      if (imported === null) { notes.adjustments += 1; return }
      if (imported.simplified !== null) notes.simplified.add(imported.simplified)
      if (APPROXIMATE.has(imported.settings.kind)) notes.approximate.add(ADJUSTMENT_LABELS[imported.settings.kind])
      const mask = documentMask(layer, psd.width, psd.height)
      const blend = layer.blendMode ?? 'normal'
      // Clipped to a pixel layer, plain: that layer's own adjustment does the same.
      // A layer holds only so many adjustments of its own; past that they come as adjustment layers.
      const collapse = chain?.collapse ?? null
      if (layer.clipping === true && collapse !== null && collapse.length < MAX_LAYER_ADJUSTMENTS && (blend === 'normal' || blend === 'pass through') && (layer.opacity ?? 1) >= 1 && (mask === null || !mask.enabled || mask.gray.every((value) => value === 255))) {
        collapse.push({ settings: imported.settings, enabled: layer.hidden !== true })
        return
      }
      // Kept as a layer of its own, clipped adjustments above it cannot move under it into the base.
      const clipped = clippedHere(layer)
      if (chain !== null) chain.collapse = null
      const blendMode = fromPsdBlendMode(blend)
      if (blendMode === undefined) notes.blends += 1
      layers.push({
        kind: 'adjustment',
        name: layer.name?.trim() || ADJUSTMENT_LABELS[imported.settings.kind],
        blendMode: blendMode ?? 'normal',
        opacity: Math.max(0, Math.min(1, opacity)),
        visible,
        groupIndex: group?.index ?? null,
        settings: imported.settings,
        clipped,
        mask: mask === null ? null : { png: await grayPng(mask.gray, mask.width, mask.height), enabled: mask.enabled }
      })
      return
    }
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
    const effects = fromPsdEffects(layer.effects)
    for (const name of effects.dropped) notes.styles.add(name)
    for (const name of effects.approximated) notes.styleApprox.add(name)
    if (layer.text !== undefined) notes.text += 1
    const blendMode = fromPsdBlendMode(layer.blendMode)
    if (blendMode === undefined) notes.blends += 1
    const mask = layerMask(layer, width, height)
    // A mask that is on hides what it covers, so the bottom layer is opaque only if its mask hides nothing.
    if (layers.length === 0) {
      bottomOpaque = left <= 0 && top <= 0 && left + width >= psd.width && top + height >= psd.height && opacity >= 1 && isOpaque(rgba)
        && (mask === null || !mask.enabled || mask.gray.every((value) => value === 255))
    }
    const adjustments: { settings: AdjustmentSettings; enabled: boolean }[] = []
    const clipped = clippedHere(layer)
    // A picture not clipped is the base of what is clipped above it; a clipped one comes between its base and what follows.
    // A styled base keeps its clipped adjustments as layers: its own adjustments go on before its styles, clipped ones after.
    const styled = effects.style !== undefined && LAYER_STYLE_KINDS.some((kind) => effects.style![kind] !== undefined)
    if (layer.clipping === true) { if (chain !== null) chain.collapse = null } else chain = { base: true, collapse: styled ? null : adjustments }
    layers.push({
      kind: 'pixels',
      adjustments,
      clipped,
      style: effects.style,
      name: layer.name?.trim() || `图层 ${layers.length + 1}`,
      left, top, width, height,
      opacity: Math.max(0, Math.min(1, opacity)),
      visible,
      blendMode: blendMode ?? 'normal',
      groupIndex: group?.index ?? null,
      png: await png(rgba, width, height),
      mask: mask === null ? null : { png: await grayPng(mask.gray, width, height), enabled: mask.enabled }
    })
  }
  for (const layer of psd.children ?? []) await visit(layer, null)

  const approximations = [
    notes.styles.size > 0 ? `图层样式里的${[...notes.styles].join('、')}没有带过来` : null,
    notes.styleApprox.size > 0 ? `图层样式里的${[...notes.styleApprox].join('、')}有些设置画布没有，按最接近的样子带过来` : null,
    notes.adjustments > 0 ? `${notes.adjustments} 个调整图层或填充图层没有带过来` : null,
    notes.clipped > 0 ? `${notes.clipped} 个剪贴蒙版的底层没有带过来，这些图层按普通图层导入` : null,
    notes.nested > 0 ? `${notes.nested} 个嵌套的组合并到了外层组` : null,
    notes.blends > 0 ? `${notes.blends} 个图层的混合模式暂不支持，按正常处理` : null,
    ...notes.simplified,
    notes.approximate.size > 0 ? `${[...notes.approximate].join('、')}按画布的算法显示，和 Photoshop 可能略有不同` : null,
    notes.deepColor ? `${psd.bitsPerChannel} 位色深转成了 8 位` : null
  ].filter((note): note is string => note !== null)
  const keptAsPictures = [
    notes.text > 0 ? `${notes.text} 个文字图层按画好的样子保留成图片` : null
  ].filter((note): note is string => note !== null)

  // When something was simplified, bring Photoshop's own flattened image as a hidden reference.
  let composite: Uint8Array<ArrayBuffer> | null = null
  if (approximations.length > 0 || layers.length === 0) {
    const flattened = getCompositeImageData(psd)
    if (flattened !== undefined && flattened.width === psd.width && flattened.height === psd.height) composite = await png(new Uint8Array(toBytes(flattened)), psd.width, psd.height)
  }
  if (layers.length === 0 && composite === null) throw new PsdImportError('这个 PSD 里没有能导入的图层。')
  // A vertical guide sits at an x, a horizontal one at a y; any far past the document is a stray.
  const guides = (psd.imageResources?.gridAndGuidesInformation?.guides ?? [])
    .filter((guide) => Number.isFinite(guide.location) && guide.location <= 65_536)
    .slice(0, 200)
    .map((guide) => ({ axis: guide.direction === 'vertical' ? 'x' as const : 'y' as const, position: guide.location }))
  return { width: psd.width, height: psd.height, layers, groups, composite, approximations, keptAsPictures, opaqueBackground: bottomOpaque === true, ...(guides.length === 0 ? {} : { guides }) }
}
