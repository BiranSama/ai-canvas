import sharp from 'sharp'
import { affineOf, boxWarpMatrix, clipStacks, cornersAreIdentity, cornersDrawnAsMatrix, cornersExtent, hiddenByGroups, pathInBox, sceneSchema, type ClipStack, type Corners, type Scene, type SceneElement } from '../../domain'
import { warpLayout, warpPixels, warpSourceMatrix } from '../../shared/warp'
import { applyImageEffects, hasVisibleEffects, shadowGeometry, shadowSilhouette } from '../../shared/layer-effects'
import { activeAdjustments, adjustLayerPixels, adjustmentClipIds, adjustPixels, coverageInBox, hasSpatialFilters, sampleCoverage } from '../../shared/adjustments'
import { layerMaskCoverage, paintedImageBytes } from '../paint/painted-image'
import { applyLayerStyles, hasLayerStyles, styledLayerReach } from '../../shared/layer-styles'
import type { RenderMode } from '../../shared/reference'
import { blendModeToSvgStyle, compositeOver, resolveBlendMode } from '../../shared/blend-mode'
import { layoutTextLines } from './text-layout'
import { imageBytes } from '../storage/image-file'

export type ReferenceAssetResolver = (assetId: string) => Promise<string | Buffer | null>

export interface CompositeRenderResult {
  readonly buffer: Buffer
  readonly warnings: readonly string[]
}

function escapeXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')
}

/** An SVG paint for a canvas colour: #RRGGBBAA as rgba(), and fully transparent as none. */
export function svgPaint(color: string): string {
  const match = /^#([\da-f]{6})([\da-f]{2})$/i.exec(color)
  if (match === null) return escapeXml(color)
  const alpha = parseInt(match[2]!, 16) / 255
  if (alpha === 0) return 'none'
  const rgb = match[1]!
  return `rgba(${parseInt(rgb.slice(0, 2), 16)},${parseInt(rgb.slice(2, 4), 16)},${parseInt(rgb.slice(4, 6), 16)},${Number(alpha.toFixed(3))})`
}

function finite(value: number): string {
  return Number(value.toFixed(3)).toString()
}

export function elementPresentation(element: SceneElement, mode: RenderMode): 'omit' | 'editing' | 'reference' | 'final' {
  if (!element.visible || element.type === 'group') return 'omit'
  if (mode === 'editing') return 'editing'
  if (mode === 'reference') {
    if (element.referencePolicy === 'exclude' || element.type === 'mask') return 'omit'
    return 'reference'
  }
  if (element.referencePolicy !== 'include' || element.type === 'placeholder' || element.type === 'light' || element.type === 'mask') return 'omit'
  if (element.type === 'shape' && element.role === 'placeholder') return 'omit'
  if (element.type === 'sketch' && !element.finalVisible) return 'omit'
  return 'final'
}

type ImageLayer = Extract<SceneElement, { type: 'image' }>

/** The part of a picture of this size that the layer's crop keeps. */
function cropRegion(width: number, height: number, crop: ImageLayer['crop']): { readonly left: number; readonly top: number; readonly width: number; readonly height: number } {
  const left = Math.min(width - 1, Math.max(0, Math.round(crop.x * width)))
  const top = Math.min(height - 1, Math.max(0, Math.round(crop.y * height)))
  return { left, top, width: Math.max(1, Math.min(width - left, Math.round(crop.width * width))), height: Math.max(1, Math.min(height - top, Math.round(crop.height * height))) }
}

async function imageDataUri(path: string | Buffer, element: ImageLayer): Promise<string> {
  const bytes = await imageBytes(path)
  const metadata = await sharp(bytes).metadata()
  const cropped = await sharp(bytes).extract(cropRegion(metadata.width ?? 1, metadata.height ?? 1, element.crop)).png().toBuffer()
  return `data:image/png;base64,${cropped.toString('base64')}`
}

/** A selection an adjustment was made in, cropped and fitted into the box as the image is: its coverage there, read as the canvas reads it. */
async function clipCoverage(path: string | Buffer, element: ImageLayer, width: number, height: number): Promise<Uint8Array> {
  const { data, info } = await sharp(await imageBytes(path)).removeAlpha().extractChannel(0).raw().toBuffer({ resolveWithObject: true })
  return coverageInBox({ width: info.width, height: info.height, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) }, element, width, height)
}

/** A layer mask in the image's own pixels, cropped and fitted into the box as the image is. */
function maskInBox(mask: { readonly width: number; readonly height: number; readonly coverage: Uint8Array }, element: ImageLayer, width: number, height: number): Uint8Array {
  return coverageInBox({ width: mask.width, height: mask.height, data: mask.coverage }, element, width, height)
}

/**
 * The image drawn into its box with its effects and adjustments applied, and
 * its shadow beneath, as the canvas draws them.
 */
async function imageWithEffects(
  uri: string,
  element: ImageLayer,
  box: { readonly x: number; readonly y: number; readonly w: number; readonly h: number },
  resolveAsset: ReferenceAssetResolver,
  /** A mask that goes on after the filters, as on a smart object, rather than into the source. */
  laterMask: { readonly width: number; readonly height: number; readonly coverage: Uint8Array } | null = null
): Promise<string> {
  const effects = hasVisibleEffects(element.effects) ? element.effects : null
  const width = Math.max(1, Math.round(box.w))
  const height = Math.max(1, Math.round(box.h))
  const pixels = await sharp(Buffer.from(uri.slice(uri.indexOf(',') + 1), 'base64'))
    .resize(width, height, { fit: element.fit, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .ensureAlpha()
    .raw()
    .toBuffer()
  if (effects !== null) applyImageEffects(pixels, width, height, effects)
  const coverages = new Map<string, Uint8Array | null>()
  for (const clipId of adjustmentClipIds(element.adjustments)) {
    const path = await resolveAsset(clipId)
    coverages.set(clipId, path === null ? null : await clipCoverage(path, element, width, height))
  }
  adjustLayerPixels(pixels, element.adjustments, { width, height, scale: width / Math.max(1e-6, box.w) }, (clipId) => coverages.get(clipId) ?? null)
  if (laterMask !== null) {
    const coverage = maskInBox(laterMask, element, width, height)
    for (let pixel = 0; pixel < coverage.length; pixel += 1) pixels[pixel * 4 + 3] = Math.round(pixels[pixel * 4 + 3]! * coverage[pixel]! / 255)
  }
  const drawn = await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer()
  let shadow = ''
  if (effects !== null && effects.shadow !== null && effects.shadow.opacity > 0) {
    const geometry = shadowGeometry(effects.shadow, width, height)
    const silhouette = sharp(Buffer.from(shadowSilhouette(pixels, width, height, effects.shadow)), { raw: { width, height, channels: 4 } })
      .extend({ top: geometry.padding, bottom: geometry.padding, left: geometry.padding, right: geometry.padding, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    const blurred = await (geometry.sigma >= 0.3 ? silhouette.blur(geometry.sigma) : silhouette).png().toBuffer()
    shadow = `<image x="${finite(box.x - geometry.padding + geometry.offsetX)}" y="${finite(box.y - geometry.padding + geometry.offsetY)}" width="${width + geometry.padding * 2}" height="${height + geometry.padding * 2}" href="data:image/png;base64,${blurred.toString('base64')}" preserveAspectRatio="none"/>`
  }
  return `${shadow}<image x="${finite(box.x)}" y="${finite(box.y)}" width="${finite(box.w)}" height="${finite(box.h)}" href="data:image/png;base64,${drawn.toString('base64')}" preserveAspectRatio="none"/>`
}

/** The layer's box in canvas pixels, and its turn about the box's top-left corner, as the canvas turns it. */
function transform(element: SceneElement, width: number, height: number): { x: number; y: number; w: number; h: number; rotate: string } {
  const x = element.transform.x * width
  const y = element.transform.y * height
  const w = element.transform.width * width
  const h = element.transform.height * height
  return { x, y, w, h, rotate: `rotate(${finite(element.transform.rotation)} ${finite(x)} ${finite(y)})` }
}

/** A layer's free-transform corners, if it has any that move it. */
function layerCorners(element: SceneElement): Corners | null {
  const corners = element.type === 'image' || element.type === 'text' || element.type === 'shape' ? element.corners : null
  return cornersAreIdentity(corners) ? null : corners!
}

/** A flip, or a text's skew, as an SVG matrix about the box's top-left corner, inside the layer's turn; nothing otherwise. */
function affineWarp(element: SceneElement, box: { readonly x: number; readonly y: number; readonly w: number; readonly h: number }): string {
  const corners = layerCorners(element)
  if (corners === null || !cornersDrawnAsMatrix(corners, element.type === 'text')) return ''
  const [a, b, c, d, e, f] = affineOf(boxWarpMatrix(corners, box.w, box.h))
  const precise = (value: number): string => Number(value.toFixed(6)).toString()
  return ` matrix(${[a, b, c, d, box.x + e - a * box.x - c * box.y, box.y + f - b * box.x - d * box.y].map(precise).join(' ')})`
}

/** Where a layer's content lies after its corners, in its box's pixels. */
function warpedExtent(element: SceneElement, w: number, h: number): { readonly x: number; readonly y: number; readonly width: number; readonly height: number } {
  const corners = layerCorners(element)
  if (corners === null) return { x: 0, y: 0, width: w, height: h }
  const extent = cornersExtent(corners)
  return { x: extent.x * w, y: extent.y * h, width: extent.width * w, height: extent.height * h }
}

/**
 * A skewed, distorted or perspective layer: drawn upright in its box, resampled
 * through its corners with the shared warp the canvas uses, and laid back
 * turned, in its opacity and blend mode.
 */
async function warpedElementSvg(element: SceneElement, corners: Corners, mode: RenderMode, width: number, height: number, resolveAsset: ReferenceAssetResolver, warnings: string[]): Promise<string> {
  const box = transform(element, width, height)
  const upright = { ...element, corners: null, opacity: 1, blendMode: 'normal', transform: { ...element.transform, rotation: 0 } } as SceneElement
  const inner = await elementSvg(upright, mode, width, height, resolveAsset, warnings)
  const rasterWidth = Math.max(1, Math.ceil(box.w))
  const rasterHeight = Math.max(1, Math.ceil(box.h))
  const svg = `<svg width="${rasterWidth}" height="${rasterHeight}" viewBox="${finite(box.x)} ${finite(box.y)} ${rasterWidth} ${rasterHeight}" xmlns="http://www.w3.org/2000/svg">${inner}</svg>`
  const pixels = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer()
  const layout = warpLayout(corners, box.w, box.h, 1)
  // The raster holds one pixel for each of the box's pixels.
  const warped = warpPixels(pixels, rasterWidth, rasterHeight, layout.rasterWidth, layout.rasterHeight, warpSourceMatrix(corners, box.w, box.h, layout, box.w, box.h))
  const png = await sharp(Buffer.from(warped.buffer), { raw: { width: layout.rasterWidth, height: layout.rasterHeight, channels: 4 } }).png().toBuffer()
  return `<g opacity="${finite(element.opacity)}" transform="${box.rotate}"${blendModeToSvgStyle(resolveBlendMode(element))}><image x="${finite(box.x + layout.x)}" y="${finite(box.y + layout.y)}" width="${finite(layout.width)}" height="${finite(layout.height)}" href="data:image/png;base64,${png.toString('base64')}" preserveAspectRatio="none"/></g>`
}

/**
 * A text or shape layer's mask as an SVG luminance mask over its box, in the
 * layer's own (rotated) space. An image layer's mask goes into its pixels
 * instead, as the canvas applies it.
 */
async function layerMaskSvg(element: SceneElement, box: { readonly x: number; readonly y: number; readonly w: number; readonly h: number }, resolveAsset: ReferenceAssetResolver): Promise<{ readonly defs: string; readonly attribute: string }> {
  const none = { defs: '', attribute: '' }
  if (element.type !== 'text' && element.type !== 'shape') return none
  const mask = element.mask
  if (mask === null || mask === undefined || !mask.enabled) return none
  const coverage = await layerMaskCoverage(mask, resolveAsset)
  if (coverage === null) return none
  const png = await sharp(Buffer.from(coverage.coverage), { raw: { width: coverage.width, height: coverage.height, channels: 1 } }).png().toBuffer()
  const id = `layer-mask-${element.id.replaceAll('-', '')}`
  return {
    defs: `<defs><mask id="${id}" maskUnits="userSpaceOnUse" x="${finite(box.x)}" y="${finite(box.y)}" width="${finite(box.w)}" height="${finite(box.h)}"><image x="${finite(box.x)}" y="${finite(box.y)}" width="${finite(box.w)}" height="${finite(box.h)}" href="data:image/png;base64,${png.toString('base64')}" preserveAspectRatio="none"/></mask></defs>`,
    attribute: ` mask="url(#${id})"`
  }
}

type StyledElement = Extract<SceneElement, { type: 'image' | 'text' | 'shape' }>

/**
 * A layer with its layer styles, as the canvas draws it: the layer drawn
 * alone and upright into a raster padded for the styles, styled with the
 * shared pixel math, and laid back turned, with its shadow and glow under it
 * in their own blend modes and its content in the layer's.
 */
async function styledElementSvg(element: StyledElement, mode: RenderMode, width: number, height: number, resolveAsset: ReferenceAssetResolver, warnings: string[]): Promise<string> {
  const box = transform(element, width, height)
  // Styled after its free transform: over where its corners took it.
  const extent = warpedExtent(element, box.w, box.h)
  const reach = styledLayerReach(element, extent.width, extent.height)
  const upright = { ...element, opacity: 1, blendMode: 'normal' as const, style: undefined, transform: { ...element.transform, rotation: 0 } } as StyledElement
  const inner = await elementSvg(upright, mode, width, height, resolveAsset, warnings)
  // From a whole pixel of the box, as the canvas caches it.
  const originX = Math.floor(extent.x - reach)
  const originY = Math.floor(extent.y - reach)
  const left = box.x + originX
  const top = box.y + originY
  const rasterWidth = Math.max(1, Math.ceil(extent.x + extent.width + reach) - originX)
  const rasterHeight = Math.max(1, Math.ceil(extent.y + extent.height + reach) - originY)
  const svg = `<svg width="${rasterWidth}" height="${rasterHeight}" viewBox="${finite(left)} ${finite(top)} ${rasterWidth} ${rasterHeight}" xmlns="http://www.w3.org/2000/svg">${inner}</svg>`
  const pixels = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer()
  const styled = applyLayerStyles(pixels, { x: extent.x - originX, y: extent.y - originY, width: extent.width, height: extent.height, rasterWidth, rasterHeight }, element.style!, 1, element.transform.rotation)
  const image = async (data: Uint8Array | Uint8ClampedArray): Promise<string> => {
    const png = await sharp(Buffer.from(data.buffer, data.byteOffset, data.byteLength), { raw: { width: rasterWidth, height: rasterHeight, channels: 4 } }).png().toBuffer()
    return `<image x="${finite(left)}" y="${finite(top)}" width="${rasterWidth}" height="${rasterHeight}" href="data:image/png;base64,${png.toString('base64')}" preserveAspectRatio="none"/>`
  }
  const opacity = finite(element.opacity)
  const under = await Promise.all(styled.under.map(async (layer) => `<g opacity="${opacity}" transform="${box.rotate}"${blendModeToSvgStyle(layer.blendMode)}>${await image(layer.pixels)}</g>`))
  return `${under.join('')}<g opacity="${opacity}" transform="${box.rotate}"${blendModeToSvgStyle(resolveBlendMode(element))}>${await image(pixels)}</g>`
}

async function elementSvg(
  element: SceneElement,
  mode: RenderMode,
  width: number,
  height: number,
  resolveAsset: ReferenceAssetResolver,
  warnings: string[]
): Promise<string> {
  const presentation = elementPresentation(element, mode)
  if (presentation === 'omit') return ''
  // Text drawn as a sketch of where it goes carries no styles.
  if ((element.type === 'image' || element.type === 'shape' || (element.type === 'text' && presentation !== 'reference')) && hasLayerStyles(element.style)) {
    return styledElementSvg(element, mode, width, height, resolveAsset, warnings)
  }
  const corners = layerCorners(element)
  if (corners !== null && !cornersDrawnAsMatrix(corners, element.type === 'text')) return warpedElementSvg(element, corners, mode, width, height, resolveAsset, warnings)
  const box = transform(element, width, height)
  const opacity = finite(element.opacity)
  const layerMask = await layerMaskSvg(element, box, resolveAsset)
  // A flip or skew goes on inside the turn, mask and all, as the canvas draws it.
  const groupStart = `${layerMask.defs}<g opacity="${opacity}" transform="${box.rotate}${affineWarp(element, box)}"${blendModeToSvgStyle(resolveBlendMode(element))}${layerMask.attribute}>`
  const groupEnd = '</g>'

  if (element.type === 'image') {
    const path = await resolveAsset(element.assetId)
    if (path === null) {
      warnings.push(`图片元素“${element.name}”的素材不可用，参考图中已保留中性边界。`)
      return `${groupStart}<rect x="${finite(box.x)}" y="${finite(box.y)}" width="${finite(box.w)}" height="${finite(box.h)}" rx="${finite(Math.min(box.w, box.h) * .04)}" fill="#AEB8C4" fill-opacity=".24" stroke="#8090A2" stroke-width="${finite(Math.max(1, width * .0015))}"/>${groupEnd}`
    }
    try {
      const masked = element.mask !== null && element.mask !== undefined && element.mask.enabled
      // A filter that looks at neighbouring pixels works on the unmasked picture; the mask goes on after it.
      const laterMask = masked && hasSpatialFilters(element.adjustments)
      const painted = (element.paint !== undefined && element.paint.length > 0) || (masked && !laterMask) ? await paintedImageBytes(path, element.paint, resolveAsset, laterMask ? null : element.mask ?? null) : path
      const uri = await imageDataUri(painted, element)
      if (hasVisibleEffects(element.effects) || activeAdjustments(element.adjustments).length > 0) {
        const size = await sharp(await imageBytes(path)).metadata()
        const mask = laterMask ? await layerMaskCoverage(element.mask!, resolveAsset, { width: size.width ?? 1, height: size.height ?? 1 }) : null
        return `${groupStart}${await imageWithEffects(uri, element, box, resolveAsset, mask)}${groupEnd}`
      }
      const aspect = element.fit === 'cover' ? 'xMidYMid slice' : element.fit === 'contain' ? 'xMidYMid meet' : 'none'
      return `${groupStart}<image x="${finite(box.x)}" y="${finite(box.y)}" width="${finite(box.w)}" height="${finite(box.h)}" href="${uri}" preserveAspectRatio="${aspect}"/>${groupEnd}`
    } catch {
      warnings.push(`图片元素“${element.name}”无法解码，参考图中已跳过该素材。`)
      return ''
    }
  }

  if (element.type === 'text') {
    if (element.resultAssetId !== null && element.renderStrategy !== 'standard') {
      const path = await resolveAsset(element.resultAssetId)
      if (path !== null) {
        const bytes = await sharp(await imageBytes(path)).png().toBuffer()
        return `${groupStart}<image x="${finite(box.x)}" y="${finite(box.y)}" width="${finite(box.w)}" height="${finite(box.h)}" href="data:image/png;base64,${bytes.toString('base64')}" preserveAspectRatio="xMidYMid contain"/>${groupEnd}`
      }
    }
    if (mode === 'reference') {
      const weight = element.visualWeight ?? 'secondary'
      const opacity = weight === 'hero' ? .5 : weight === 'primary' ? .4 : weight === 'secondary' ? .3 : .2
      const strokeWidth = Math.max(1, width * (weight === 'hero' ? .002 : .0014))
      const color = escapeXml(element.fill)
      if (element.orientation === 'vertical') {
        const x = box.x + box.w / 2
        return `${groupStart}<path d="M ${finite(x)} ${finite(box.y + box.h * .08)} C ${finite(x + box.w * .035)} ${finite(box.y + box.h * .34)}, ${finite(x - box.w * .035)} ${finite(box.y + box.h * .66)}, ${finite(x)} ${finite(box.y + box.h * .92)}" fill="none" stroke="${color}" stroke-opacity="${finite(opacity)}" stroke-width="${finite(strokeWidth)}" stroke-linecap="round"/><path d="M ${finite(box.x + box.w * .37)} ${finite(box.y + box.h * .08)} H ${finite(box.x + box.w * .63)} M ${finite(box.x + box.w * .37)} ${finite(box.y + box.h * .92)} H ${finite(box.x + box.w * .63)}" fill="none" stroke="${color}" stroke-opacity="${finite(opacity * .56)}" stroke-width="${finite(strokeWidth)}"/>${groupEnd}`
      }
      const y = box.y + box.h * .58
      return `${groupStart}<path d="M ${finite(box.x + box.w * .04)} ${finite(y)} C ${finite(box.x + box.w * .3)} ${finite(y - box.h * .08)}, ${finite(box.x + box.w * .7)} ${finite(y + box.h * .08)}, ${finite(box.x + box.w * .96)} ${finite(y)}" fill="none" stroke="${color}" stroke-opacity="${finite(opacity)}" stroke-width="${finite(strokeWidth)}" stroke-linecap="round"/><path d="M ${finite(box.x + box.w * .04)} ${finite(y - box.h * .16)} V ${finite(y + box.h * .16)} M ${finite(box.x + box.w * .96)} ${finite(y - box.h * .16)} V ${finite(y + box.h * .16)}" fill="none" stroke="${color}" stroke-opacity="${finite(opacity * .56)}" stroke-width="${finite(strokeWidth)}"/>${groupEnd}`
    }
    const fontSize = Math.min(box.h * .95, Math.max(7, element.fontSize))
    const letterSpacing = Math.min(element.letterSpacing, box.w * .03)
    const vertical = element.orientation === 'vertical'
    // Wrapped and truncated like the editor, so a render shows overflow the way the user sees it.
    const lines = layoutTextLines({
      content: element.content, fontSize, letterSpacing, lineHeight: element.lineHeight,
      width: box.w, height: box.h, wrapping: element.wrapping, vertical
    })
    const justify = element.align === 'justify' && !vertical
    const anchor = justify || element.align === 'start' ? 'start' : element.align === 'end' ? 'end' : 'middle'
    const x = justify || element.align === 'start' ? box.x : element.align === 'end' ? box.x + box.w : box.x + box.w / 2
    const lineHeight = fontSize * element.lineHeight
    const firstY = box.y + box.h / 2 - (lines.length - 1) * lineHeight / 2
    const stroke = element.stroke === null ? '' : ` stroke="${escapeXml(element.stroke)}" stroke-width="${finite(element.strokeWidth)}"`
    const shadowId = `text-shadow-${element.id.replaceAll('-', '')}`
    const shadow = element.shadowColor === null
      ? { defs: '', attribute: '' }
      : {
          defs: `<defs><filter id="${shadowId}" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="0" stdDeviation="${finite(element.shadowBlur / 2)}" flood-color="${escapeXml(element.shadowColor)}" flood-opacity=".62"/></filter></defs>`,
          attribute: ` filter="url(#${shadowId})"`
        }
    const spans = lines.map((line, index) => {
      const spread = justify && !line.paragraphEnd && line.text.length > 1 ? ` textLength="${finite(box.w)}" lengthAdjust="spacing"` : ''
      return `<tspan x="${finite(x)}" y="${finite(firstY + index * lineHeight)}"${spread}>${escapeXml(line.text)}</tspan>`
    }).join('')
    return `${groupStart}${shadow.defs}<text text-anchor="${anchor}" dominant-baseline="central" fill="${escapeXml(element.fill)}"${stroke}${shadow.attribute} font-family="${escapeXml(element.fontFamily)}" font-size="${finite(fontSize)}" font-weight="${element.fontWeight}" letter-spacing="${finite(letterSpacing)}">${spans}</text>${groupEnd}`
  }

  if (element.type === 'shape') {
    const fill = escapeXml(element.fill)
    const stroke = element.stroke === null ? 'none' : escapeXml(element.stroke)
    const strokeWidth = Math.max(0, element.strokeWidth * Math.min(width, height))
    if (element.shape === 'path' && element.path !== undefined) {
      const ownWidth = Math.max(0, element.strokeWidth * Math.min(box.w, box.h))
      return `${groupStart}<path d="${pathInBox(element.path, box.w, box.h, box.x, box.y)}" fill="${svgPaint(element.fill)}" stroke="${element.stroke === null ? 'none' : svgPaint(element.stroke)}" stroke-width="${finite(ownWidth)}" stroke-linejoin="round" stroke-linecap="round"/>${groupEnd}`
    }
    if (element.shape === 'ellipse') return `${groupStart}<ellipse cx="${finite(box.x + box.w / 2)}" cy="${finite(box.y + box.h / 2)}" rx="${finite(box.w / 2)}" ry="${finite(box.h / 2)}" fill="${fill}" stroke="${stroke}" stroke-width="${finite(strokeWidth)}"/>${groupEnd}`
    if (element.shape === 'line') return `${groupStart}<line x1="${finite(box.x)}" y1="${finite(box.y + box.h / 2)}" x2="${finite(box.x + box.w)}" y2="${finite(box.y + box.h / 2)}" stroke="${stroke === 'none' ? fill : stroke}" stroke-width="${finite(Math.max(1, strokeWidth))}"/>${groupEnd}`
    return `${groupStart}<rect x="${finite(box.x)}" y="${finite(box.y)}" width="${finite(box.w)}" height="${finite(box.h)}" rx="${finite(Math.min(box.w, box.h) * element.cornerRadius)}" fill="${fill}" stroke="${stroke}" stroke-width="${finite(strokeWidth)}"/>${groupEnd}`
  }

  if (element.type === 'placeholder') {
    const radius = Math.min(box.w, box.h) * .1
    const editing = mode === 'editing'
    const fillOpacity = editing ? '.14' : '.28'
    const strokeWidth = finite(Math.max(1, width * .002))
    const dash = editing ? ' stroke-dasharray="10 8"' : ''
    const shape = element.frameShape === 'ellipse'
      ? `<ellipse cx="${finite(box.x + box.w / 2)}" cy="${finite(box.y + box.h / 2)}" rx="${finite(box.w / 2)}" ry="${finite(box.h / 2)}" fill="#8FB8E8" fill-opacity="${fillOpacity}" stroke="#B6D5F7" stroke-width="${strokeWidth}"${dash}/><ellipse cx="${finite(box.x + box.w / 2)}" cy="${finite(box.y + box.h * .48)}" rx="${finite(box.w * .24)}" ry="${finite(box.h * .18)}" fill="none" stroke="#D7E8FA" stroke-opacity=".55" stroke-width="${strokeWidth}"/>`
      : element.frameShape === 'portrait'
        ? `<circle cx="${finite(box.x + box.w * .5)}" cy="${finite(box.y + box.h * .29)}" r="${finite(Math.min(box.w, box.h) * .17)}" fill="#8FB8E8" fill-opacity="${fillOpacity}" stroke="#B6D5F7" stroke-width="${strokeWidth}"${dash}/><path d="M ${finite(box.x + box.w * .18)} ${finite(box.y + box.h * .84)} C ${finite(box.x + box.w * .22)} ${finite(box.y + box.h * .58)}, ${finite(box.x + box.w * .38)} ${finite(box.y + box.h * .52)}, ${finite(box.x + box.w * .5)} ${finite(box.y + box.h * .5)} C ${finite(box.x + box.w * .62)} ${finite(box.y + box.h * .52)}, ${finite(box.x + box.w * .78)} ${finite(box.y + box.h * .58)}, ${finite(box.x + box.w * .82)} ${finite(box.y + box.h * .84)} Z" fill="#8FB8E8" fill-opacity="${fillOpacity}" stroke="#B6D5F7" stroke-width="${strokeWidth}"${dash}/>`
        : element.frameShape === 'free'
          ? `<path d="M ${finite(box.x + box.w * .08)} ${finite(box.y + box.h * .2)} C ${finite(box.x + box.w * .3)} ${finite(box.y)}, ${finite(box.x + box.w * .5)} ${finite(box.y + box.h * .08)}, ${finite(box.x + box.w * .74)} ${finite(box.y + box.h * .16)} C ${finite(box.x + box.w)} ${finite(box.y + box.h * .25)}, ${finite(box.x + box.w * .88)} ${finite(box.y + box.h * .76)}, ${finite(box.x + box.w * .72)} ${finite(box.y + box.h * .9)} C ${finite(box.x + box.w * .45)} ${finite(box.y + box.h)}, ${finite(box.x + box.w * .08)} ${finite(box.y + box.h * .9)}, ${finite(box.x + box.w * .04)} ${finite(box.y + box.h * .58)} Z" fill="#8FB8E8" fill-opacity="${fillOpacity}" stroke="#B6D5F7" stroke-width="${strokeWidth}"${dash}/>`
          : `<rect x="${finite(box.x)}" y="${finite(box.y)}" width="${finite(box.w)}" height="${finite(box.h)}" rx="${finite(radius)}" fill="#8FB8E8" fill-opacity="${fillOpacity}" stroke="#B6D5F7" stroke-width="${strokeWidth}"${dash}/><path d="M ${finite(box.x + box.w * .08)} ${finite(box.y + box.h * .78)} L ${finite(box.x + box.w * .48)} ${finite(box.y + box.h * .35)} L ${finite(box.x + box.w * .92)} ${finite(box.y + box.h * .78)} M ${finite(box.x + box.w * .48)} ${finite(box.y + box.h * .35)} L ${finite(box.x + box.w * .5)} ${finite(box.y + box.h * .08)}" fill="none" stroke="#D7E8FA" stroke-opacity=".55" stroke-width="${strokeWidth}"/>`
    return `${groupStart}${shape}${editing ? `<text x="${finite(box.x + box.w / 2)}" y="${finite(box.y + box.h * .94)}" text-anchor="middle" fill="#D7E8FA" font-family="Segoe UI, sans-serif" font-size="${finite(Math.max(10, width * .014))}">${escapeXml(element.name)}</text>` : ''}${groupEnd}`
  }

  if (element.type === 'light') {
    const id = `light-${element.id.replaceAll('-', '')}`
    const color = escapeXml(element.color)
    const softnessStop = Math.max(.05, Math.min(.95, 1 - element.softness * .72))
    return `${groupStart}<defs><radialGradient id="${id}"><stop offset="0" stop-color="${color}" stop-opacity="${finite(element.intensity)}"/><stop offset="${finite(softnessStop)}" stop-color="${color}" stop-opacity="${finite(element.intensity * .38)}"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></radialGradient></defs><ellipse cx="${finite(box.x + box.w / 2)}" cy="${finite(box.y + box.h / 2)}" rx="${finite(box.w * element.range / 2)}" ry="${finite(box.h * element.range / 2)}" fill="url(#${id})"/>${mode === 'editing' ? `<circle cx="${finite(box.x + box.w / 2)}" cy="${finite(box.y + box.h / 2)}" r="${finite(Math.max(5, width * .006))}" fill="none" stroke="${color}" stroke-width="2"/>` : ''}${groupEnd}`
  }

  if (element.type === 'sketch') {
    const paths = element.strokes.map((stroke) => {
      const points = stroke.points.map((point) => `${finite(box.x + point.x * box.w)},${finite(box.y + point.y * box.h)}`).join(' ')
      return `<polyline points="${points}" fill="none" stroke="${escapeXml(stroke.color)}" stroke-width="${finite(Math.max(1, stroke.width * Math.min(box.w, box.h)))}" stroke-opacity="${finite(stroke.opacity)}" stroke-linecap="round" stroke-linejoin="round"/>`
    }).join('')
    return `${groupStart}${paths}${groupEnd}`
  }

  if (element.type === 'mask' && mode === 'editing') {
    const color = element.mode === 'protect' ? '#79A7D8' : element.mode === 'generate' ? '#6FAF8C' : '#C88C87'
    const paths = element.paths.map((path) => {
      const points = path.points.map((point) => `${finite(point.x * width)},${finite(point.y * height)}`).join(' ')
      return `<polygon points="${points}" fill="${color}" fill-opacity=".28" stroke="${color}" stroke-width="2"/>`
    }).join('')
    return `${groupStart}${paths}${groupEnd}`
  }
  return ''
}

export class CompositeReferenceRenderer {
  readonly #resolveAsset: ReferenceAssetResolver

  constructor(resolveAsset: ReferenceAssetResolver = async () => null) {
    this.#resolveAsset = resolveAsset
  }

  /** One layer alone over the whole canvas, as raw RGBA. */
  async #raster(element: SceneElement, mode: RenderMode, width: number, height: number, warnings: string[]): Promise<Buffer> {
    const fragment = await elementSvg(element, mode, width, height, this.#resolveAsset, warnings)
    return sharp(Buffer.from(`<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">${fragment}</svg>`)).ensureAlpha().raw().toBuffer()
  }

  /**
   * A clipping stack, as the canvas draws it: the base at full strength,
   * each clipped layer shown only where the base's content is and laid over
   * in its own mode (a clipped adjustment layer adjusts the stack so far),
   * keeping the base's coverage, and the whole laid over the picture with
   * the base's opacity and mode.
   */
  async #clipStackSvg(scene: Scene, base: SceneElement, stack: ClipStack, mode: RenderMode, hidden: ReadonlySet<string>, warnings: string[]): Promise<string> {
    const width = scene.canvas.outputWidth
    const height = scene.canvas.outputHeight
    const full = { ...base, opacity: 1, blendMode: 'normal' as const } as SceneElement
    const pixels = await this.#raster(full, mode, width, height, warnings)
    // What clips is the base's own content, not its shadow, glow or stroke: anywhere it is at all.
    const shape = (base.type === 'image' || base.type === 'text' || base.type === 'shape') && hasLayerStyles(base.style)
      ? await this.#raster({ ...full, style: undefined } as SceneElement, mode, width, height, warnings)
      : Buffer.from(pixels)
    // Worked out over the base made opaque where it is, then cut back to its coverage at the end,
    // so the clipped layers keep the base's transparency (W3C source-atop), as the canvas draws it.
    const coverage = new Uint8Array(width * height)
    for (let pixel = 0; pixel < coverage.length; pixel += 1) {
      coverage[pixel] = pixels[pixel * 4 + 3]!
      if (coverage[pixel]! > 0) pixels[pixel * 4 + 3] = 255
    }
    for (const id of stack.memberIds) {
      const member = scene.elements.find((element) => element.id === id)
      if (member === undefined || hidden.has(id) || elementPresentation(member, mode) === 'omit') continue
      if (member.type === 'adjustment') {
        const mask = member.mask
        const own = mask === null || mask === undefined || !mask.enabled ? null : await layerMaskCoverage(mask, this.#resolveAsset)
        const coverage = own === null ? null : sampleCoverage({ width: own.width, height: own.height, data: own.coverage }, width, height, { scaleX: own.width / width, scaleY: own.height / height, offsetX: 0, offsetY: 0 })
        adjustPixels(pixels, member.settings, { coverage, amount: member.opacity, blend: resolveBlendMode(member) })
        continue
      }
      const layer = await this.#raster({ ...member, blendMode: 'normal' } as SceneElement, mode, width, height, warnings)
      for (let index = 3; index < layer.length; index += 4) if (shape[index] === 0) layer[index] = 0
      compositeOver(pixels, layer, resolveBlendMode(member))
    }
    for (let pixel = 0; pixel < coverage.length; pixel += 1) pixels[pixel * 4 + 3] = Math.round(pixels[pixel * 4 + 3]! * coverage[pixel]! / 255)
    const png = await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer()
    return `<g opacity="${finite(base.opacity)}"${blendModeToSvgStyle(resolveBlendMode(base))}><image x="0" y="0" width="${width}" height="${height}" href="data:image/png;base64,${png.toString('base64')}" preserveAspectRatio="none"/></g>`
  }

  async render(sceneInput: Scene, mode: RenderMode = 'reference'): Promise<CompositeRenderResult> {
    const scene = sceneSchema.parse(sceneInput)
    const width = scene.canvas.outputWidth
    const height = scene.canvas.outputHeight
    const warnings: string[] = []
    let layers: string[] = []
    const hiddenInGroups = hiddenByGroups(scene.elements)
    const background = scene.canvas.transparent ? 'none' : escapeXml(scene.canvas.backgroundColor)
    // What lies under the layers still to draw: the canvas colour, then the picture so far once an adjustment layer has changed it.
    let base = `<rect width="${width}" height="${height}" fill="${background}"/>`
    const svg = (): string => `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">${base}<g clip-path="url(#canvas-clip)"><defs><clipPath id="canvas-clip"><rect width="${width}" height="${height}"/></clipPath></defs>${layers.join('')}</g></svg>`
    const stacks = clipStacks(scene.elements)
    const clipped = new Set([...stacks.values()].flatMap((stack) => stack.memberIds))
    for (const element of scene.elements) {
      if (hiddenInGroups.has(element.id)) continue
      // A clipped layer is drawn with its base; hidden with it too.
      if (clipped.has(element.id)) continue
      const stack = stacks.get(element.id)
      if (stack !== undefined) {
        if (elementPresentation(element, mode) !== 'omit') layers.push(await this.#clipStackSvg(scene, element, stack, mode, hiddenInGroups, warnings))
        continue
      }
      if (element.type === 'adjustment') {
        if (elementPresentation(element, mode) === 'omit') continue
        // An adjustment layer changes everything drawn so far: draw it, adjust it, and go on over the result.
        const below = await sharp(Buffer.from(svg())).ensureAlpha().raw().toBuffer()
        const mask = element.mask
        // The mask's paint is replayed at its own size, then sampled over the canvas, as the canvas does it.
        const own = mask === null || mask === undefined || !mask.enabled ? null : await layerMaskCoverage(mask, this.#resolveAsset)
        const coverage = own === null ? null : sampleCoverage({ width: own.width, height: own.height, data: own.coverage }, width, height, { scaleX: own.width / width, scaleY: own.height / height, offsetX: 0, offsetY: 0 })
        adjustPixels(below, element.settings, { coverage, amount: element.opacity, blend: resolveBlendMode(element) })
        const adjusted = await sharp(below, { raw: { width, height, channels: 4 } }).png().toBuffer()
        base = `<image x="0" y="0" width="${width}" height="${height}" href="data:image/png;base64,${adjusted.toString('base64')}" preserveAspectRatio="none"/>`
        layers = []
        continue
      }
      layers.push(await elementSvg(element, mode, width, height, this.#resolveAsset, warnings))
    }
    const buffer = await sharp(Buffer.from(svg())).png({ compressionLevel: 9, adaptiveFiltering: false }).toBuffer()
    return { buffer, warnings }
  }
}
