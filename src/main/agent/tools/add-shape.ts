import { z } from 'zod'
import type { SceneElement } from '../../../domain'
import { boxToTransform, colorSchema, percentBoxSchema } from './geometry'
import { createPlan, elementBase, sceneWrite } from './scene-write'
import { defineTool } from './types'

const SHAPE_LABELS = { rectangle: '矩形', ellipse: '椭圆', line: '线' } as const

export const addShapeTool = defineTool({
  name: 'add_shape',
  title: '添加形状',
  description: '添加矩形、椭圆或线，用于色块、分隔线、底板等。',
  parameters: z.object({
    shape: z.enum(['rectangle', 'ellipse', 'line']),
    box: percentBoxSchema,
    color: colorSchema.optional().describe('填充色；线条用它作颜色'),
    stroke: colorSchema.optional().describe('描边色'),
    radius: z.number().min(0).max(0.5).optional().describe('圆角，占短边的比例 0–0.5'),
    name: z.string().min(1).max(60).optional()
  }).strict(),
  registryName: 'scene.create_elements',
  describe: (args) => `添加${SHAPE_LABELS[args.shape]}${args.name === undefined ? '' : `「${args.name}」`}`,
  prepare(args, context) {
    const label = SHAPE_LABELS[args.shape]
    const element: SceneElement = {
      ...elementBase(context, { name: args.name ?? label, transform: boxToTransform(args.box), role: 'decoration' }),
      type: 'shape',
      shape: args.shape,
      fill: args.color ?? '#D9D4CA',
      stroke: args.stroke ?? (args.shape === 'line' ? args.color ?? '#D9D4CA' : null),
      strokeWidth: args.stroke !== undefined || args.shape === 'line' ? 0.004 : 0,
      cornerRadius: args.radius ?? 0,
      role: 'final'
    }
    return sceneWrite(createPlan(context, `添加${label}`, [element]), context, `已添加${label}`, [element.id])
  }
})
