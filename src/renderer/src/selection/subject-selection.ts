import { combineMasks, createMask, type GrayMask, type MaskRect } from '../../../shared/mask-raster'
import { showAppNotice } from '../components/app-notice'
import { ensureSubjectModel } from '../components/subject-model-store'
import { setObjectSelector } from './selection-gestures'
import { samplePixels, sampledLayer, type SampledPixels } from './selection-sampling'
import { currentSelection, setSelectionMask, useSelectionStore } from './selection-store'
import { magicTouchAt } from './magic-touch'

/*
 * Photoshop's Select Subject and the object selection tool. Select Subject
 * and a box drawn with the object selection run ISNet in Main on the
 * pictured part; a click runs Magic Touch here. Each result is a selection
 * the size of the canvas.
 */

/** The longest side sent to Main; the model works at 1024 itself. */
const MAX_SIDE = 1024
/** Coverage below this (about 6%) counts as background. */
const FAINT = 16
/** Slower than this, the person hears that the image service may suit this computer better. */
const SLOW_MS = 5_000

/** The subject inside a rectangle of the sampled picture, as a canvas-size mask. */
async function subjectIn(pixels: SampledPixels, rect: MaskRect): Promise<GrayMask | null> {
  const x = Math.max(0, Math.floor(rect.x))
  const y = Math.max(0, Math.floor(rect.y))
  const width = Math.min(pixels.width - x, Math.ceil(rect.x + rect.width) - x)
  const height = Math.min(pixels.height - y, Math.ceil(rect.y + rect.height) - y)
  if (width < 4 || height < 4) return null
  const scale = Math.min(1, MAX_SIDE / Math.max(width, height))
  const sentWidth = Math.max(1, Math.round(width * scale))
  const sentHeight = Math.max(1, Math.round(height * scale))
  const full = document.createElement('canvas')
  full.width = pixels.width
  full.height = pixels.height
  full.getContext('2d')?.putImageData(new ImageData(new Uint8ClampedArray(pixels.rgba), pixels.width, pixels.height), 0, 0)
  const sent = document.createElement('canvas')
  sent.width = sentWidth
  sent.height = sentHeight
  const context = sent.getContext('2d', { willReadFrequently: true })
  if (context === null) return null
  context.imageSmoothingQuality = 'high'
  context.drawImage(full, x, y, width, height, 0, 0, sentWidth, sentHeight)
  const rgba = new Uint8Array(context.getImageData(0, 0, sentWidth, sentHeight).data.buffer)
  const result = await window.desktop.segmentSubject({ width: sentWidth, height: sentHeight, rgba })
  if (result.milliseconds > SLOW_MS) showAppNotice(`选择主体在这台电脑上用了 ${Math.round(result.milliseconds / 1000)} 秒。经常这样的话，抠图也可以交给图像服务。`)
  // Back to the rectangle's size, then into a canvas-size mask.
  const maskImage = new ImageData(sentWidth, sentHeight)
  for (let index = 0; index < result.mask.length; index += 1) maskImage.data[index * 4 + 3] = result.mask[index]!
  const small = document.createElement('canvas')
  small.width = sentWidth
  small.height = sentHeight
  small.getContext('2d')?.putImageData(maskImage, 0, 0)
  const placed = document.createElement('canvas')
  placed.width = pixels.width
  placed.height = pixels.height
  const placedContext = placed.getContext('2d', { willReadFrequently: true })
  if (placedContext === null) return null
  placedContext.imageSmoothingQuality = 'high'
  placedContext.drawImage(small, 0, 0, sentWidth, sentHeight, x, y, width, height)
  const alpha = placedContext.getImageData(0, 0, pixels.width, pixels.height).data
  const mask = createMask(pixels.width, pixels.height)
  // The model is never quite sure the background is not the subject; faint values would only widen the selection.
  for (let index = 0; index < mask.data.length; index += 1) mask.data[index] = alpha[index * 4 + 3]! < FAINT ? 0 : alpha[index * 4 + 3]!
  return mask
}

/** Where a layer's pixels are on the canvas: what is not fully transparent. */
function opaqueRect(pixels: SampledPixels): MaskRect | null {
  let left = pixels.width
  let right = -1
  let top = pixels.height
  let bottom = -1
  for (let y = 0; y < pixels.height; y += 1) {
    for (let x = 0; x < pixels.width; x += 1) {
      if (pixels.rgba[(y * pixels.width + x) * 4 + 3] === 0) continue
      if (x < left) left = x
      if (x > right) right = x
      if (y < top) top = y
      bottom = y
    }
  }
  return right < 0 ? null : { x: left, y: top, width: right - left + 1, height: bottom - top + 1 }
}

let running = false

/**
 * Photoshop's Select Subject: with one picture layer selected, the subject
 * of that layer; otherwise of the whole picture. The options bar's mode
 * decides how it meets the current selection.
 */
export async function selectSubject(): Promise<boolean> {
  if (running) return false
  if (!await ensureSubjectModel()) return false
  running = true
  try {
    const layer = sampledLayer()
    const pixels = await samplePixels(layer === null)
    if (pixels === null) {
      showAppNotice('画面还没画好，稍后再试。')
      return false
    }
    const area = layer === null ? { x: 0, y: 0, width: pixels.width, height: pixels.height } : opaqueRect(pixels)
    if (area === null) {
      showAppNotice(`「${layer?.name ?? ''}」上没有像素。`)
      return false
    }
    const found = await subjectIn(pixels, area)
    if (found === null) {
      showAppNotice('没有找到主体。')
      return false
    }
    // On a layer, only what the layer covers can be its subject.
    if (layer !== null) for (let index = 0; index < found.data.length; index += 1) found.data[index] = Math.round(found.data[index]! * pixels.rgba[index * 4 + 3]! / 255)
    setSelectionMask(combineMasks(currentSelection(), found, useSelectionStore.getState().settings.mode))
    return true
  } catch (error) {
    showAppNotice(`选择主体没有完成：${error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : String(error)}`, 'problem')
    return false
  } finally {
    running = false
  }
}

setObjectSelector({
  atPoint: async (point) => {
    const pixels = await samplePixels(useSelectionStore.getState().settings.sampleAllLayers)
    if (pixels === null) return null
    try {
      const found = await magicTouchAt(pixels, point.x, point.y)
      if (found === null) showAppNotice('这里没有找到物体，换个位置点一下，或框住它。')
      return found
    } catch (error) {
      showAppNotice(`对象选择没有完成：${error instanceof Error ? error.message : String(error)}`, 'problem')
      return null
    }
  },
  inBox: async (rect) => {
    if (!await ensureSubjectModel()) return null
    const pixels = await samplePixels(useSelectionStore.getState().settings.sampleAllLayers)
    if (pixels === null) return null
    try {
      return await subjectIn(pixels, rect)
    } catch (error) {
      showAppNotice(`对象选择没有完成：${error instanceof Error ? error.message : String(error)}`, 'problem')
      return null
    }
  }
})
