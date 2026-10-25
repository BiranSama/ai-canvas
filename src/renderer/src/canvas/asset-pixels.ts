import type { GrayMask } from '../../../shared/mask-raster'
import { getRuntimeAssetUrl, subscribeRuntimeAssets } from '../assets/runtime-assets'

/*
 * Grayscale assets as pixels: the clips painting operations record and
 * layer masks. Each is read once per size (or at its own size) from its
 * runtime asset, the red channel, and kept; whatever draws from them
 * subscribes and redraws once they arrive.
 */

interface Size {
  readonly width: number
  readonly height: number
}

const cache = new Map<string, GrayMask>()
const loading = new Set<string>()
/** Assets asked for before their bytes arrived, with the size asked for. */
const pending = new Map<string, { readonly assetId: string; readonly size: Size | null }>()
const listeners = new Set<() => void>()
let version = 0

function notify(): void {
  version += 1
  for (const listener of listeners) listener()
}

export function subscribeAssetPixels(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function assetPixelsVersion(): number {
  return version
}

function key(assetId: string, size: Size | null): string {
  return size === null ? `${assetId}:own` : `${assetId}:${size.width}x${size.height}`
}

function load(assetId: string, size: Size | null): void {
  const id = key(assetId, size)
  const url = getRuntimeAssetUrl(assetId)
  if (url === null || loading.has(id)) return
  loading.add(id)
  const image = new window.Image()
  image.onload = () => {
    loading.delete(id)
    const width = size?.width ?? Math.max(1, image.naturalWidth)
    const height = size?.height ?? Math.max(1, image.naturalHeight)
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (context === null) return
    context.imageSmoothingEnabled = false
    context.drawImage(image, 0, 0, width, height)
    const rgba = context.getImageData(0, 0, width, height).data
    const data = new Uint8Array(width * height)
    for (let index = 0; index < data.length; index += 1) data[index] = rgba[index * 4]!
    cache.set(id, { width, height, data })
    notify()
  }
  image.onerror = () => { loading.delete(id) }
  image.src = url
}

// An asset whose bytes arrive later is read then.
subscribeRuntimeAssets(() => {
  for (const [id, request] of [...pending]) {
    if (cache.has(id)) { pending.delete(id); continue }
    if (getRuntimeAssetUrl(request.assetId) !== null) {
      pending.delete(id)
      load(request.assetId, request.size)
    }
  }
})

/** The asset's coverage at this size, or at its own without one; null until it has been read (it is read now if it can be). */
export function grayAssetPixels(assetId: string, size: Size | null = null): GrayMask | null {
  const id = key(assetId, size)
  const found = cache.get(id)
  if (found !== undefined) return found
  if (getRuntimeAssetUrl(assetId) === null) pending.set(id, { assetId, size })
  else load(assetId, size)
  return null
}

/** Pixels made here and imported as an asset are known at once, without reading them back. */
export function rememberGrayAsset(assetId: string, mask: GrayMask): void {
  cache.set(key(assetId, mask), mask)
  cache.set(key(assetId, null), mask)
  notify()
}

/** The clips these operations need at this size, or null while any is still being read. */
export function clipLookup(clipIds: readonly string[], size: Size): Map<string, Uint8Array> | null {
  const clips = new Map<string, Uint8Array>()
  let ready = true
  for (const id of clipIds) {
    const pixels = grayAssetPixels(id, size)
    if (pixels === null) ready = false
    else clips.set(id, pixels.data)
  }
  return ready ? clips : null
}
