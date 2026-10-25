import sharp from 'sharp'
import type { Scene, SceneElement } from '../../domain'
import { boxLayerSpace, boxMaskSize, canvasToLayer, imageLayerSpace, maskInLayerSpace, type LayerSpace, type Size } from '../../shared/layer-space'
import { combineMasks, createMask, ellipseMask, featherMask, invertMask, polygonMask, rectMask, type GrayMask, type MaskCombine } from '../../shared/mask-raster'
import { imageBytes } from '../storage/image-file'
import { layerMaskCoverage, paintedImageBytes, type PaintAssetResolver } from './painted-image'

/*
 * A layer mask built for the agent, in the layer's own pixels as the canvas
 * keeps it: an image layer's in its asset's pixels, a text or shape layer's
 * over its box. Shapes are drawn on the canvas and read into those pixels;
 * the subject of a picture layer is found in its own pixels.
 */

type PictureLayer = Extract<SceneElement, { type: 'image' | 'text' | 'shape' }>

export type LayerMaskShape =
  | { readonly kind: 'subject' }
  /** The layer's mask as it is now, to invert or feather it. */
  | { readonly kind: 'current' }
  /** Fractions of the canvas. */
  | { readonly kind: 'box' | 'ellipse'; readonly box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number } }
  /** Closed outlines in fractions of the canvas, such as the person's selection. */
  | { readonly kind: 'polygons'; readonly polygons: readonly (readonly { readonly x: number; readonly y: number }[])[] }

export interface LayerMaskSpec {
  readonly elementId: string
  readonly shape: LayerMaskShape
  /** How the shape meets the layer's current mask; replace ignores it. */
  readonly combine: MaskCombine
  /** Hides the shape instead of showing it. */
  readonly invert: boolean
  /** Soft edge in canvas pixels either side. */
  readonly feather: number
}

export interface LayerMaskDeps {
  readonly resolveAsset: PaintAssetResolver
  readonly assetSize: (assetId: string) => Promise<Size | null>
  /** The subject's coverage over a picture at its size; null when the model is not on this computer. */
  readonly subject: ((rgba: Uint8Array<ArrayBuffer>, width: number, height: number) => Promise<Uint8Array>) | null
}

/** The model is never quite sure the background is not the subject; faint values would only spread the mask. */
const FAINT = 16

function isPictureLayer(element: SceneElement): element is PictureLayer {
  return element.type === 'image' || element.type === 'text' || element.type === 'shape'
}

async function layerSpace(element: PictureLayer, scene: Scene, deps: LayerMaskDeps): Promise<LayerSpace | string> {
  const canvas = { width: scene.canvas.outputWidth, height: scene.canvas.outputHeight }
  if (element.type === 'image') {
    const size = await deps.assetSize(element.assetId)
    return size === null ? '现在读不到这张图的像素。' : imageLayerSpace(element, size, canvas)
  }
  // A mask already on the layer keeps its size, so the new one lines up with it.
  const current = element.mask === null || element.mask === undefined ? null : await deps.assetSize(element.mask.assetId)
  return boxLayerSpace(element, current ?? boxMaskSize(element, canvas), canvas)
}

async function subjectOf(element: PictureLayer, deps: LayerMaskDeps): Promise<GrayMask | string> {
  if (element.type !== 'image') return '主体只能在图片图层上找。'
  if (deps.subject === null) return '选择主体用的模型还没有下载。'
  const source = await deps.resolveAsset(element.assetId)
  if (source === null) return '现在读不到这张图的像素。'
  const bytes = (element.paint?.length ?? 0) === 0 ? await imageBytes(source) : await paintedImageBytes(source, element.paint, deps.resolveAsset)
  const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const coverage = await deps.subject(new Uint8Array(data), info.width, info.height)
  // Only what the layer covers can be its subject.
  for (let index = 0; index < coverage.length; index += 1) coverage[index] = coverage[index]! < FAINT ? 0 : Math.round(coverage[index]! * data[index * 4 + 3]! / 255)
  return { width: info.width, height: info.height, data: coverage }
}

function shapeOnCanvas(shape: Extract<LayerMaskShape, { kind: 'box' | 'ellipse' | 'polygons' }>, canvas: Size): GrayMask {
  if (shape.kind !== 'polygons') {
    const rect = { x: shape.box.x * canvas.width, y: shape.box.y * canvas.height, width: shape.box.width * canvas.width, height: shape.box.height * canvas.height }
    return shape.kind === 'box' ? rectMask(canvas.width, canvas.height, rect) : ellipseMask(canvas.width, canvas.height, rect)
  }
  let mask = createMask(canvas.width, canvas.height)
  for (const outline of shape.polygons) {
    const points = outline.flatMap((point) => [point.x * canvas.width, point.y * canvas.height])
    mask = combineMasks(mask, polygonMask(canvas.width, canvas.height, points), 'add')
  }
  return mask
}

/** The new mask's pixels in the layer's space, or why it cannot be built. */
export async function buildLayerMask(scene: Scene, spec: LayerMaskSpec, deps: LayerMaskDeps): Promise<GrayMask | string> {
  const element = scene.elements.find((candidate) => candidate.id === spec.elementId)
  if (element === undefined || !isPictureLayer(element)) return '只能给图片、文字和形状图层加蒙版。'
  const space = await layerSpace(element, scene, deps)
  if (typeof space === 'string') return space
  const current = element.mask === null || element.mask === undefined ? null : await layerMaskCoverage(element.mask, deps.resolveAsset, space)
  const existing = current === null ? null : { width: current.width, height: current.height, data: current.coverage }

  let shape: GrayMask
  if (spec.shape.kind === 'subject') {
    const found = await subjectOf(element, deps)
    if (typeof found === 'string') return found
    shape = found
  } else if (spec.shape.kind === 'current') {
    if (existing === null) return '这个图层还没有蒙版。'
    shape = existing
  } else {
    const canvas = { width: scene.canvas.outputWidth, height: scene.canvas.outputHeight }
    shape = { width: space.width, height: space.height, data: maskInLayerSpace(shapeOnCanvas(spec.shape, canvas), space) }
  }
  // The feather is given on the canvas; the layer's pixels may be finer or coarser.
  if (spec.feather > 0) shape = featherMask(shape, spec.feather * canvasToLayer(space).scale)
  if (spec.invert) shape = invertMask(shape)
  if (spec.shape.kind === 'current') return shape
  // A layer without a mask shows all of itself, so adding to it shows everything and subtracting hides the shape.
  const base = existing ?? { width: shape.width, height: shape.height, data: new Uint8Array(shape.data.length).fill(255) }
  return combineMasks(base, shape, spec.combine)
}
