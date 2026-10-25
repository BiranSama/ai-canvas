import { z } from 'zod'
import type { SceneElement } from '../../../domain'
import { boxToTransform, percentBoxSchema } from './geometry'
import { createPlan, elementBase, sceneWrite } from './scene-write'
import { defineTool, rejected } from './types'

export const addMaskTool = defineTool({
  name: 'add_mask',
  title: '标记区域',
  description: '在图片上标出修改区（局部重画只改这里）或保护区（生成时保持不变）。局部修改图片前先标修改区。',
  parameters: z.object({
    target: z.string().min(1).max(120).describe('图片或主体占位的编号'),
    mode: z.enum(['edit', 'protect']).describe('edit 修改区，protect 保护区'),
    region: percentBoxSchema.describe('区域 [x, y, 宽, 高]，画布百分比'),
    feather: z.number().min(0).max(1).optional().describe('边缘羽化 0–1')
  }).strict(),
  registryName: 'scene.create_elements',
  describe: (args) => `在 ${args.target} 上标出${args.mode === 'edit' ? '修改区' : '保护区'}`,
  prepare(args, context) {
    const target = context.refs.resolve(args.target, context.scene)
    if (typeof target === 'string') return rejected(target)
    if (target.type !== 'image' && target.type !== 'placeholder') return rejected(`${args.target} 不是图片或主体占位，不能标区域。`)
    const label = args.mode === 'edit' ? '修改区' : '保护区'
    const element: SceneElement = {
      ...elementBase(context, { name: `${label}·${target.name}`.slice(0, 120), transform: boxToTransform(args.region), role: 'mask' }),
      type: 'mask',
      mode: args.mode,
      targetElementId: target.id,
      paths: [{ id: context.newId(), points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], closed: true }],
      feather: args.feather ?? 0.15
    }
    return sceneWrite(createPlan(context, `标记${label}`, [element]), context, `已在 ${context.refs.ref(target.id)} 上标出${label}`, [element.id])
  }
})
