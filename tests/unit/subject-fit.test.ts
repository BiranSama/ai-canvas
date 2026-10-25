import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { fitSubject, SUBJECT_FEATHER } from '../../src/main/edit/subject-fit'

const picture = (alpha = 255) => sharp({ create: { width: 40, height: 20, channels: 4, background: { r: 200, g: 120, b: 40, alpha: alpha / 255 } } }).png().toBuffer()
/** A stand-in model that finds a block in the middle of the picture covering the given share. */
const block = (share: number) => async (_rgba: Uint8Array, width: number, height: number) =>
  Uint8Array.from({ length: width * height }, (_, index) => (index % width) < width * share ? 255 : 8)

describe('fitting a generated picture into a subject\'s place', () => {
  it('cuts out the subject the model finds, leaving out its faint guesses', async () => {
    const fit = await fitSubject(await picture(), block(0.5))
    expect(fit.kind).toBe('cut-out')
    if (fit.kind !== 'cut-out') return
    const { data, info } = await sharp(fit.mask).extractChannel(0).raw().toBuffer({ resolveWithObject: true })
    expect([info.width, info.height]).toEqual([40, 20])
    expect([data[5], data[35]]).toEqual([255, 0])
  })

  it('feathers the edges without the model, when it finds no single subject, or when it fails', async () => {
    expect(await fitSubject(await picture(), null)).toEqual({ kind: 'feather', feather: SUBJECT_FEATHER })
    expect(await fitSubject(await picture(), block(0.01))).toEqual({ kind: 'feather', feather: SUBJECT_FEATHER })
    expect(await fitSubject(await picture(), block(0.98))).toEqual({ kind: 'feather', feather: SUBJECT_FEATHER })
    expect(await fitSubject(await picture(), async () => { throw new Error('model gone') })).toEqual({ kind: 'feather', feather: SUBJECT_FEATHER })
  })

  it('leaves a picture with its own transparency as it came', async () => {
    let asked = false
    expect(await fitSubject(await picture(0), async (_rgba, width, height) => { asked = true; return new Uint8Array(width * height) })).toEqual({ kind: 'transparent' })
    expect(asked).toBe(false)
  })
})
