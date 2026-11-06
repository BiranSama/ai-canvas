import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { hiddenByGroups, type Scene, type SceneElement } from '../../../domain'
import { blendModeToCanvasOperation, resolveBlendMode } from '../../../shared/blend-mode'
import { applyMaskAlpha, applyPaintOps, maskCoverage, paintClipIds } from '../../../shared/paint-ops'
import { getRuntimeAssetUrl, isRuntimeAssetMissing, subscribeRuntimeAssets } from '../assets/runtime-assets'
import { clipLookup, grayAssetPixels, subscribeAssetPixels } from './asset-pixels'
import { ArtworkStage, type LayerDraw } from './artwork-stage'
import { isFinalContent } from './layer-drawing'

/*
 * Draws a scene away from the screen, at any pixel size, with the canvas's
 * own layer drawing: exports use it, so the file is what the canvas shows,
 * never the canvas at its on-screen size scaled up. Everything a layer
 * needs (its image, the paint replayed on it, its mask, its fonts) is read
 * first; each layer is drawn from its own copy, so the canvas's live pixel
 * layers are never touched.
 */

type ImageElement = Extract<SceneElement, { type: 'image' }>
type MaskedElement = Extract<SceneElement, { type: 'image' | 'text' | 'shape' }>

export class ArtworkRenderError extends Error {}

/**
 * How a layer's mask applies: as the scene has it, not at all (a PSD keeps
 * it apart), as if it were on, or the mask alone: white where it shows the
 * layer, drawn in the layer's place, for a PSD's layer mask.
 */
export type MaskUse = 'scene' | 'off' | 'on' | 'only'

export interface LayerRequest {
  readonly id: string
  readonly mask: MaskUse
  /** False draws text without its stroke and shadow, which a PSD adds back as layer styles. */
  readonly textEffects: boolean
}

export interface ArtworkRequest {
  readonly width: number
  readonly height: number
  /** What is behind the layers: the canvas's colour (nothing when it is transparent), nothing, or this colour. */
  readonly background: 'canvas' | 'none' | { readonly color: string }
  /**
   * One layer on its own, shown even if hidden, at full opacity and in
   * normal blend, since a PSD keeps those apart; every exported layer when
   * left out.
   */
  readonly layer?: LayerRequest
  /**
   * The part to draw, in the picture's pixels, which may reach past its
   * edges; the whole picture, cut at its edges, when left out. Only a layer
   * drawn on its own goes past them.
   */
  readonly area?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
}

const WAIT_MS = 30_000

function abortError(): DOMException {
  return new DOMException('导出已取消。', 'AbortError')
}

/** Waits until read gives a value, re-reading whenever subscribe says something changed. */
function waitFor<T>(read: () => T | null, subscribe: (listener: () => void) => () => void, signal: AbortSignal | undefined, what: string): Promise<T> {
  const first = read()
  if (first !== null) return Promise.resolve(first)
  return new Promise<T>((resolve, reject) => {
    let unsubscribe = (): void => {}
    const finish = (): void => {
      unsubscribe()
      window.clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    const onAbort = (): void => {
      finish()
      reject(abortError())
    }
    const timer = window.setTimeout(() => {
      finish()
      reject(new ArtworkRenderError(`${what}一直没读出来，请稍后再试。`))
    }, WAIT_MS)
    signal?.addEventListener('abort', onAbort)
    unsubscribe = subscribe(() => {
      try {
        const value = read()
        if (value === null) return
        finish()
        resolve(value)
      } catch (error) {
        finish()
        reject(error)
      }
    })
  })
}

function context2d(width: number, height: number): { readonly canvas: HTMLCanvasElement; readonly context: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, width)
  canvas.height = Math.max(1, height)
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (context === null) throw new ArtworkRenderError('这台电脑上画不出这么大的图，换小一点的尺寸再试。')
  return { canvas, context }
}

async function loadImage(url: string): Promise<HTMLImageElement> {
  const image = new window.Image()
  image.src = url
  await image.decode()
  return image
}

/** Whether this browser draws the blend mode itself; without it a layer would blend wrongly, so the export stops. */
function blendSupported(element: SceneElement): boolean {
  const operation = blendModeToCanvasOperation(resolveBlendMode(element))
  if (operation === 'source-over') return true
  const context = document.createElement('canvas').getContext('2d')
  if (context === null) return false
  context.globalCompositeOperation = operation
  return context.globalCompositeOperation === operation
}

/** The layers a picture shows, bottom first: exported kinds, visible, in no hidden group. */
export function exportedLayers(scene: Scene): readonly SceneElement[] {
  const hidden = hiddenByGroups(scene.elements)
  return [...scene.elements]
    .sort((left, right) => left.zIndex - right.zIndex)
    .filter((element) => element.type !== 'group' && isFinalContent(element) && element.visible && !hidden.has(element.id))
}

/** The clips a layer's paint was limited to, read beforehand; an export never draws paint without them. */
function readClips(element: SceneElement, ops: Parameters<typeof paintClipIds>[0], size: { readonly width: number; readonly height: number }): ReadonlyMap<string, Uint8Array> {
  const clips = clipLookup(paintClipIds(ops), size)
  if (clips === null) throw new ArtworkRenderError(`图层「${element.name}」的笔触范围还没读出来，请稍后再导出。`)
  return clips
}

function maskApplies(element: MaskedElement, use: MaskUse): boolean {
  const mask = element.mask ?? null
  return mask !== null && (use === 'on' || use === 'only' || (use === 'scene' && mask.enabled))
}

/**
 * A scene read for drawing. Prepare it once, render it as often as
 * needed (the whole picture, each layer, at any size), then dispose of it.
 */
export class ArtworkSession {
  readonly scene: Scene
  readonly #images = new Map<string, HTMLImageElement>()
  readonly #sources = new Map<string, HTMLImageElement | HTMLCanvasElement>()
  readonly #maskAlpha = new Map<string, HTMLCanvasElement>()
  #container: HTMLDivElement | null = null
  #root: Root | null = null

  private constructor(scene: Scene) {
    this.scene = scene
  }

  /**
   * Reads what the layers to be drawn need: those the picture shows, or
   * with includeHidden every exported kind, hidden ones too, as a PSD keeps
   * them. A layer that is not drawn never holds an export up.
   */
  static async prepare(scene: Scene, signal?: AbortSignal, options: { readonly includeHidden?: boolean } = {}): Promise<ArtworkSession> {
    const session = new ArtworkSession(scene)
    const drawable = options.includeHidden === true
      ? scene.elements.filter((element) => element.type !== 'group' && isFinalContent(element))
      : exportedLayers(scene)
    const unblendable = exportedLayers(scene).find((element) => !blendSupported(element))
    if (unblendable !== undefined) throw new ArtworkRenderError(`这台电脑的图形环境画不出「${unblendable.name}」的混合模式，导出出来会和画布不一样，所以先停下了。`)
    for (const element of drawable) {
      if (signal?.aborted === true) throw abortError()
      if (element.type === 'image') await session.#readImage(element, signal)
      if ((element.type === 'image' || element.type === 'text' || element.type === 'shape') && element.mask !== null && element.mask !== undefined) {
        await session.#readMask(element, signal)
      }
    }
    await session.#readFonts(drawable, signal)
    return session
  }

  async #readImage(element: ImageElement, signal: AbortSignal | undefined): Promise<void> {
    let image = this.#images.get(element.assetId)
    if (image === undefined) {
      const url = await waitFor(() => {
        if (isRuntimeAssetMissing(element.assetId)) throw new ArtworkRenderError(`图层「${element.name}」的图片读不出来，请重新导入原文件后再导出。`)
        return getRuntimeAssetUrl(element.assetId)
      }, subscribeRuntimeAssets, signal, `图层「${element.name}」的图片`)
      image = await loadImage(url)
      this.#images.set(element.assetId, image)
    }
    // Layers can share a picture and still be painted differently: each waits for its own clips.
    const size = { width: image.naturalWidth, height: image.naturalHeight }
    const clipIds = paintClipIds(element.paint)
    if (clipIds.length > 0) await waitFor(() => clipLookup(clipIds, size), subscribeAssetPixels, signal, `图层「${element.name}」的笔触范围`)
  }

  async #readMask(element: MaskedElement, signal: AbortSignal | undefined): Promise<void> {
    const mask = element.mask!
    const size = element.type === 'image' ? this.#imageSize(element) : null
    const gray = await waitFor(() => grayAssetPixels(mask.assetId, size), subscribeAssetPixels, signal, `图层「${element.name}」的蒙版`)
    const clipIds = paintClipIds(mask.paint)
    if (clipIds.length > 0) await waitFor(() => clipLookup(clipIds, { width: gray.width, height: gray.height }), subscribeAssetPixels, signal, `图层「${element.name}」的蒙版`)
  }

  async #readFonts(elements: readonly SceneElement[], signal: AbortSignal | undefined): Promise<void> {
    const faces = new Set(elements.flatMap((element) => element.type === 'text' ? [`${element.fontWeight} 48px "${element.fontFamily.replaceAll('"', '')}"`] : []))
    for (const face of faces) {
      if (signal?.aborted === true) throw abortError()
      // A font that cannot be loaded falls back the same way the canvas does.
      await document.fonts.load(face).catch(() => [])
    }
  }

  #imageSize(element: ImageElement): { readonly width: number; readonly height: number } {
    const image = this.#images.get(element.assetId)
    if (image === undefined) throw new ArtworkRenderError(`图层「${element.name}」的图片还没读出来。`)
    return { width: image.naturalWidth, height: image.naturalHeight }
  }

  /** The image layer's pixels with its paint replayed and, when it applies, its mask: its own copy, not the canvas's. */
  #imageSource(element: ImageElement, use: MaskUse): HTMLImageElement | HTMLCanvasElement {
    const image = this.#images.get(element.assetId)
    if (image === undefined) throw new ArtworkRenderError(`图层「${element.name}」的图片还没读出来。`)
    if (use === 'only') return this.#imageMaskSource(element, image)
    const ops = element.paint ?? []
    const masked = maskApplies(element, use)
    if (ops.length === 0 && !masked) return image
    const key = `${element.id}|${masked ? 'masked' : 'plain'}`
    const known = this.#sources.get(key)
    if (known !== undefined) return known
    const width = image.naturalWidth
    const height = image.naturalHeight
    const { canvas, context } = context2d(width, height)
    context.drawImage(image, 0, 0)
    const pixels = context.getImageData(0, 0, width, height)
    if (ops.length > 0) applyPaintOps(pixels.data, width, height, ops, readClips(element, ops, { width, height }))
    if (masked) {
      const mask = element.mask!
      const gray = grayAssetPixels(mask.assetId, { width, height })
      if (gray === null) throw new ArtworkRenderError(`图层「${element.name}」的蒙版还没读出来。`)
      const coverage = maskCoverage(gray.data, width, height, mask.paint, readClips(element, mask.paint, { width, height }))
      applyMaskAlpha(pixels.data, pixels.data, coverage, width)
    }
    context.putImageData(pixels, 0, 0)
    this.#sources.set(key, canvas)
    return canvas
  }

  /** An image layer's mask alone, at the image's size: white, as opaque as the mask shows the layer. */
  #imageMaskSource(element: ImageElement, image: HTMLImageElement): HTMLCanvasElement {
    const key = `${element.id}|mask`
    const known = this.#sources.get(key)
    if (known instanceof HTMLCanvasElement) return known
    const width = image.naturalWidth
    const height = image.naturalHeight
    const mask = element.mask
    if (mask === null || mask === undefined) throw new ArtworkRenderError(`图层「${element.name}」没有蒙版。`)
    const gray = grayAssetPixels(mask.assetId, { width, height })
    if (gray === null) throw new ArtworkRenderError(`图层「${element.name}」的蒙版还没读出来。`)
    const coverage = maskCoverage(gray.data, width, height, mask.paint, readClips(element, mask.paint, { width, height }))
    const { canvas, context } = context2d(width, height)
    const pixels = context.createImageData(width, height)
    for (let index = 0; index < coverage.length; index += 1) pixels.data.set([255, 255, 255, coverage[index]!], index * 4)
    context.putImageData(pixels, 0, 0)
    this.#sources.set(key, canvas)
    return canvas
  }

  /** A text or shape layer's mask as transparency over its box. */
  #boxMaskAlpha(element: Extract<SceneElement, { type: 'text' | 'shape' }>): HTMLCanvasElement {
    const known = this.#maskAlpha.get(element.id)
    if (known !== undefined) return known
    const mask = element.mask!
    const gray = grayAssetPixels(mask.assetId)
    if (gray === null) throw new ArtworkRenderError(`图层「${element.name}」的蒙版还没读出来。`)
    const coverage = maskCoverage(gray.data, gray.width, gray.height, mask.paint, readClips(element, mask.paint, { width: gray.width, height: gray.height }))
    const { canvas, context } = context2d(gray.width, gray.height)
    const image = context.createImageData(gray.width, gray.height)
    for (let index = 0; index < coverage.length; index += 1) image.data[index * 4 + 3] = coverage[index]!
    context.putImageData(image, 0, 0)
    this.#maskAlpha.set(element.id, canvas)
    return canvas
  }

  /** The picture, or one layer of it, at this size. */
  render(request: ArtworkRequest): HTMLCanvasElement {
    const width = Math.max(1, Math.round(request.width))
    const height = Math.max(1, Math.round(request.height))
    const layer = request.layer
    const elements = layer === undefined
      ? exportedLayers(this.scene)
      : this.scene.elements.filter((element) => element.id === layer.id && element.type !== 'group')
    if (layer !== undefined && elements.length === 0) throw new ArtworkRenderError('要导出的图层已经不在了。')
    const background = request.background === 'canvas'
      ? this.scene.canvas.transparent ? null : this.scene.canvas.backgroundColor
      : request.background === 'none' ? null : request.background.color
    const outputScale = height / this.scene.canvas.outputHeight
    const area = request.area === undefined
      ? { x: 0, y: 0, width, height }
      : { x: Math.round(request.area.x), y: Math.round(request.area.y), width: Math.max(1, Math.round(request.area.width)), height: Math.max(1, Math.round(request.area.height)) }
    const draws = elements.map((element) => this.#layerDraw(element, layer, width, height))

    if (this.#container === null) {
      const container = document.createElement('div')
      container.setAttribute('aria-hidden', 'true')
      container.style.cssText = 'position:fixed;left:-10000px;top:0;width:1px;height:1px;overflow:hidden;pointer-events:none;'
      document.body.appendChild(container)
      this.#container = container
      this.#root = createRoot(container)
    }
    let result: HTMLCanvasElement | null = null
    let failure: unknown = null
    flushSync(() => {
      this.#root!.render(
        <ArtworkStage
          width={width}
          height={height}
          background={background}
          outputScale={outputScale}
          draws={draws}
          clip={request.area === undefined}
          onDrawn={(layerNode) => {
            try {
              result = layerNode.toCanvas({ x: area.x, y: area.y, width: area.width, height: area.height, pixelRatio: 1 })
            } catch (error) {
              failure = error
            }
          }}
        />
      )
    })
    if (failure !== null) throw failure instanceof Error ? failure : new ArtworkRenderError(String(failure))
    if (result === null) throw new ArtworkRenderError('这一层没画出来，请再试一次。')
    return result
  }

  #layerDraw(element: SceneElement, layer: LayerRequest | undefined, width: number, height: number): LayerDraw {
    const use: MaskUse = layer?.mask ?? 'scene'
    const isolated = layer !== undefined
    const maskOnly = use === 'only'
    return {
      // The mask alone ignores the image's effects: they follow its outline, not the mask.
      element: maskOnly && element.type === 'image' ? { ...element, effects: undefined } : element,
      maskOnly,
      x: element.transform.x * width,
      y: element.transform.y * height,
      width: element.transform.width * width,
      height: element.transform.height * height,
      opacity: isolated ? 1 : element.opacity,
      operation: isolated ? 'source-over' : blendModeToCanvasOperation(resolveBlendMode(element)),
      textEffects: layer?.textEffects ?? true,
      image: element.type === 'image' ? this.#imageSource(element, use) : null,
      maskAlpha: (element.type === 'text' || element.type === 'shape') && maskApplies(element, use) ? this.#boxMaskAlpha(element) : null
    }
  }

  dispose(): void {
    this.#root?.unmount()
    this.#container?.remove()
    this.#root = null
    this.#container = null
    this.#sources.clear()
    this.#maskAlpha.clear()
  }
}

/** The pixels of a drawn canvas. */
export function canvasPixels(canvas: HTMLCanvasElement): ImageData {
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (context === null) throw new ArtworkRenderError('读不出画好的像素。')
  return context.getImageData(0, 0, canvas.width, canvas.height)
}
