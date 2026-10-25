import sharp from 'sharp'
import type { LayerMask, PaintOp } from '../../domain'
import { applyMaskAlpha, applyPaintOps, maskCoverage, paintClipIds } from '../../shared/paint-ops'
import { imageBytes } from '../storage/image-file'

/** Where an asset's file or bytes are, or null when it is missing. */
export type PaintAssetResolver = (assetId: string) => Promise<string | Buffer | null>

const NO_ASSETS: PaintAssetResolver = async () => null

/** An asset's first channel at this size: a clip's or a mask's coverage. */
export async function grayPixels(source: string | Buffer, width: number, height: number): Promise<Uint8Array> {
  const { data, info } = await sharp(await imageBytes(source)).resize(width, height, { fit: 'fill', kernel: 'nearest' }).extractChannel(0).raw().toBuffer({ resolveWithObject: true })
  return info.width === width && info.height === height ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(width * height)
}

/** The clip images the operations refer to, at the pixel size they paint at; missing ones are left out. */
export async function loadClips(ops: readonly PaintOp[] | undefined, width: number, height: number, resolveAsset: PaintAssetResolver): Promise<Map<string, Uint8Array>> {
  const clips = new Map<string, Uint8Array>()
  for (const id of paintClipIds(ops)) {
    const source = await resolveAsset(id)
    if (source !== null) clips.set(id, await grayPixels(source, width, height))
  }
  return clips
}

/** A layer mask's coverage with its paint replayed, at this size (an image layer's) or its own. */
export async function layerMaskCoverage(mask: LayerMask, resolveAsset: PaintAssetResolver, size?: { readonly width: number; readonly height: number }): Promise<{ readonly width: number; readonly height: number; readonly coverage: Uint8Array } | null> {
  const found = await resolveAsset(mask.assetId)
  if (found === null) return null
  const source = await imageBytes(found)
  const own = await sharp(source).metadata()
  const width = size?.width ?? own.width ?? 1
  const height = size?.height ?? own.height ?? 1
  const gray = await grayPixels(source, width, height)
  const clips = await loadClips(mask.paint, width, height, resolveAsset)
  return { width, height, coverage: maskCoverage(gray, width, height, mask.paint, clips) }
}

/**
 * The image with the paint recorded on its layer replayed over it and, when
 * one is on, its layer mask applied, as PNG bytes at its own size.
 */
export async function paintedImageBytes(source: string | Buffer, ops: readonly PaintOp[] | undefined, resolveAsset: PaintAssetResolver = NO_ASSETS, mask: LayerMask | null = null): Promise<Buffer> {
  const { data, info } = await sharp(await imageBytes(source)).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const pixels = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  applyPaintOps(pixels, info.width, info.height, ops ?? [], await loadClips(ops, info.width, info.height, resolveAsset))
  if (mask !== null && mask.enabled) {
    const coverage = await layerMaskCoverage(mask, resolveAsset, { width: info.width, height: info.height })
    if (coverage !== null) applyMaskAlpha(pixels, pixels, coverage.coverage, info.width)
  }
  return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer()
}
