import { z } from 'zod'
import { jobStep } from './generation-report'
import { defineTool, rejected } from './types'

export const generateTool = defineTool({
  name: 'generate',
  title: '生成图片',
  description: '付费生成图片。canvas：把当前画布（主体占位、光影、文字位置）合成参考图交给生图模型；prompt：只用文字说明生成。只在明确要求生图时调用，先用 look 的「参考图」模式看一眼。',
  parameters: z.object({
    scope: z.enum(['canvas', 'prompt']).describe('canvas 按画布生成，prompt 只用文字'),
    brief: z.string().min(1).max(4_000).describe('想要的画面：主体、氛围、光线、风格，用完整的句子'),
    count: z.number().int().min(1).max(4).default(1).describe('张数')
  }).strict(),
  registryName: 'generation.create_job',
  available: (context) => context.generation !== null,
  describe: (args) => `${args.scope === 'canvas' ? '按画布' : '按文字'}生成 ${args.count} 张图`,
  prepare(args, context) {
    const service = context.generation
    if (service === null) return rejected('没有配置生图服务。', '告诉用户需要先在设置里配置生图服务。')
    if (args.count > service.maxImages) return rejected(`一次最多生成 ${service.maxImages} 张。`)
    if (args.scope === 'canvas') {
      return jobStep({
        kind: 'canvas_generation',
        originalRequirement: args.brief,
        providerId: service.providerId,
        model: service.model,
        count: args.count,
        referenceMode: 'hybrid',
        sourceMessageId: context.sourceMessageId
      }, context, `已提交按画布生成 ${args.count} 张的任务`)
    }
    const canvas = context.scene.canvas
    return jobStep({
      kind: 'generation',
      request: {
        prompt: args.brief,
        negativePrompt: '',
        aspectWidth: canvas.aspectWidth,
        aspectHeight: canvas.aspectHeight,
        outputWidth: canvas.outputWidth,
        outputHeight: canvas.outputHeight,
        count: args.count,
        providerId: service.providerId,
        model: service.model,
        references: [],
        parameters: {},
        sourceMessageId: context.sourceMessageId,
        parentResultId: null,
        referenceMode: 'visual',
        variationInstruction: '',
        preserveConstraints: ''
      }
    }, context, `已提交按文字生成 ${args.count} 张的任务`)
  }
})
