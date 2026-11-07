import type { BlendMode as PsdBlendMode, Color, LayerEffectShadow, LayerEffectsInfo, LayerEffectsOuterGlow, LayerEffectStroke, UnitsValue } from 'ag-psd'
import type { BlendMode, LayerStyle } from '../../domain'
import { LAYER_STYLE_LABELS } from '../../shared/layer-styles'
import { fromPsdBlendMode, PSD_BLEND_MODES } from './psd-blend'

/*
 * Layer styles as Photoshop's layer effects, each way. Angles are the same
 * (degrees counter-clockwise from the right, the light's direction), sizes
 * and distances are pixels at the document's size, spread and choke are
 * percent (kept in pixel units, as Photoshop writes them), and the shadow is knocked out under the layer, as Photoshop does
 * by default.
 */

function color(hex: string): Color {
  return { r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16) }
}

function hex(value: Color | undefined): string {
  if (value === undefined || !('r' in value)) return '#000000'
  const channel = (part: number): string => Math.round(Math.max(0, Math.min(255, part))).toString(16).padStart(2, '0')
  return `#${channel(value.r)}${channel(value.g)}${channel(value.b)}`.toUpperCase()
}

const pixels = (value: number): UnitsValue => ({ units: 'Pixels', value })
/** Spread and choke: Photoshop shows them as percent but stores the number in pixel units. */
const percent = (value: number): UnitsValue => ({ units: 'Pixels', value })
const shown = { present: true, showInDialog: true }

/** Photoshop's layer effects for a layer's styles; undefined when it has none. */
export function toPsdEffects(style: LayerStyle | undefined): LayerEffectsInfo | undefined {
  if (style === undefined) return undefined
  const effects: LayerEffectsInfo = {}
  const blend = (mode: BlendMode): PsdBlendMode => PSD_BLEND_MODES[mode]
  if (style.dropShadow !== undefined) {
    const { enabled, blendMode, opacity, angle, distance, spread, size } = style.dropShadow
    effects.dropShadow = [{ ...shown, enabled, blendMode: blend(blendMode), color: color(style.dropShadow.color), opacity, angle, distance: pixels(distance), choke: percent(spread), size: pixels(size), useGlobalLight: false, layerConceals: true, antialiased: false }]
  }
  if (style.innerShadow !== undefined) {
    const { enabled, blendMode, opacity, angle, distance, choke, size } = style.innerShadow
    effects.innerShadow = [{ ...shown, enabled, blendMode: blend(blendMode), color: color(style.innerShadow.color), opacity, angle, distance: pixels(distance), choke: percent(choke), size: pixels(size), useGlobalLight: false, antialiased: false }]
  }
  if (style.outerGlow !== undefined) {
    const { enabled, blendMode, opacity, spread, size } = style.outerGlow
    effects.outerGlow = { ...shown, enabled, blendMode: blend(blendMode), color: color(style.outerGlow.color), opacity, choke: percent(spread), size: pixels(size), source: 'edge', range: 0.5, noise: 0, jitter: 0, antialiased: false }
  }
  if (style.stroke !== undefined) {
    const { enabled, size, position, opacity } = style.stroke
    effects.stroke = [{ ...shown, enabled, size: pixels(size), position, fillType: 'color', blendMode: 'normal', opacity, color: color(style.stroke.color) }]
  }
  if (style.colorOverlay !== undefined) {
    const { enabled, blendMode, opacity } = style.colorOverlay
    effects.solidFill = [{ ...shown, enabled, blendMode: blend(blendMode), color: color(style.colorOverlay.color), opacity }]
  }
  if (style.gradientOverlay !== undefined) {
    const gradient = style.gradientOverlay
    const stops = [...gradient.stops].sort((left, right) => left.offset - right.offset)
    effects.gradientOverlay = [{
      ...shown, enabled: gradient.enabled, blendMode: blend(gradient.blendMode), opacity: gradient.opacity, align: true, scale: gradient.scale, reverse: gradient.reverse,
      type: gradient.style, angle: gradient.angle, dither: false, offset: { x: 0, y: 0 }, interpolationMethod: 'classic',
      gradient: {
        name: '自定', type: 'solid', smoothness: 1,
        colorStops: stops.map((stop) => ({ color: color(stop.color), location: stop.offset, midpoint: 0.5 })),
        opacityStops: [{ opacity: 1, location: 0, midpoint: 0.5 }, { opacity: 1, location: 1, midpoint: 0.5 }]
      }
    }]
  }
  return Object.keys(effects).length === 0 ? undefined : effects
}

/** Two effects lists in one, the first's of each kind first: a text layer's own stroke and shadow with its styles. */
export function mergePsdEffects(first: LayerEffectsInfo | undefined, second: LayerEffectsInfo | undefined): LayerEffectsInfo | undefined {
  if (first === undefined) return second
  if (second === undefined) return first
  return {
    ...first,
    ...second,
    dropShadow: [...first.dropShadow ?? [], ...second.dropShadow ?? []],
    innerShadow: [...first.innerShadow ?? [], ...second.innerShadow ?? []],
    stroke: [...first.stroke ?? [], ...second.stroke ?? []],
    solidFill: [...first.solidFill ?? [], ...second.solidFill ?? []],
    gradientOverlay: [...first.gradientOverlay ?? [], ...second.gradientOverlay ?? []]
  }
}

const clamp = (value: number | undefined, low: number, high: number, fallback: number): number => value === undefined || !Number.isFinite(value) ? fallback : Math.max(low, Math.min(high, value))
/** An angle in -180…180. */
const angleOf = (value: number | undefined): number => { const angle = ((value ?? 120) % 360 + 540) % 360 - 180; return Math.round(angle * 100) / 100 }

export interface ImportedStyle {
  readonly style: LayerStyle | undefined
  /** The effects that did not come over, by name, for the import notes. */
  readonly dropped: readonly string[]
  /** Kinds that came over with something changed. */
  readonly approximated: readonly string[]
}

/** Our layer styles from a layer's Photoshop effects, with what could not come over. */
export function fromPsdEffects(effects: LayerEffectsInfo | undefined): ImportedStyle {
  if (effects === undefined) return { style: undefined, dropped: [], approximated: [] }
  const dropped: string[] = []
  const approximated = new Set<string>()
  // Photoshop's 缩放效果 scales every size; a layer with every effect off keeps them, switched off.
  const scale = clamp(effects.scale, 0.01, 10, 1)
  const on = (enabled: boolean | undefined): boolean => effects.disabled !== true && enabled !== false
  const size = (value: UnitsValue | undefined, high: number, fallback: number): number => clamp(value === undefined ? undefined : value.value * scale, 0, high, fallback)
  const share = (value: UnitsValue | undefined): number => clamp(value?.value, 0, 100, 0)
  const opacity = (value: number | undefined): number => clamp(value, 0, 1, 0.75)
  const blendOf = (mode: string | undefined, kind: string): BlendMode => {
    const ours = fromPsdBlendMode(mode)
    if (ours === undefined) approximated.add(kind)
    return ours ?? 'normal'
  }
  const first = <T>(list: readonly T[] | T | undefined, kind: string): T | undefined => {
    const all = list === undefined ? [] : Array.isArray(list) ? list as readonly T[] : [list as T]
    if (all.length > 1) dropped.push(`第二个起的${kind}`)
    return all[0]
  }
  const style: { -readonly [K in keyof LayerStyle]: LayerStyle[K] } = {}
  const shadow = (effect: LayerEffectShadow | undefined, kind: string): { enabled: boolean; blendMode: BlendMode; color: string; opacity: number; angle: number; distance: number; size: number; amount: number } | undefined => effect === undefined ? undefined : {
    enabled: on(effect.enabled), blendMode: blendOf(effect.blendMode, kind), color: hex(effect.color), opacity: opacity(effect.opacity),
    angle: angleOf(effect.angle), distance: size(effect.distance, 3000, 5), size: size(effect.size, 250, 5), amount: share(effect.choke)
  }
  const drop = shadow(first(effects.dropShadow, LAYER_STYLE_LABELS.dropShadow), LAYER_STYLE_LABELS.dropShadow)
  if (drop !== undefined) { const { amount, ...rest } = drop; style.dropShadow = { ...rest, spread: amount } }
  const inner = shadow(first(effects.innerShadow, LAYER_STYLE_LABELS.innerShadow), LAYER_STYLE_LABELS.innerShadow)
  if (inner !== undefined) { const { amount, ...rest } = inner; style.innerShadow = { ...rest, choke: amount } }
  const glow: LayerEffectsOuterGlow | undefined = effects.outerGlow
  if (glow !== undefined) {
    // A gradient glow, or one with noise, comes over as its plain colour.
    if (glow.color === undefined || (glow.noise ?? 0) > 0) approximated.add(LAYER_STYLE_LABELS.outerGlow)
    style.outerGlow = { enabled: on(glow.enabled), blendMode: blendOf(glow.blendMode, LAYER_STYLE_LABELS.outerGlow), color: hex(glow.color ?? { r: 255, g: 255, b: 190 }), opacity: opacity(glow.opacity), spread: share(glow.choke), size: size(glow.size, 250, 5) }
  }
  const stroke: LayerEffectStroke | undefined = first(effects.stroke, LAYER_STYLE_LABELS.stroke)
  if (stroke !== undefined) {
    if (stroke.fillType !== undefined && stroke.fillType !== 'color') approximated.add(LAYER_STYLE_LABELS.stroke)
    if (stroke.blendMode !== undefined && stroke.blendMode !== 'normal') approximated.add(LAYER_STYLE_LABELS.stroke)
    style.stroke = { enabled: on(stroke.enabled), size: clamp(size(stroke.size, 250, 3), 1, 250, 3), position: stroke.position ?? 'outside', color: hex(stroke.color), opacity: opacity(stroke.opacity ?? 1) }
  }
  const fill = first(effects.solidFill, LAYER_STYLE_LABELS.colorOverlay)
  if (fill !== undefined) style.colorOverlay = { enabled: on(fill.enabled), blendMode: blendOf(fill.blendMode, LAYER_STYLE_LABELS.colorOverlay), color: hex(fill.color), opacity: opacity(fill.opacity ?? 1) }
  const gradient = first(effects.gradientOverlay, LAYER_STYLE_LABELS.gradientOverlay)
  if (gradient !== undefined) {
    const solid = gradient.gradient?.type === 'solid' ? gradient.gradient : undefined
    // Photoshop keeps a stop's place in 4096ths; ours are set in hundredths.
    const stops = (solid?.colorStops ?? []).map((stop) => ({ offset: Math.round(clamp(stop.location, 0, 1, 0) * 1000) / 1000, color: hex(stop.color) })).slice(0, 8)
    const kind = gradient.type === 'radial' ? 'radial' : 'linear'
    if (solid === undefined || kind !== (gradient.type ?? 'linear') || (solid.opacityStops ?? []).some((stop) => stop.opacity < 1) || (solid.colorStops?.length ?? 0) > 8 || gradient.align === false) approximated.add(LAYER_STYLE_LABELS.gradientOverlay)
    style.gradientOverlay = {
      enabled: on(gradient.enabled), blendMode: blendOf(gradient.blendMode, LAYER_STYLE_LABELS.gradientOverlay), opacity: opacity(gradient.opacity ?? 1),
      style: kind, angle: angleOf(gradient.angle ?? 90), scale: clamp(gradient.scale, 10, 150, 100), reverse: gradient.reverse === true,
      stops: stops.length >= 2 ? stops : [{ offset: 0, color: '#000000' }, { offset: 1, color: '#FFFFFF' }]
    }
  }
  if (effects.innerGlow !== undefined) dropped.push('内发光')
  if (effects.bevel !== undefined) dropped.push('斜面和浮雕')
  if (effects.satin !== undefined) dropped.push('光泽')
  if (effects.patternOverlay !== undefined) dropped.push('图案叠加')
  return { style: Object.keys(style).length === 0 ? undefined : style, dropped, approximated: [...approximated] }
}
