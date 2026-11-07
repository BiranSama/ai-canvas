import type { BlendMode as PsdBlendMode } from 'ag-psd'
import type { BlendMode } from '../../domain'

/** Our blend modes by Photoshop's names, each way. */
export const PSD_BLEND_MODES: Readonly<Record<BlendMode, PsdBlendMode>> = {
  normal: 'normal',
  darken: 'darken',
  multiply: 'multiply',
  'color-burn': 'color burn',
  lighten: 'lighten',
  screen: 'screen',
  'color-dodge': 'color dodge',
  overlay: 'overlay',
  'soft-light': 'soft light',
  'hard-light': 'hard light',
  difference: 'difference',
  exclusion: 'exclusion',
  hue: 'hue',
  saturation: 'saturation',
  color: 'color',
  luminosity: 'luminosity'
}

const FROM_PSD = new Map<string, BlendMode>([
  ...Object.entries(PSD_BLEND_MODES).map(([ours, theirs]) => [theirs, ours as BlendMode] as const),
  ['pass through', 'normal']
])

/** Our blend mode for one of Photoshop's, or undefined when the canvas cannot draw it. */
export function fromPsdBlendMode(mode: string | undefined): BlendMode | undefined {
  return FROM_PSD.get(mode ?? 'normal')
}
