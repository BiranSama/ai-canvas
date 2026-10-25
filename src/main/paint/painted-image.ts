import sharp from 'sharp'
import type { PaintOp } from '../../domain'
import { applyPaintOps } from '../../shared/paint-ops'
import { imageBytes } from '../storage/image-file'

/** The image with the paint recorded on its layer replayed over it, as PNG bytes at its own size. */
export async function paintedImageBytes(source: string | Buffer, ops: readonly PaintOp[]): Promise<Buffer> {
  const { data, info } = await sharp(await imageBytes(source)).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  applyPaintOps(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), info.width, info.height, ops)
  return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer()
}
