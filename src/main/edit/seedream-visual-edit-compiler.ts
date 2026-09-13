import sharp from 'sharp'

export interface SeedreamVisualEditReference {
  readonly bytes: Buffer
  readonly width: number
  readonly height: number
  readonly mimeType: 'image/png'
  readonly mode: 'visual-guided'
}

/**
 * Converts AI Canvas' grayscale edit mask into the visual signal understood by
 * Seedream: the original image with a translucent red edit-region overlay.
 * The untouched source is sent separately as image one.
 */
export async function compileSeedreamVisualEditReference(
  source: Buffer,
  mask: Buffer
): Promise<SeedreamVisualEditReference> {
  const sourceMetadata = await sharp(source).metadata()
  const maskMetadata = await sharp(mask).metadata()
  const width = sourceMetadata.width
  const height = sourceMetadata.height
  if (width === undefined || height === undefined) throw new Error('Seedream edit source has no readable dimensions.')
  if (maskMetadata.width !== width || maskMetadata.height !== height) {
    throw new Error('Seedream visual edit mask must exactly match the source dimensions.')
  }

  const maskAlpha = await sharp(mask)
    .greyscale()
    .removeAlpha()
    .linear(0.48)
    .raw()
    .toBuffer()
  const redOverlay = await sharp({
    create: { width, height, channels: 3, background: { r: 255, g: 42, b: 74 } }
  })
    .joinChannel(maskAlpha, { raw: { width, height, channels: 1 } })
    .png()
    .toBuffer()
  const bytes = await sharp(source)
    .rotate()
    .resize(width, height, { fit: 'fill' })
    .composite([{ input: redOverlay, blend: 'over' }])
    .png()
    .toBuffer()
  return { bytes, width, height, mimeType: 'image/png', mode: 'visual-guided' }
}
