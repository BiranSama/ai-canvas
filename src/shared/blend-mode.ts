import type { BlendMode, SceneElement } from '../domain'

export const BLEND_MODES = ['normal', 'multiply', 'screen', 'overlay', 'soft-light'] as const satisfies readonly BlendMode[]

const BLEND_MODE_LABELS: Readonly<Record<BlendMode, string>> = {
  normal: '正常',
  multiply: '正片叠底',
  screen: '滤色',
  overlay: '叠加',
  'soft-light': '柔光'
}

export function resolveBlendMode(element: Pick<SceneElement, 'blendMode'> | { readonly blendMode?: BlendMode }): BlendMode {
  return element.blendMode ?? 'normal'
}

export function blendModeLabel(blendMode: BlendMode): string {
  const label = BLEND_MODE_LABELS[blendMode]
  if (label === undefined) throw new Error(`Unsupported blend mode: ${String(blendMode)}`)
  return label
}

export type BlendCanvasOperation = 'source-over' | 'multiply' | 'screen' | 'overlay' | 'soft-light'

export function blendModeToCanvasOperation(blendMode: BlendMode): BlendCanvasOperation {
  switch (blendMode) {
    case 'normal': return 'source-over'
    case 'multiply': return 'multiply'
    case 'screen': return 'screen'
    case 'overlay': return 'overlay'
    case 'soft-light': return 'soft-light'
    default: throw new Error(`Unsupported blend mode: ${String(blendMode)}`)
  }
}

export function blendModeToSvgStyle(blendMode: BlendMode): string {
  switch (blendMode) {
    case 'normal': return ''
    case 'multiply': return ' style="mix-blend-mode:multiply"'
    case 'screen': return ' style="mix-blend-mode:screen"'
    case 'overlay': return ' style="mix-blend-mode:overlay"'
    case 'soft-light': return ' style="mix-blend-mode:soft-light"'
    default: throw new Error(`Unsupported blend mode: ${String(blendMode)}`)
  }
}

export function elementSupportsBlendMode(type: SceneElement['type']): boolean {
  return type === 'text' || type === 'image' || type === 'shape' || type === 'sketch' || type === 'light'
}

export function blendModeIntent(blendMode: BlendMode): string {
  switch (blendMode) {
    case 'normal': return ''
    case 'multiply': return '以正片叠底融入下方层，适合压入阴影、纸张或纹理'
    case 'screen': return '以滤色叠加到下方层，形成轻盈的发光或背光'
    case 'overlay': return '以叠加增强明暗对比，同时保留下方层结构'
    case 'soft-light': return '以柔光温和塑形，保留下方层的色调与层次'
    default: throw new Error(`Unsupported blend mode: ${String(blendMode)}`)
  }
}
