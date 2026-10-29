import { z } from 'zod'
import type { NormalizedTransform, Scene, SceneElement } from '../../../domain'
import type { ElementRefs } from './refs'

/** [x, y, width, height] in percent of the canvas, origin top left. */
export type PercentBox = readonly [number, number, number, number]

export const percentBoxSchema = z.tuple([
  z.number().min(-100).max(200),
  z.number().min(-100).max(200),
  z.number().gt(0).max(400),
  z.number().gt(0).max(400)
]).describe('[x, y, 宽, 高]，单位是画布宽高的百分比，原点在左上角')

export const colorSchema = z.string().trim().regex(/^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i, '颜色用 #RRGGBB')

const round1 = (value: number): number => Math.round(value * 10) / 10

export function boxToTransform(box: PercentBox, rotation = 0): NormalizedTransform {
  return { x: box[0] / 100, y: box[1] / 100, width: box[2] / 100, height: box[3] / 100, rotation }
}

export function transformToBox(transform: NormalizedTransform): PercentBox {
  return [round1(transform.x * 100), round1(transform.y * 100), round1(transform.width * 100), round1(transform.height * 100)]
}

export function formatBox(box: PercentBox): string {
  return `[${box.join(', ')}]`
}

function luminance(hex: string): number | null {
  const value = /^#([0-9a-f]{6})/i.exec(hex.length === 4 ? `#${[...hex.slice(1)].map((c) => c + c).join('')}` : hex)?.[1]
  if (value === undefined) return null
  const [r, g, b] = [0, 2, 4].map((offset) => {
    const channel = parseInt(value.slice(offset, offset + 2), 16) / 255
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** Near-black on light backgrounds, near-white on dark ones. */
export function readableTextColor(background: string): string {
  const value = luminance(background)
  return value !== null && value > 0.36 ? '#1F2328' : '#F4F4F2'
}

export function boundsOf(elements: readonly SceneElement[]): NormalizedTransform {
  const left = Math.min(...elements.map((element) => element.transform.x))
  const top = Math.min(...elements.map((element) => element.transform.y))
  const right = Math.max(...elements.map((element) => element.transform.x + element.transform.width))
  const bottom = Math.max(...elements.map((element) => element.transform.y + element.transform.height))
  return { x: left, y: top, width: Math.max(1e-6, right - left), height: Math.max(1e-6, bottom - top), rotation: 0 }
}

const TYPE_LABELS: Readonly<Record<SceneElement['type'], string>> = {
  image: '图片', text: '文字', sketch: '草图', shape: '形状', placeholder: '主体占位', light: '光', mask: '蒙版', group: '组'
}

export function typeLabel(element: SceneElement): string {
  return TYPE_LABELS[element.type]
}

/** One line of exact facts about an element, for `inspect` and the scene summary. */
export function elementFacts(element: SceneElement, refs: ElementRefs, scene: Pick<Scene, 'elements'>): string {
  const facts: string[] = [
    `${refs.ref(element.id)}「${element.name}」${typeLabel(element)}`,
    `位置 ${formatBox(transformToBox(element.transform))}`,
    ...(element.transform.rotation === 0 ? [] : [`旋转 ${round1(element.transform.rotation)}°`]),
    `第 ${element.zIndex + 1} 层`,
    ...(element.semanticRole === 'content' ? [] : [`角色 ${element.semanticRole}`]),
    ...(element.opacity === 1 ? [] : [`不透明度 ${round1(element.opacity)}`]),
    ...(element.blendMode === undefined || element.blendMode === 'normal' ? [] : [`混合 ${element.blendMode}`]),
    ...(element.visible ? [] : ['隐藏']),
    ...(element.locked ? ['已锁定'] : []),
    ...(element.groupId === null ? [] : [`属于 ${refOrUnknown(refs, element.groupId)}`]),
    ...('mask' in element && element.mask !== null && element.mask !== undefined ? [element.mask.enabled ? '有图层蒙版' : '图层蒙版已停用'] : [])
  ]
  if (element.type === 'text') {
    facts.push(`内容「${element.content}」`, `字体 ${element.fontFamily}`, `字号 ${element.fontSize}`, `字重 ${element.fontWeight}`,
      `颜色 ${element.fill}`, `对齐 ${element.align}`, `字间距 ${element.letterSpacing}`, `行高 ${element.lineHeight}`,
      ...(element.orientation === 'vertical' ? ['竖排'] : []),
      ...(element.stroke === null ? [] : [`描边 ${element.stroke}`]),
      ...(element.shadowColor === null ? [] : [`阴影 ${element.shadowColor}`]))
  } else if (element.type === 'shape') {
    facts.push(`形状 ${element.shape}`, ...(element.shape === 'path' && element.path !== undefined ? [`路径 ${element.path.length > 160 ? `${element.path.slice(0, 160)}…（共 ${element.path.length} 字符）` : element.path}`] : []),
      `填充 ${element.fill}`, ...(element.stroke === null ? [] : [`描边 ${element.stroke}`]),
      ...(element.cornerRadius === 0 ? [] : [`圆角 ${element.cornerRadius}`]))
  } else if (element.type === 'image') {
    const effects = element.effects
    const blend = effects === undefined ? [] : [
      ...(effects.colorMatch === null ? [] : ['色调已匹配周围']),
      ...(effects.feather === 0 ? [] : [`边缘羽化 ${round1(effects.feather * 100)}%`]),
      ...(effects.shadow === null ? [] : [`投影浓度 ${effects.shadow.opacity}`])
    ]
    facts.push(`适配 ${element.fit}`, `参考用途 ${element.referenceRole}`, ...(blend.length === 0 ? [] : [`融合：${blend.join('、')}`]))
  } else if (element.type === 'placeholder') {
    facts.push(`主体「${element.subject}」`, ...(element.pose === '' ? [] : [`姿态 ${element.pose}`]))
  } else if (element.type === 'light') {
    facts.push(`方向 ${element.direction}°`, `颜色 ${element.color}`, `强度 ${element.intensity}`)
  } else if (element.type === 'mask') {
    facts.push(`${element.mode === 'protect' ? '保护区' : '修改区'}`, `作用于 ${refOrUnknown(refs, element.targetElementId)}`)
  } else if (element.type === 'group') {
    facts.push(`包含 ${element.childIds.filter((id) => scene.elements.some((child) => child.id === id)).map((id) => refOrUnknown(refs, id)).join('、')}`)
  }
  return facts.join('，')
}

function refOrUnknown(refs: ElementRefs, id: string): string {
  try {
    return refs.ref(id)
  } catch {
    return '未知对象'
  }
}

const CHANGE_FIELDS: readonly (readonly [string, string])[] = [
  ['name', '名称'], ['content', '内容'], ['fontFamily', '字体'], ['fontSize', '字号'], ['fontWeight', '字重'],
  ['fill', '颜色'], ['color', '颜色'], ['stroke', '描边'], ['align', '对齐'], ['letterSpacing', '字间距'],
  ['lineHeight', '行高'], ['shape', '形状'], ['cornerRadius', '圆角'], ['subject', '主体'], ['direction', '方向'],
  ['intensity', '强度'], ['mode', '模式'], ['opacity', '不透明度'], ['blendMode', '混合模式'], ['visible', '可见'],
  ['locked', '锁定']
]

function display(value: unknown): string {
  if (typeof value === 'string') return value.length > 40 ? `「${value.slice(0, 40)}…」` : `「${value}」`
  if (typeof value === 'number') return String(round1(value))
  return String(value)
}

/** "E3「主标题」：字号 72 → 58；位置 […] → […]" for every element the step touched. */
export function changeLines(before: Scene, after: Scene, refs: ElementRefs, ids: readonly string[]): string[] {
  const lines: string[] = []
  for (const id of ids) {
    const previous = before.elements.find((element) => element.id === id)
    const next = after.elements.find((element) => element.id === id)
    if (next === undefined) {
      if (previous !== undefined) lines.push(`${refOrUnknown(refs, id)}「${previous.name}」已删除`)
      continue
    }
    if (previous === undefined) {
      lines.push(`新建 ${elementFacts(next, refs, after)}`)
      continue
    }
    const changes: string[] = []
    const previousBox = formatBox(transformToBox(previous.transform))
    const nextBox = formatBox(transformToBox(next.transform))
    if (previousBox !== nextBox) changes.push(`位置 ${previousBox} → ${nextBox}`)
    if (previous.transform.rotation !== next.transform.rotation) changes.push(`旋转 ${display(previous.transform.rotation)} → ${display(next.transform.rotation)}`)
    if (previous.zIndex !== next.zIndex) changes.push(`图层 第 ${previous.zIndex + 1} 层 → 第 ${next.zIndex + 1} 层`)
    for (const [field, label] of CHANGE_FIELDS) {
      const left = (previous as Record<string, unknown>)[field]
      const right = (next as Record<string, unknown>)[field]
      if (left !== right && (left !== undefined || right !== undefined)) changes.push(`${label} ${display(left)} → ${display(right)}`)
    }
    if (changes.length > 0) lines.push(`${refOrUnknown(refs, id)}「${next.name}」：${changes.join('；')}`)
  }
  return lines
}
