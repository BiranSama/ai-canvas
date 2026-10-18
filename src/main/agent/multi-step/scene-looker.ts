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
    const buffer = await image
      .resize({ width: LONG_EDGE, height: LONG_EDGE, fit: 'inside', withoutEnlargement: request.region === null })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 85 })
      .toBuffer()
    return { mimeType: 'image/jpeg', base64: buffer.toString('base64') }
  }
}
