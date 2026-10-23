import type { ImageEffects } from '../domain'

/*
 * The pixel math of image layer effects, shared by the canvas (Konva filters
 * on the drawn image) and Main's composite renderer (sharp), so the picture
 * people see and the reference a model receives match.
 */

type Pixels = Uint8Array | Uint8ClampedArray

function clampByte(value: number): number {
  return value < 0 ? 0 : value > 255 ? 255 : Math.round(value)
}

function smoothstep(value: number): number {
  const t = value < 0 ? 0 : value > 1 ? 1 : value
  return t * t * (3 - 2 * t)
}

export function hasVisibleEffects(effects: ImageEffects | undefined): effects is ImageEffects {
  return effects !== undefined && (effects.colorMatch !== null || effects.feather > 0 || (effects.shadow !== null && effects.shadow.opacity > 0))
}

/** Colour match and edge feather, in place, on the RGBA pixels of the image as drawn. */
export function applyImageEffects(data: Pixels, width: number, height: number, effects: ImageEffects): void {
  const match = effects.colorMatch
  const ramp = effects.feather * Math.min(width, height)
  if (match === null && ramp <= 0) return
  for (let y = 0; y < height; y += 1) {
    const fromTop = ramp > 0 ? Math.min(y + 0.5, height - y - 0.5) / ramp : 1
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4
      if (match !== null) {
        data[index] = clampByte(data[index]! * match.gain[0] + match.offset[0])
        data[index + 1] = clampByte(data[index + 1]! * match.gain[1] + match.offset[1])
        data[index + 2] = clampByte(data[index + 2]! * match.gain[2] + match.offset[2])
      }
      if (ramp > 0) {
        const edge = Math.min(fromTop, Math.min(x + 0.5, width - x - 0.5) / ramp)
        if (edge < 1) data[index + 3] = clampByte(data[index + 3]! * smoothstep(edge))
      }
    }
  }
}

function hexColor(color: string): readonly [number, number, number] {
  const value = color.replace(/^#/, '')
  const full = value.length === 3 || value.length === 4 ? [...value.slice(0, 3)].map((digit) => digit + digit).join('') : value.slice(0, 6)
  return /^[\da-f]{6}$/i.test(full)
    ? [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)]
    : [0, 0, 0]
}

/** The shadow before blurring: the image's alpha (after its effects) filled with the shadow colour. */
export function shadowSilhouette(data: Pixels, width: number, height: number, shadow: NonNullable<ImageEffects['shadow']>): Uint8ClampedArray<ArrayBuffer> {
  const [r, g, b] = hexColor(shadow.color)
  const output = new Uint8ClampedArray(width * height * 4)
  for (let index = 0; index < width * height * 4; index += 4) {
    output[index] = r
    output[index + 1] = g
    output[index + 2] = b
    output[index + 3] = clampByte(data[index + 3]! * shadow.opacity)
  }
  return output
}

/**
 * Shadow blur (a Gaussian standard deviation) and offset in pixels for an
 * image drawn at this size, and the room the blur needs around it.
 */
export function shadowGeometry(shadow: NonNullable<ImageEffects['shadow']>, width: number, height: number): {
  readonly sigma: number
  readonly offsetX: number
  readonly offsetY: number
  readonly padding: number
} {
  const side = Math.min(width, height)
  const sigma = shadow.blur * side
  return { sigma, offsetX: shadow.offsetX * side, offsetY: shadow.offsetY * side, padding: Math.ceil(sigma * 3) }
}

const SOFT_SHADOW_OPACITY = 0.55

/** The soft shadow under a subject that the blend controls offer, at a strength of 0–1. */
export function softShadow(strength: number): NonNullable<ImageEffects['shadow']> {
  return { color: '#000000', opacity: Math.round(SOFT_SHADOW_OPACITY * strength * 1000) / 1000, blur: 0.04, offsetX: 0, offsetY: 0.025 }
}

/** The strength softShadow was given, read back from a shadow's opacity. */
export function softShadowStrength(shadow: ImageEffects['shadow']): number {
  return shadow === null ? 0 : Math.min(1, shadow.opacity / SOFT_SHADOW_OPACITY)
}
