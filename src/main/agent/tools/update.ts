import { z } from 'zod'
import type { SceneElement } from '../../../domain'
import type { sceneElementChangesSchema } from '../../../shared/agent-atomic-tools'
import { boxToTransform, colorSchema, percentBoxSchema } from './geometry'
import { sceneWrite } from './scene-write'
import { resolveFontName } from './fonts'
import { defineTool, rejected, resolveTargets } from './types'

type Changes = z.output<typeof sceneElementChangesSchema>

const setSchema = z.object({
  box: percentBoxSchema.optional().describe('新位置 [x, y, 宽, 高]'),
  move: z.tuple([z.number().min(-200).max(200), z.number().min(-200).max(200)]).optional().describe('平移 [dx, dy]，百分比'),
  scale: z.number().min(0.05).max(20).optional().describe('以中心缩放的倍数，0.8 即缩小 20%；文字同时缩放字号'),
  rotation: z.number().min(-360).max(360).optional().describe('旋转角度'),
  name: z.string().min(1).max(120).optional(),
  content: z.string().max(2_000).optional().describe('文字内容'),
  font: z.string().min(1).max(120).optional().describe('本机字体的中文名或英文名'),
  size: z.number().min(8).max(512).optional().describe('字号'),
  weight: z.number().int().min(100).max(900).optional(),
  color: colorSchema.optional().describe('文字、形状填充或光的颜色'),
  stroke: colorSchema.nullable().optional().describe('描边色，null 去掉描边'),
  align: z.enum(['start', 'center', 'end', 'justify']).optional(),
  letterSpacing: z.number().min(-100).max(100).optional(),
  lineHeight: z.number().min(0.5).max(5).optional(),
  opacity: z.number().min(0).max(1).optional(),
  blend: z.enum(['normal', 'multiply', 'screen', 'overlay', 'soft-light']).optional().describe('混合模式'),
  visible: z.boolean().optional(),
  locked: z.boolean().optional(),
  subject: z.string().min(1).max(1_000).optional().describe('主体占位的主体描述'),
  intensity: z.number().min(0).max(1).optional().describe('光的强度')
}).strict()

type SetArgs = z.infer<typeof setSchema>

const TEXT_ONLY = ['content', 'font', 'size', 'weight', 'align', 'letterSpacing', 'lineHeight'] as const

function changesFor(element: SceneElement, set: SetArgs): Changes | string {
  const textOnly = TEXT_ONLY.filter((key) => set[key] !== undefined)
  if (textOnly.length > 0 && element.type !== 'text') return `${textOnly.join('、')} 只能用于文字对象。`
  if (set.subject !== undefined && element.type !== 'placeholder') return 'subject 只能用于主体占位。'
  if (set.intensity !== undefined && element.type !== 'light') return 'intensity 只能用于光。'
  if (set.color !== undefined && !['text', 'shape', 'light'].includes(element.type)) return 'color 只能用于文字、形状和光。'
  if (set.stroke !== undefined && !['text', 'shape'].includes(element.type)) return 'stroke 只能用于文字和形状。'
  if (set.box !== undefined && (set.move !== undefined || set.scale !== undefined)) return 'box 不能和 move、scale 同时使用。'

  const changes: Changes = {}
  let transform = { ...element.transform }
  if (set.box !== undefined) transform = boxToTransform(set.box, transform.rotation)
  if (set.scale !== undefined) {
    const centerX = transform.x + transform.width / 2
    const centerY = transform.y + transform.height / 2
    transform = { ...transform, width: transform.width * set.scale, height: transform.height * set.scale }
    transform = { ...transform, x: centerX - transform.width / 2, y: centerY - transform.height / 2 }
  }
  if (set.move !== undefined) transform = { ...transform, x: transform.x + set.move[0] / 100, y: transform.y + set.move[1] / 100 }
  if (set.rotation !== undefined) transform = { ...transform, rotation: set.rotation }
  if (transform.width > 4 || transform.height > 4) return '缩放后超出了允许的尺寸。'
  if (Math.abs(transform.x) > 4 || Math.abs(transform.y) > 4) return '移动后离画布太远。'
  if (set.box !== undefined || set.scale !== undefined || set.move !== undefined || set.rotation !== undefined) changes.transform = transform

  if (set.name !== undefined) changes.name = set.name
  if (set.opacity !== undefined) changes.opacity = set.opacity
  if (set.blend !== undefined) {
    if (set.blend !== 'normal' && ['placeholder', 'mask', 'group'].includes(element.type)) return '这类对象不支持混合模式。'
    changes.blendMode = set.blend
  }
  if (set.visible !== undefined) changes.visible = set.visible
  if (set.locked !== undefined) changes.locked = set.locked
  if (element.type === 'text') {
    if (set.content !== undefined) changes.content = set.content
    if (set.font !== undefined) changes.fontFamily = set.font
    const size = set.size ?? (set.scale === undefined ? undefined : Math.round(element.fontSize * set.scale * 10) / 10)
    if (size !== undefined) {
      if (size < 8 || size > 512) return `字号 ${size} 超出 8–512 的范围。`
      changes.fontSize = size
    }
    if (set.weight !== undefined) changes.fontWeight = set.weight
    if (set.align !== undefined) changes.align = set.align
    if (set.letterSpacing !== undefined) changes.letterSpacing = set.letterSpacing
    if (set.lineHeight !== undefined) changes.lineHeight = set.lineHeight
    if (set.color !== undefined) changes.fill = set.color
    if (set.stroke !== undefined) {
      changes.stroke = set.stroke
      changes.strokeWidth = set.stroke === null ? 0 : Math.max(element.strokeWidth, 1)
    }
  } else if (element.type === 'shape') {
    if (set.color !== undefined) changes.fill = set.color
    if (set.stroke !== undefined) {
      changes.stroke = set.stroke
      changes.strokeWidth = set.stroke === null ? 0 : Math.max(element.strokeWidth, 0.004)
    }
  } else if (element.type === 'light') {
    if (set.color !== undefined) changes.color = set.color
    if (set.intensity !== undefined) changes.intensity = set.intensity
  } else if (element.type === 'placeholder' && set.subject !== undefined) {
    changes.subject = set.subject
  }
  return Object.keys(changes).length === 0 ? '没有要修改的属性。' : changes
}

function onlyUnlocks(set: SetArgs): boolean {
  return Object.entries(set).every(([key, value]) => value === undefined || key === 'locked' && value === false)
}

export const updateTool = defineTool({
  name: 'update',
  title: '修改对象',
  description: '只改被要求的属性，其余保持不变。可同时改多个对象；move 和 scale 是相对当前值的修改。',
  parameters: z.object({
    targets: z.array(z.string().min(1).max(120)).min(1).max(50).describe('对象编号'),
    set: setSchema.describe('要改的属性')
  }).strict(),
  registryName: 'scene.update_elements',
  describe: (args) => `修改 ${args.targets.join('、')}`,
  prepare(args, context) {
    const font = args.set.font === undefined ? null : resolveFontName(args.set.font, context)
    if (font !== null && 'problem' in font) return rejected(font.problem, font.hint)
    const set = font === null ? args.set : { ...args.set, font: font.family }
    const targets = resolveTargets(args.targets, context, { allowLocked: onlyUnlocks(set) })
    if (typeof targets === 'string') return rejected(targets, targets.includes('锁定') ? '先确认是否真的要改锁定的对象；需要时用 update 设 locked=false。' : undefined)
    const updates = []
    for (const element of targets) {
      const changes = changesFor(element, set)
      if (typeof changes === 'string') return rejected(`${context.refs.ref(element.id)}「${element.name}」：${changes}`)
      updates.push({ elementId: element.id, changes })
    }
    return sceneWrite({
      kind: 'scene.update_elements',
      expectedSceneRevision: context.scene.revision,
      summary: `修改 ${targets.length} 个对象`,
      updates
    } as const, context, `已修改 ${targets.map((element) => context.refs.ref(element.id)).join('、')}`, targets.map((element) => element.id))
  }
})
