import { InteractiveSegmenter } from '@mediapipe/tasks-vision'
import loaderUrl from '@mediapipe/tasks-vision/vision_wasm_internal.js?url'
import type { GrayMask } from '../../../shared/mask-raster'

/*
 * The object selection's click: MediaPipe's Magic Touch (Apache 2.0, 6 MB,
 * shipped with the app) finds the object under a point. The page cannot
 * fetch files from its own folder, so Main hands over the model and the
 * WebAssembly as bytes.
 */

/** The longest side a picture is read at; the model works at 512 itself. */
const MAX_SIDE = 1024

let segmenter: Promise<InteractiveSegmenter> | null = null

/** A real graphics card runs the model quicker than the processor; a software one does not. */
function hardwareGraphics(): boolean {
  const context = document.createElement('canvas').getContext('webgl2')
  if (context === null) return false
  const info = context.getExtension('WEBGL_debug_renderer_info')
  const renderer = info === null ? '' : String(context.getParameter(info.UNMASKED_RENDERER_WEBGL))
  return !/swiftshader|llvmpipe|software|microsoft basic/i.test(renderer)
}

/** Names MediaPipe asks for while loading, answered from the bytes Main read. */
const WASM_URL = 'ai-canvas-mediapipe/vision_wasm_internal.wasm'
const MODEL_URL = 'ai-canvas-mediapipe/magic_touch.tflite'

async function load(): Promise<InteractiveSegmenter> {
  const assets = await window.desktop.readMagicTouchAssets()
  const files: Readonly<Record<string, { readonly bytes: Uint8Array; readonly type: string }>> = {
    [WASM_URL]: { bytes: new Uint8Array(assets.wasm), type: 'application/wasm' },
    [MODEL_URL]: { bytes: new Uint8Array(assets.model), type: 'application/octet-stream' }
  }
  // MediaPipe fetches its WebAssembly and model by URL (its in-memory model option does not work for this
  // task); for as long as it loads, those two URLs are answered here and nothing reaches the network.
  const original = globalThis.fetch
  globalThis.fetch = (input, init) => {
    const file = typeof input === 'string' ? files[input] : undefined
    return file === undefined ? original(input, init) : Promise.resolve(new Response(new Blob([file.bytes as Uint8Array<ArrayBuffer>], { type: file.type })))
  }
  try {
    return await InteractiveSegmenter.createFromOptions(
      { wasmLoaderPath: loaderUrl, wasmBinaryPath: WASM_URL },
      { baseOptions: { modelAssetPath: MODEL_URL, delegate: hardwareGraphics() ? 'GPU' : 'CPU' }, outputCategoryMask: false, outputConfidenceMasks: true }
    )
  } finally {
    globalThis.fetch = original
  }
}

function ready(): Promise<InteractiveSegmenter> {
  segmenter ??= load().catch((error: unknown) => {
    segmenter = null
    throw error
  })
  return segmenter
}

/** Starts loading the model before the first click needs it. */
export function warmMagicTouch(): void {
  void ready().catch(() => undefined)
}

/**
 * The object under a point of a picture, as coverage at the picture's
 * size, or null when the model found nothing there.
 */
export async function magicTouchAt(picture: { readonly width: number; readonly height: number; readonly rgba: Uint8ClampedArray }, x: number, y: number): Promise<GrayMask | null> {
  const model = await ready()
  const scale = Math.min(1, MAX_SIDE / Math.max(picture.width, picture.height))
  const width = Math.max(1, Math.round(picture.width * scale))
  const height = Math.max(1, Math.round(picture.height * scale))
  const full = document.createElement('canvas')
  full.width = picture.width
  full.height = picture.height
  full.getContext('2d')?.putImageData(new ImageData(new Uint8ClampedArray(picture.rgba), picture.width, picture.height), 0, 0)
  const small = document.createElement('canvas')
  small.width = width
  small.height = height
  const context = small.getContext('2d', { willReadFrequently: true })
  if (context === null) return null
  context.drawImage(full, 0, 0, width, height)
  const result = model.segment(small, { keypoint: { x: x / picture.width, y: y / picture.height } })
  const confidence = result.confidenceMasks?.[0]
  if (confidence === undefined) { result.close(); return null }
  const values = confidence.getAsFloat32Array()
  const maskWidth = confidence.width
  const maskHeight = confidence.height
  // Faint guesses at the edges of the picture would only add noise to the selection.
  const coverage = new ImageData(maskWidth, maskHeight)
  let any = false
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]! < 0.1 ? 0 : Math.round(values[index]! * 255)
    if (value >= 128) any = true
    coverage.data[index * 4 + 3] = value
  }
  result.close()
  if (!any) return null
  // Back to the picture's size, smoothly.
  const maskCanvas = document.createElement('canvas')
  maskCanvas.width = maskWidth
  maskCanvas.height = maskHeight
  maskCanvas.getContext('2d')?.putImageData(coverage, 0, 0)
  context.canvas.width = picture.width
  context.canvas.height = picture.height
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.drawImage(maskCanvas, 0, 0, picture.width, picture.height)
  const scaled = context.getImageData(0, 0, picture.width, picture.height).data
  const data = new Uint8Array(picture.width * picture.height)
  for (let index = 0; index < data.length; index += 1) data[index] = scaled[index * 4 + 3]!
  return { width: picture.width, height: picture.height, data }
}
