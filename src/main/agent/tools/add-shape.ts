import { z } from 'zod'
import { isClosedPath, normalizeSvgPath, type SceneElement } from '../../../domain'
import { boxToTransform, colorSchema, percentBoxSchema } from './geometry'
import { createPlan, elementBase, sceneWrite } from './scene-write'
import { defineTool, rejected } from './types'

const SHAPE_LABELS = { rectangle: '矩形', ellipse: '椭圆', line: '线', path: '自由形状' } as const
const DEFAULT_FILL = '#D9D4CA'
const DEFAULT_LINE_COLOR = '#3A3D42'
const TRANSPARENT = '#00000000'

export const addShapeTool = defineTool({
  name: 'add_shape',
  title: '添加形状',
  description: '添加矩形、椭圆、线或自由形状，用于色块、分隔线、底板，以及叶子、波浪、徽章、对话框、简单图标这类轮廓。path 用 SVG 路径语法，坐标是 box 里的 0–100（0,0 左上，100,100 右下），支持 M L H V C S Q T A Z。以 Z 闭合的路径会填色；没闭合的只描边。',
  parameters: z.object({
    shape: z.enum(['rectangle', 'ellipse', 'line', 'path']),
    box: percentBoxSchema,
    path: z.string().min(1).max(20_000).optional().describe('shape=path 时的 SVG 路径，坐标 0–100，如 "M50 0 C80 30 80 70 50 100 C20 70 20 30 50 0 Z"'),
    color: colorSchema.optional().describe('填充色；线条用它作颜色'),
    stroke: colorSchema.optional().describe('描边色'),
    strokeWidth: z.number().min(0).max(0.1).optional().describe('描边粗细，占形状短边的比例，常用 0.01–0.04'),
    radius: z.number().min(0).max(0.5).optional().describe('圆角，占短边的比例 0–0.5'),
    name: z.string().min(1).max(60).optional()
  }).strict(),
  registryName: 'scene.create_elements',
  describe: (args) => `添加${SHAPE_LABELS[args.shape]}${args.name === undefined ? '' : `「${args.name}」`}`,
  prepare(args, context) {
    const label = SHAPE_LABELS[args.shape]
    let path: string | undefined
    let closed = true
    if (args.shape === 'path') {
      if (args.path === undefined) return rejected('shape=path 需要 path。', '写一段 SVG 路径，坐标用 0–100。')
      const normalized = normalizeSvgPath(args.path)
      if ('error' in normalized) return rejected(`路径无法使用：${normalized.error}`)
      path = normalized.path
      closed = isClosedPath(path)
    }
    const lineArt = args.shape === 'line' || !closed
    const stroke = args.stroke ?? (lineArt ? args.color ?? DEFAULT_LINE_COLOR : null)
    const element: SceneElement = {
      ...elementBase(context, { name: args.name ?? label, transform: boxToTransform(args.box), role: 'decoration' }),
      type: 'shape',
      shape: args.shape,
      ...(path === undefined ? {} : { path }),
      // An open outline is drawn as a line; it fills only when a colour is asked for with a separate stroke.
      fill: args.shape === 'path' && !closed && (args.stroke === undefined || args.color === undefined) ? TRANSPARENT : args.color ?? DEFAULT_FILL,
      stroke,
      strokeWidth: args.strokeWidth ?? (stroke === null ? 0 : args.shape === 'path' ? 0.02 : 0.004),
      cornerRadius: args.radius ?? 0,
      role: 'final'
    }
    return sceneWrite(createPlan(context, `添加${label}`, [element]), context, `已添加${label}`, [element.id])
  }
})
