import { z } from 'zod'
import { softShadow } from '../../../shared/layer-effects'
import { sceneWrite } from './scene-write'
import { defineTool, rejected } from './types'

const DEFAULT_TONE = 0.4
const DEFAULT_FEATHER = 0.04

export const blendTool = defineTool({
  name: 'blend',
  title: '融入画面',
  description: '让画布上一张图片和周围画面更协调，不重新生成、不花钱、可撤销，原图不变。tone 把它的色调和明暗往周围拉（0 去掉，0.4 适中，1 平均色完全一致）；feather 让四边渐隐（占短边比例，常用 0.03–0.08，0 去掉）；shadow 加柔和投影（浓度 0–1，0 去掉，适合背景透明的抠图主体）。只填 target 时按适中力度调色，不透明的图再加一点羽化。',
  parameters: z.object({
    target: z.string().min(1).max(120).describe('图片编号'),
    tone: z.number().min(0).max(1).optional(),
    feather: z.number().min(0).max(0.3).optional(),
    shadow: z.number().min(0).max(1).optional()
  }).strict(),
  registryName: 'scene.update_elements',
  available: (context) => context.scene.elements.some((element) => element.type === 'image'),
  describe: (args) => `让 ${args.target} 融入画面`,
  async prepare(args, context) {
    const target = context.refs.resolve(args.target, context.scene)
    if (typeof target === 'string') return rejected(target)
    if (target.type !== 'image') return rejected(`${args.target} 不是图片。`, '融入画面只用于图片；主体占位先生成再放回。')
    if (target.locked) return rejected(`${args.target} 已锁定。`)
    const onlyTarget = args.tone === undefined && args.feather === undefined && args.shadow === undefined
    const current = target.effects ?? { colorMatch: null, feather: 0, shadow: null }
    let { colorMatch, feather, shadow } = current
    const tone = args.tone ?? (onlyTarget ? DEFAULT_TONE : undefined)
    let opaque: boolean | null = null
    if (tone === 0) colorMatch = null
    else if (tone !== undefined) {
      const measured = await context.measureTone?.(target.id, tone) ?? null
      if (measured === null) return rejected('现在量不了这张图周围的颜色。', '只调 feather 或 shadow，或者稍后再试。')
      colorMatch = measured.colorMatch
      opaque = measured.opaque
    }
    if (args.feather !== undefined) feather = args.feather
    else if (onlyTarget && opaque === true && feather === 0) feather = DEFAULT_FEATHER
    if (args.shadow !== undefined) shadow = args.shadow === 0 ? null : softShadow(args.shadow)
    const changes = [
      colorMatch === null ? (current.colorMatch === null ? null : '去掉色调匹配') : `色调往周围靠（力度 ${tone ?? '不变'}）`,
      feather === current.feather ? null : feather === 0 ? '去掉羽化' : `边缘羽化 ${Math.round(feather * 100)}%`,
      shadow === current.shadow ? null : shadow === null ? '去掉投影' : `投影浓度 ${shadow.opacity}`
    ].filter((line): line is string => line !== null)
    const ref = context.refs.ref(target.id)
    return sceneWrite({
      kind: 'scene.update_elements',
      expectedSceneRevision: context.scene.revision,
      summary: `让 ${target.name} 融入画面`,
      updates: [{ elementId: target.id, changes: { effects: { colorMatch, feather, shadow } } }]
    } as const, context, `已调整 ${ref} 的融合效果：${changes.length === 0 ? '没有变化' : changes.join('，')}`, [target.id])
  }
})
