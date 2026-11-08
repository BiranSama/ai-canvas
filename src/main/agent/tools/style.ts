import { z } from 'zod'
import { blendModeSchema, layerStyleSchema, type LayerStyle, type LayerStyleKind, type SceneCommand } from '../../../domain'
import { defaultLayerStyle, describeLayerStyle, LAYER_STYLE_LABELS } from '../../../shared/layer-styles'
import { colorSchema } from './geometry'
import { batchPlan, sceneWrite } from './scene-write'
import { defineTool, rejected, resolveTargets } from './types'

/*
 * Photoshop's layer styles for the Agent: a drop shadow, inner shadow,
 * outer glow, stroke, colour or gradient overlay on image, text and shape
 * layers, each at most once, changed in place when it is there already.
 */

const KINDS = {
  drop_shadow: 'dropShadow',
  inner_shadow: 'innerShadow',
  outer_glow: 'outerGlow',
  stroke: 'stroke',
  color_overlay: 'colorOverlay',
  gradient_overlay: 'gradientOverlay'
} as const satisfies Record<string, LayerStyleKind>

/** The settings, by the names the description lists; checked here so the tool's own schema stays short. */
const valuesSchema = z.object({
  color: colorSchema,
  opacity: z.number().min(0).max(1),
  blend: blendModeSchema,
  angle: z.number().min(-180).max(180),
  distance: z.number().min(0).max(3000),
  spread: z.number().min(0).max(100),
  choke: z.number().min(0).max(100),
  size: z.number().min(0).max(250),
  position: z.enum(['outside', 'inside', 'center']),
  colors: z.array(colorSchema).min(2).max(8),
  style: z.enum(['linear', 'radial']),
  scale: z.number().min(10).max(150),
  reverse: z.boolean()
}).partial().strict()
type Values = z.infer<typeof valuesSchema>

/** Which value names each style takes. */
const ALLOWED: Readonly<Record<LayerStyleKind, readonly (keyof Values)[]>> = {
  dropShadow: ['color', 'opacity', 'blend', 'angle', 'distance', 'spread', 'size'],
  innerShadow: ['color', 'opacity', 'blend', 'angle', 'distance', 'choke', 'size'],
  outerGlow: ['color', 'opacity', 'blend', 'spread', 'size'],
  stroke: ['color', 'opacity', 'size', 'position'],
  colorOverlay: ['color', 'opacity', 'blend'],
  gradientOverlay: ['colors', 'opacity', 'blend', 'angle', 'style', 'scale', 'reverse']
}

function entryFrom(kind: LayerStyleKind, values: Values, current: LayerStyle[LayerStyleKind] | undefined): NonNullable<LayerStyle[LayerStyleKind]> | string {
  const unknown = Object.keys(values).filter((key) => !ALLOWED[kind].includes(key as keyof Values))
  if (unknown.length > 0) return `${LAYER_STYLE_LABELS[kind]}没有 ${unknown.join('、')}；能用的是 ${ALLOWED[kind].join('、')}。`
  const { blend, colors, ...rest } = values
  const base = { ...(current ?? defaultLayerStyle(kind, '#FFFFFF')), enabled: true } as Record<string, unknown>
  const next: Record<string, unknown> = { ...base, ...rest, ...(blend === undefined ? {} : { blendMode: blend }) }
  // Colours spread evenly along the gradient.
  if (colors !== undefined) next.stops = colors.map((color, index) => ({ offset: Math.round(index / (colors.length - 1) * 1000) / 1000, color: color.toUpperCase() }))
  if (typeof next.color === 'string') next.color = next.color.toUpperCase()
  if (kind === 'stroke' && typeof next.size === 'number' && next.size < 1) return '描边 size 至少 1 像素。'
  const parsed = layerStyleSchema.safeParse({ [kind]: next })
  return parsed.success ? parsed.data[kind]! : `参数不成立：${parsed.error.issues.map((issue) => issue.message).join('；')}`
}

export const styleTool = defineTool({
  name: 'style',
  title: '图层样式',
  description: '像 Photoshop 的图层样式，加在图片、文字、形状图层上，可撤销。每种一层一个，已有时只改给的值。kind 与 values：drop_shadow 投影、inner_shadow 内阴影：color、opacity、blend、angle（光的方向，120 为左上）、distance、spread 或 choke（0~100）、size；outer_glow：color、opacity、blend、spread、size；stroke：color、size、position（outside/inside/center）、opacity；color_overlay：color、opacity、blend；gradient_overlay：colors（2~8 色）、angle、style（linear/radial）、scale、reverse、opacity、blend。off 关掉（保留设置），remove 去掉。像素按输出尺寸。',
  parameters: z.object({
    targets: z.array(z.string()).min(1),
    kind: z.enum(Object.keys(KINDS) as [keyof typeof KINDS, ...(keyof typeof KINDS)[]]),
    values: z.record(z.string(), z.unknown()).optional(),
    off: z.boolean().optional(),
    remove: z.boolean().optional()
  }).strict(),
  registryName: 'scene.update_elements',
  describe: (args) => `图层样式 ${args.targets.join('、')}：${LAYER_STYLE_LABELS[KINDS[args.kind]]}${args.remove === true ? '（去掉）' : args.off === true ? '（关掉）' : ''}`,
  prepare(args, context) {
    const kind = KINDS[args.kind]
    const label = LAYER_STYLE_LABELS[kind]
    const parsed = valuesSchema.safeParse(args.values ?? {})
    if (!parsed.success) return rejected(`values 不成立：${parsed.error.issues.map((issue) => `${issue.path.join('.') || '参数'} ${issue.message}`).join('；')}`, '名字和范围见 style 的说明。')
    if (args.remove === true && args.off === true) return rejected('off 和 remove 只用一个。')
    const targets = resolveTargets(args.targets, context)
    if (typeof targets === 'string') return rejected(targets)
    const commands: SceneCommand[] = []
    const done: string[] = []
    for (const element of targets) {
      const ref = context.refs.ref(element.id)
      if (element.type !== 'image' && element.type !== 'text' && element.type !== 'shape') return rejected(`${ref} 是${element.type === 'adjustment' ? '调整图层' : '这类对象'}，不能加图层样式。`, '图层样式加在图片、文字、形状图层上。')
      const own = element.style ?? {}
      if (args.remove === true) {
        if (own[kind] === undefined) return rejected(`${ref} 上没有${label}。`)
        const rest: LayerStyle = { ...own }
        delete rest[kind]
        commands.push({ kind: 'element.update', elementId: element.id, changes: { style: rest } })
        done.push(`已去掉 ${ref} 的${label}`)
        continue
      }
      if (args.off === true) {
        const entry = own[kind]
        if (entry === undefined) return rejected(`${ref} 上没有${label}。`)
        commands.push({ kind: 'element.update', elementId: element.id, changes: { style: { ...own, [kind]: { ...entry, enabled: false } } } })
        done.push(`已关掉 ${ref} 的${label}（设置保留）`)
        continue
      }
      const entry = entryFrom(kind, parsed.data, own[kind])
      if (typeof entry === 'string') return rejected(`${ref}：${entry}`)
      commands.push({ kind: 'element.update', elementId: element.id, changes: { style: { ...own, [kind]: entry } } })
      done.push(`已${own[kind] === undefined ? '给' : '改'} ${ref} 的${describeLayerStyle({ [kind]: entry })}`)
    }
    return sceneWrite(batchPlan(`图层样式：${label}`, commands), context, done.join('；'), targets.map((element) => element.id))
  }
})
