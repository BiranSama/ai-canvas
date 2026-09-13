import type { Canvas, Scene, SceneCommand, SceneElement } from '..'

export interface AspectRatioValue {
  readonly width: number
  readonly height: number
}

export type CanvasResizeStrategy = 'keep-position' | 'fit-content' | 'keep-center'

export interface AspectRatioParseResult {
  readonly value: AspectRatioValue | null
  readonly error: string | null
}

function gcd(left: number, right: number): number {
  let a = Math.abs(Math.round(left))
  let b = Math.abs(Math.round(right))
  while (b !== 0) [a, b] = [b, a % b]
  return Math.max(1, a)
}

export function simplifyAspectRatio(width: number, height: number): AspectRatioValue {
  const divisor = gcd(width, height)
  return { width: Math.round(width / divisor), height: Math.round(height / divisor) }
}

function approximateRatio(ratio: number): AspectRatioValue {
  let best = { width: 1, height: 1, error: Number.POSITIVE_INFINITY, sum: 2 }
  for (let height = 1; height <= 100; height += 1) {
    const width = Math.round(ratio * height)
    if (width < 1 || width > 100) continue
    const error = Math.abs(width / height - ratio)
    if (error < best.error - 1e-10 || (Math.abs(error - best.error) < 1e-10 && width + height < best.sum)) {
      best = { width, height, error, sum: width + height }
    }
  }
  return simplifyAspectRatio(best.width, best.height)
}

export function parseAspectRatio(input: string): AspectRatioParseResult {
  const match = input.trim().match(/^(\d+(?:\.\d+)?)\s*[:：xX×/]\s*(\d+(?:\.\d+)?)$/)
  if (match === null) return { value: null, error: '请输入 W:H，例如 7:5。' }
  const width = Number(match[1])
  const height = Number(match[2])
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { value: null, error: '比例必须是两个正数。' }
  }
  const ratio = width / height
  if (ratio < 0.1 || ratio > 10) return { value: null, error: '支持 1:10 到 10:1 之间的比例。' }
  return { value: approximateRatio(ratio), error: null }
}

export function calculateOutputSize(
  ratio: AspectRatioValue,
  longEdge = 1280,
  multiple = 1
): { readonly width: number; readonly height: number } {
  const safeLongEdge = Math.max(64, Math.min(16384, Math.round(longEdge)))
  const safeMultiple = Math.max(1, Math.round(multiple))
  const round = (value: number): number => Math.max(64, Math.min(16384, Math.round(value / safeMultiple) * safeMultiple))
  return ratio.width >= ratio.height
    ? { width: round(safeLongEdge), height: round(safeLongEdge * ratio.height / ratio.width) }
    : { width: round(safeLongEdge * ratio.width / ratio.height), height: round(safeLongEdge) }
}

export function normalizedToPixels(transform: SceneElement['transform'], canvas: Canvas): SceneElement['transform'] {
  return {
    x: transform.x * canvas.outputWidth,
    y: transform.y * canvas.outputHeight,
    width: transform.width * canvas.outputWidth,
    height: transform.height * canvas.outputHeight,
    rotation: transform.rotation
  }
}

export function pixelsToNormalized(transform: SceneElement['transform'], canvas: Canvas): SceneElement['transform'] {
  return {
    x: transform.x / canvas.outputWidth,
    y: transform.y / canvas.outputHeight,
    width: Math.max(0.001, transform.width / canvas.outputWidth),
    height: Math.max(0.001, transform.height / canvas.outputHeight),
    rotation: transform.rotation
  }
}

function isFullCanvasBackground(element: SceneElement): boolean {
  return element.semanticRole === 'background' && element.transform.x === 0 && element.transform.y === 0 && element.transform.width === 1 && element.transform.height === 1
}

export function createCanvasResizeCommands(
  scene: Scene,
  nextCanvas: Canvas,
  strategy: CanvasResizeStrategy
): readonly SceneCommand[] {
  const commands: SceneCommand[] = [{ kind: 'scene.set-canvas', canvas: nextCanvas }]
  if (strategy === 'keep-position') return commands
  const content = scene.elements.filter((element) => element.type !== 'group' && !isFullCanvasBackground(element))
  if (content.length === 0) return commands

  if (strategy === 'keep-center') {
    for (const element of scene.elements) {
      if (isFullCanvasBackground(element)) continue
      const pixels = normalizedToPixels(element.transform, scene.canvas)
      const oldCenter = { x: scene.canvas.outputWidth / 2, y: scene.canvas.outputHeight / 2 }
      const nextCenter = { x: nextCanvas.outputWidth / 2, y: nextCanvas.outputHeight / 2 }
      const nextPixels = {
        ...pixels,
        x: nextCenter.x + pixels.x - oldCenter.x,
        y: nextCenter.y + pixels.y - oldCenter.y
      }
      commands.push({ kind: 'element.update', elementId: element.id, changes: { transform: pixelsToNormalized(nextPixels, nextCanvas) } })
    }
    return commands
  }

  const pixelTransforms = content.map((element) => normalizedToPixels(element.transform, scene.canvas))
  const left = Math.min(...pixelTransforms.map((transform) => transform.x))
  const top = Math.min(...pixelTransforms.map((transform) => transform.y))
  const right = Math.max(...pixelTransforms.map((transform) => transform.x + transform.width))
  const bottom = Math.max(...pixelTransforms.map((transform) => transform.y + transform.height))
  const contentWidth = Math.max(1, right - left)
  const contentHeight = Math.max(1, bottom - top)
  const availableWidth = nextCanvas.outputWidth * 0.9
  const availableHeight = nextCanvas.outputHeight * 0.9
  const scale = Math.min(availableWidth / contentWidth, availableHeight / contentHeight)
  const targetLeft = (nextCanvas.outputWidth - contentWidth * scale) / 2
  const targetTop = (nextCanvas.outputHeight - contentHeight * scale) / 2
  for (const element of scene.elements) {
    if (isFullCanvasBackground(element)) continue
    const pixels = normalizedToPixels(element.transform, scene.canvas)
    const nextPixels = {
      x: targetLeft + (pixels.x - left) * scale,
      y: targetTop + (pixels.y - top) * scale,
      width: pixels.width * scale,
      height: pixels.height * scale,
      rotation: pixels.rotation
    }
    commands.push({ kind: 'element.update', elementId: element.id, changes: { transform: pixelsToNormalized(nextPixels, nextCanvas) } })
  }
  return commands
}
