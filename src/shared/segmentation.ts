import { z } from 'zod'

/*
 * The local model Select Subject runs: ISNet (Apache 2.0), downloaded once
 * on first use and checked against its SHA-256 before it is trusted. The
 * click-to-select model, MediaPipe's Magic Touch, ships with the app.
 */

export interface DownloadableModel {
  readonly id: string
  /** The file name it is kept under in the app's model folder. */
  readonly file: string
  readonly bytes: number
  readonly sha256: string
  readonly url: string
}

export const SUBJECT_MODEL: DownloadableModel = {
  id: 'isnet-general-use',
  file: 'isnet-general-use.onnx',
  bytes: 178_648_008,
  sha256: '60920e99c45464f2ba57bee2ad08c919a52bbf852739e96947fbb4358c0d964a',
  url: 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/isnet-general-use.onnx'
}

export type SubjectModelState = 'missing' | 'downloading' | 'verifying' | 'ready' | 'failed'

export interface SubjectModelStatus {
  readonly state: SubjectModelState
  readonly receivedBytes: number
  readonly totalBytes: number
  /** Why the last download stopped, in words for the person. */
  readonly error: string | null
}

export const subjectModelDownloadSchema = z.object({
  /** Where to download from instead of GitHub, for a mirror; the checksum is checked all the same. */
  mirrorUrl: z.string().trim().url().max(2_000).refine((url) => /^https?:\/\//i.test(url), '下载地址必须以 http:// 或 https:// 开头。').nullable().default(null)
})

export type SubjectModelDownloadInput = z.input<typeof subjectModelDownloadSchema>

/** The side the model works at; a picture is scaled to this square and the mask back. */
export const SUBJECT_MODEL_SIZE = 1024

export const subjectSegmentInputSchema = z.object({
  width: z.number().int().min(1).max(4_096),
  height: z.number().int().min(1).max(4_096),
  rgba: z.instanceof(Uint8Array)
}).refine((input) => input.rgba.byteLength === input.width * input.height * 4, 'Pixels must be width × height × 4 bytes.')

export type SubjectSegmentInput = z.infer<typeof subjectSegmentInputSchema>

export interface SubjectSegmentResult {
  readonly width: number
  readonly height: number
  /** How surely each pixel belongs to the subject, 0–255. */
  readonly mask: Uint8Array<ArrayBuffer>
  /** How long the model took, for telling the person when it is slow here. */
  readonly milliseconds: number
}
