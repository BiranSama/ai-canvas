import sharp from 'sharp'
import type { Scene } from '../../../domain'
import { CompositeReferenceRenderer, type ReferenceAssetResolver } from '../../reference/composite-reference-renderer'
import type { LlmImage } from '../llm/transcript'
import type { CanvasLooker, LookRequest } from '../tools/types'

const LONG_EDGE = 1_024

/**
 * What `look` shows the model: the main-process composite render, the same on
 * every call and independent of the window. "canvas" draws real text and
 * marks placeholders, lights and masks; "reference" is the image generation
 * would receive.
 */
export class SceneLooker implements CanvasLooker {
  readonly #renderer: CompositeReferenceRenderer

  constructor(resolveAsset: ReferenceAssetResolver) {
    this.#renderer = new CompositeReferenceRenderer(resolveAsset)
  }

  async look(scene: Scene, request: LookRequest): Promise<LlmImage> {
    const rendered = await this.#renderer.render(scene, request.mode === 'reference' ? 'reference' : 'editing')
    const { outputWidth: width, outputHeight: height } = scene.canvas
    let image = sharp(rendered.buffer)
    if (request.region !== null) {
      const [x, y, w, h] = request.region
      const left = Math.max(0, Math.min(width - 1, Math.round(x / 100 * width)))
      const top = Math.max(0, Math.min(height - 1, Math.round(y / 100 * height)))
      image = sharp(await image.extract({
        left,
        top,
        width: Math.max(1, Math.min(width - left, Math.round(w / 100 * width))),
        height: Math.max(1, Math.min(height - top, Math.round(h / 100 * height)))
      }).toBuffer())
    }
    // A region is enlarged to the same long edge so small text stays legible.
    const resized = image.resize({ width: LONG_EDGE, height: LONG_EDGE, fit: 'inside', withoutEnlargement: request.region === null })
    const buffer = request.background === 'checker'
      ? await sharp(await onChecker(await resized.png().toBuffer())).jpeg({ quality: 85 }).toBuffer()
      : await resized.flatten({ background: '#ffffff' }).jpeg({ quality: 85 }).toBuffer()
    return { mimeType: 'image/jpeg', base64: buffer.toString('base64') }
  }
}

/** The grey and white squares editors use for transparency. */
async function onChecker(image: Buffer): Promise<Buffer> {
  const { width = 1, height = 1 } = await sharp(image).metadata()
  const cell = 12
  const checker = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs><pattern id="c" width="${cell * 2}" height="${cell * 2}" patternUnits="userSpaceOnUse"><rect width="${cell * 2}" height="${cell * 2}" fill="#ffffff"/><rect width="${cell}" height="${cell}" fill="#d6d6d6"/><rect x="${cell}" y="${cell}" width="${cell}" height="${cell}" fill="#d6d6d6"/></pattern></defs><rect width="100%" height="100%" fill="url(#c)"/></svg>`
  return sharp(Buffer.from(checker)).composite([{ input: image }]).png().toBuffer()
}
