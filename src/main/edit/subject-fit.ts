import sharp from 'sharp'

/*
 * A generated picture put in a subject's place is a rectangle with its own
 * background, and on the canvas it looks pasted on. Its subject is cut out
 * with the local model, as a layer mask the person can paint on or turn off;
 * without the model, or when the picture holds no single subject, its edges
 * are feathered instead.
 */

/** Below this (about 6%) the model is guessing; such pixels are left out of the cut-out. */
const FAINT = 16
/** A subject covers between these shares of its picture; outside them the picture is a scene, or the model found nothing. */
const MIN_SUBJECT = 0.03
const MAX_SUBJECT = 0.9
/** A picture this share of whose pixels are see-through already has its own cut-out. */
const OWN_TRANSPARENCY = 0.01
/** The fade at a feathered picture's edges, as a share of its shorter side. */
export const SUBJECT_FEATHER = 0.06

/** Coverage of the subject, 0–255 per pixel, for RGBA pixels. */
export type SubjectFinder = (rgba: Uint8Array<ArrayBuffer>, width: number, height: number) => Promise<Uint8Array>

export type SubjectFit =
  /** A gray PNG at the picture's size: white over the subject. */
  | { readonly kind: 'cut-out'; readonly mask: Buffer }
  | { readonly kind: 'feather'; readonly feather: number }
  /** The picture came with transparency of its own and needs nothing. */
  | { readonly kind: 'transparent' }

/** How a generated picture sits in a subject's place: cut out, feathered, or as it came. */
export async function fitSubject(bytes: Buffer, findSubject: SubjectFinder | null): Promise<SubjectFit> {
  const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const total = info.width * info.height
  let seeThrough = 0
  for (let index = 3; index < data.length; index += 4) if (data[index]! < 250) seeThrough += 1
  if (seeThrough / total > OWN_TRANSPARENCY) return { kind: 'transparent' }
  if (findSubject === null) return { kind: 'feather', feather: SUBJECT_FEATHER }
  let coverage: Uint8Array
  try {
    coverage = await findSubject(new Uint8Array(data), info.width, info.height)
  } catch {
    return { kind: 'feather', feather: SUBJECT_FEATHER }
  }
  if (coverage.length !== total) return { kind: 'feather', feather: SUBJECT_FEATHER }
  const mask = Buffer.alloc(total)
  let covered = 0
  for (let index = 0; index < total; index += 1) {
    const value = coverage[index]!
    mask[index] = value < FAINT ? 0 : value
    if (value >= 128) covered += 1
  }
  const share = covered / total
  if (share < MIN_SUBJECT || share > MAX_SUBJECT) return { kind: 'feather', feather: SUBJECT_FEATHER }
  return { kind: 'cut-out', mask: await sharp(mask, { raw: { width: info.width, height: info.height, channels: 1 } }).png().toBuffer() }
}
