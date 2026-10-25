import { z } from 'zod'
import type { SceneElement } from '../../../domain'
import { boxToTransform, colorSchema, type PercentBox } from './geometry'
import { createPlan, elementBase, sceneWrite } from './scene-write'
import { defineTool, rejected, resolveTargets } from './types'

const SOURCES = {
  'top-left': { label: '左上方', degrees: 225, box: [-15, -15, 70, 70] },
  top: { label: '上方', degrees: 270, box: [15, -25, 70, 60] },
  'top-right': { label: '右上方', degrees: 315, box: [45, -15, 70, 70] },
  left: { label: '左侧', degrees: 180, box: [-25, 15, 60, 70] },
  right: { label: '右侧', degrees: 0, box: [65, 15, 60, 70] },
  'bottom-left': { label: '左下方', degrees: 135, box: [-15, 45, 70, 70] },
  bottom: { label: '下方', degrees: 90, box: [15, 65, 70, 60] },
  'bottom-right': { label: '右下方', degrees: 45, box: [45, 45, 70, 70] },
  front: { label: '正面', degrees: 0, box: [10, 10, 80, 80] },
  back: { label: '背后', degrees: 180, box: [10, 10, 80, 80] }
} as const satisfies Record<string, { label: string; degrees: number; box: PercentBox }>

export const addLightTool = defineTool({
  name: 'add_light',
  title: '添加光影',
  description: '加一束方向光，说明光从哪来、什么颜色、多强。生图时用来引导光影。',
  parameters: z.object({
    from: z.enum(Object.keys(SOURCES) as [keyof typeof SOURCES, ...(keyof typeof SOURCES)[]]).describe('光从哪个方向来'),
    color: colorSchema.optional().describe('光色，暖光如 #FFD2A1，冷光如 #A7C9F4'),
    intensity: z.number().min(0).max(1).optional().describe('强度 0–1'),
    softness: z.number().min(0).max(1).optional().describe('柔和度 0–1'),
    targets: z.array(z.string().min(1).max(120)).max(10).optional().describe('被照亮的对象'),
    description: z.string().max(300).optional().describe('光的效果，如「清晨薄雾中的侧逆光」')
  }).strict(),
  registryName: 'scene.create_elements',
  describe: (args) => `添加${SOURCES[args.from].label}的光`,
  prepare(args, context) {
    const targets = resolveTargets(args.targets ?? [], context, { allowLocked: true })
    if (typeof targets === 'string') return rejected(targets)
    const source = SOURCES[args.from]
    const element: SceneElement = {
      ...elementBase(context, {
        name: `光·${source.label}`,
        transform: boxToTransform(source.box),
        role: 'lighting',
        description: args.description ?? `光从${source.label}照来`
      }),
      type: 'light',
      direction: source.degrees,
      color: args.color ?? '#FFE2BD',
      intensity: args.intensity ?? 0.65,
      softness: args.softness ?? 0.75,
      range: 1,
      targetElementIds: targets.map((element) => element.id)
    }
    return sceneWrite(createPlan(context, '添加光影', [element]), context, `已添加${source.label}的光`, [element.id])
  }
})
