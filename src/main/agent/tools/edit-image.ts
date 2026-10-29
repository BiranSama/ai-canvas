import { z } from 'zod'
import { jobStep } from './generation-report'
import { defineTool, rejected } from './types'

export const editImageTool = defineTool({
  name: 'edit_image',
  title: '局部修改图片',
  description: '付费局部修改画布上的一张图片，只改修改区（先用 add_mask 标出；用户本轮选出了区域时直接按选区改），原图保留。',
  parameters: z.object({
    target: z.string().min(1).max(120).describe('图片编号'),
    instruction: z.string().min(1).max(4_000).describe('怎么改'),
    count: z.number().int().min(1).max(4).default(1)
  }).strict(),
  registryName: 'generation.create_job',
  available: (context) => context.generation !== null && context.scene.elements.some((element) => element.type === 'image'),
  describe: (args) => `局部修改 ${args.target}`,
  prepare(args, context) {
    const service = context.generation
    if (service === null) return rejected('没有配置生图服务。')
    const target = context.refs.resolve(args.target, context.scene)
    if (typeof target === 'string') return rejected(target)
    if (target.type !== 'image') return rejected(`${args.target} 不是图片。`)
    const hasEditMask = context.scene.elements.some((element) => element.type === 'mask' && element.mode === 'edit' && element.targetElementId === target.id)
    // The person's selection is the region to change when nothing is marked on the image itself.
    const marked = context.marked ?? null
    const selection = !hasEditMask && marked !== null && (marked.targetElementId === null || marked.targetElementId === target.id)
      && (marked.regions ?? [marked]).some((region) => region.mode === 'edit') ? { ...marked, targetElementId: target.id } : null
    if (!hasEditMask && selection === null) return rejected(`${args.target} 还没有修改区。`, '先用 add_mask 在要改的地方标出修改区。')
    if (args.count > service.maxImages) return rejected(`一次最多生成 ${service.maxImages} 张。`)
    return jobStep({
      kind: 'canvas_edit',
      targetElementId: target.id,
      prompt: args.instruction,
      providerId: service.providerId,
      model: service.model,
      count: args.count,
      sourceMessageId: context.sourceMessageId,
      ephemeralAnnotation: selection
    }, context, `已提交局部修改 ${args.target} 的任务${selection === null ? '' : '，按用户的选区改'}`)
  }
})
