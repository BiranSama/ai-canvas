import sharp from 'sharp'
import { SUBJECT_MODEL_SIZE, type SubjectModelStatus, type SubjectSegmentInput, type SubjectSegmentResult } from '../../shared/segmentation'
import type { ModelDownloader } from './model-download'

/*
 * Select Subject in Main: the model is downloaded on first use; a picture
 * from the canvas is scaled to the model's square, run in the background
 * process, and the subject's coverage scaled back to the picture's size.
 */

/** Runs the model somewhere: in a background process in the app, in this process in tests. */
export interface SubjectRunner {
  segment(modelPath: string, rgb: Uint8Array): Promise<Uint8Array>
  dispose(): void
}

export class SubjectSegmentation {
  readonly #downloader: ModelDownloader
  readonly #runner: SubjectRunner

  constructor(input: { readonly downloader: ModelDownloader; readonly runner: SubjectRunner }) {
    this.#downloader = input.downloader
    this.#runner = input.runner
  }

  status(): Promise<SubjectModelStatus> {
    return this.#downloader.status()
  }

  download(mirrorUrl: string | null): Promise<SubjectModelStatus> {
    return this.#downloader.download(mirrorUrl)
  }

  cancel(): void {
    this.#downloader.cancel()
  }

  async segment(input: SubjectSegmentInput): Promise<SubjectSegmentResult> {
    if ((await this.#downloader.status()).state !== 'ready') throw new Error('选择主体用的模型还没有下载。')
    const size = SUBJECT_MODEL_SIZE
    // Transparent pixels count by their colour, as rembg reads a picture.
    const rgb = await sharp(Buffer.from(input.rgba.buffer, input.rgba.byteOffset, input.rgba.byteLength), { raw: { width: input.width, height: input.height, channels: 4 } })
      .removeAlpha()
      .resize(size, size, { fit: 'fill', kernel: 'lanczos3' })
      .raw()
      .toBuffer()
    const started = performance.now()
    const square = await this.#runner.segment(this.#downloader.path, new Uint8Array(rgb.buffer, rgb.byteOffset, rgb.byteLength))
    const milliseconds = Math.round(performance.now() - started)
    const mask = await sharp(Buffer.from(square.buffer, square.byteOffset, square.byteLength), { raw: { width: size, height: size, channels: 1 } })
      .resize(input.width, input.height, { fit: 'fill', kernel: 'lanczos3' })
      .extractChannel(0)
      .raw()
      .toBuffer()
    return { width: input.width, height: input.height, mask: new Uint8Array(mask), milliseconds }
  }

  dispose(): void {
    this.#runner.dispose()
  }
}
