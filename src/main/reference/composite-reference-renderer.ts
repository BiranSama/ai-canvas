import sharp from 'sharp'
import { pathInBox, sceneSchema, type ImageEffects, type Scene, type SceneElement } from '../../domain'
import { applyImageEffects, hasVisibleEffects, shadowGeometry, shadowSilhouette } from '../../shared/layer-effects'
import { layerMaskCoverage, paintedImageBytes } from '../paint/painted-image'
import type { RenderMode } from '../../shared/reference'
import { blendModeToSvgStyle, resolveBlendMode } from '../../shared/blend-mode'
import { layoutTextLines } from './text-layout'

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

async function imageDataUri(path: string | Buffer, element: Extract<SceneElement, { type: 'image' }>): Promise<string> {
  const metadata = await sharp(path).metadata()
  const width = metadata.width ?? 1
  const height = metadata.height ?? 1
  const crop = element.crop
  const left = Math.min(width - 1, Math.max(0, Math.round(crop.x * width)))
  const top = Math.min(height - 1, Math.max(0, Math.round(crop.y * height)))
  const cropWidth = Math.max(1, Math.min(width - left, Math.round(crop.width * width)))
  const cropHeight = Math.max(1, Math.min(height - top, Math.round(crop.height * height)))
  const cropped = await sharp(path).extract({ left, top, width: cropWidth, height: cropHeight }).png().toBuffer()
  return `data:image/png;base64,${cropped.toString('base64')}`
}

/**
 * The image drawn into its box with its effects applied, and its shadow
 * beneath, as the canvas draws them.
 */
async function imageWithEffects(
  uri: string,
  element: Extract<SceneElement, { type: 'image' }>,
  effects: ImageEffects,
  box: { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
): Promise<string> {
  const width = Math.max(1, Math.round(box.w))
  const height = Math.max(1, Math.round(box.h))
  const pixels = await sharp(Buffer.from(uri.slice(uri.indexOf(',') + 1), 'base64'))
    .resize(width, height, { fit: element.fit, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .ensureAlpha()
    .raw()
    .toBuffer()
  applyImageEffects(pixels, width, height, effects)
  const drawn = await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer()
  let shadow = ''
  if (effects.shadow !== null && effects.shadow.opacity > 0) {
    const geometry = shadowGeometry(effects.shadow, width, height)
    const silhouette = sharp(Buffer.from(shadowSilhouette(pixels, width, height, effects.shadow)), { raw: { width, height, channels: 4 } })
      .extend({ top: geometry.padding, bottom: geometry.padding, left: geometry.padding, right: geometry.padding, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    const blurred = await (geometry.sigma >= 0.3 ? silhouette.blur(geometry.sigma) : silhouette).png().toBuffer()
    shadow = `<image x="${finite(box.x - geometry.padding + geometry.offsetX)}" y="${finite(box.y - geometry.padding + geometry.offsetY)}" width="${width + geometry.padding * 2}" height="${height + geometry.padding * 2}" href="data:image/png;base64,${blurred.toString('base64')}" preserveAspectRatio="none"/>`
  }
  return `${shadow}<image x="${finite(box.x)}" y="${finite(box.y)}" width="${finite(box.w)}" height="${finite(box.h)}" href="data:image/png;base64,${drawn.toString('base64')}" preserveAspectRatio="none"/>`
}

function transform(element: SceneElement, width: number, height: number): { x: number; y: number; w: number; h: number; rotate: string } {
  const x = element.transform.x * width
  const y = element.transform.y * height
  const w = element.transform.width * width
  const h = element.transform.height * height
  const cx = x + w / 2
  const cy = y + h / 2
  return { x, y, w, h, rotate: `rotate(${finite(element.transform.rotation)} ${finite(cx)} ${finite(cy)})` }
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
  const box = transform(element, width, height)
  const opacity = finite(element.opacity)
  const layerMask = await layerMaskSvg(element, box, resolveAsset)
  const groupStart = `${layerMask.defs}<g opacity="${opacity}" transform="${box.rotate}"${blendModeToSvgStyle(resolveBlendMode(element))}${layerMask.attribute}>`
  const groupEnd = '</g>'

  if (element.type === 'image') {
    const path = await resolveAsset(element.assetId)
    if (path === null) {
      warnings.push(`图片元素“${element.name}”的素材不可用，参考图中已保留中性边界。`)
      return `${groupStart}<rect x="${finite(box.x)}" y="${finite(box.y)}" width="${finite(box.w)}" height="${finite(box.h)}" rx="${finite(Math.min(box.w, box.h) * .04)}" fill="#AEB8C4" fill-opacity=".24" stroke="#8090A2" stroke-width="${finite(Math.max(1, width * .0015))}"/>${groupEnd}`
    }
    try {
      const masked = element.mask !== null && element.mask !== undefined && element.mask.enabled
      const painted = (element.paint !== undefined && element.paint.length > 0) || masked ? await paintedImageBytes(path, element.paint, resolveAsset, element.mask ?? null) : path
      const uri = await imageDataUri(painted, element)
      if (hasVisibleEffects(element.effects)) return `${groupStart}${await imageWithEffects(uri, element, element.effects, box)}${groupEnd}`
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
        const bytes = await sharp(path).png().toBuffer()
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

  async render(sceneInput: Scene, mode: RenderMode = 'reference'): Promise<CompositeRenderResult> {
    const scene = sceneSchema.parse(sceneInput)
    const width = scene.canvas.outputWidth
    const height = scene.canvas.outputHeight
    const warnings: string[] = []
    const layers: string[] = []
    for (const element of scene.elements) {
      layers.push(await elementSvg(element, mode, width, height, this.#resolveAsset, warnings))
    }
    const background = scene.canvas.transparent ? 'none' : escapeXml(scene.canvas.backgroundColor)
    const svg = `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg"><rect width="${width}" height="${height}" fill="${background}"/><g clip-path="url(#canvas-clip)"><defs><clipPath id="canvas-clip"><rect width="${width}" height="${height}"/></clipPath></defs>${layers.join('')}</g></svg>`
    const buffer = await sharp(Buffer.from(svg)).png({ compressionLevel: 9, adaptiveFiltering: false }).toBuffer()
    return { buffer, warnings }
  }
}
