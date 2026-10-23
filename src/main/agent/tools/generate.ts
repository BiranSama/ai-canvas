import { z } from 'zod'
import { jobStep } from './generation-report'
import { defineTool, rejected } from './types'

export const generateTool = defineTool({
  name: 'generate',
  title: '生成图片',
  description: '付费生成图片。canvas：把当前画布（主体占位、光影、文字位置）合成参考图交给生图模型；prompt：只用文字说明生成；layer：只重画 target 这个主体占位或图片所在的一块，生图模型看着它下面的画面画，光线和色调跟周围一致，放回时自动裁出并融入画面；unified：画面已经拼好、但各部分不像一张图时，把除文字外的整张画面交给生图模型统一重绘，构图不变、光线和质感统一，放回后盖在原图层上面，文字留在最上层不动。单独生成某个主体时优先用 layer。只在明确要求生图时调用，先用 look 看一眼。',
  parameters: z.object({
    scope: z.enum(['canvas', 'prompt', 'layer', 'unified']).describe('canvas 按画布生成，prompt 只用文字，layer 只重画 target 那一块，unified 统一重绘整张画面'),
    target: z.string().min(1).max(120).optional().describe('scope=layer 时要重画的主体占位或图片编号'),
    brief: z.string().min(1).max(4_000).describe('想要的画面：主体、氛围、光线、风格，用完整的句子；layer 时只写这一块要画什么；unified 时写想统一成什么光线、质感和风格'),
    count: z.number().int().min(1).max(4).default(1).describe('张数')
  }).strict(),
  registryName: 'generation.create_job',
  available: (context) => context.generation !== null,
  describe: (args) => args.scope === 'layer' ? `重画 ${args.target ?? '对象'} 这一块（${args.count} 张）`
    : args.scope === 'unified' ? `统一重绘整张画面（${args.count} 张）` : `${args.scope === 'canvas' ? '按画布' : '按文字'}生成 ${args.count} 张图`,
  prepare(args, context) {
    const service = context.generation
    if (service === null) return rejected('没有配置生图服务。', '告诉用户需要先在设置里配置生图服务。')
    if (args.count > service.maxImages) return rejected(`一次最多生成 ${service.maxImages} 张。`)
    if (args.scope === 'layer') {
      if (args.target === undefined) return rejected('scope=layer 需要 target。', '填要重画的主体占位或图片编号。')
      if (service.localEdits === false) return rejected('当前生图服务不支持局部重画。', '改用 scope=canvas，或告诉用户换一个支持局部修改的生图服务。')
      const target = context.refs.resolve(args.target, context.scene)
      if (typeof target === 'string') return rejected(target)
      if (target.type !== 'placeholder' && target.type !== 'image') return rejected(`${args.target} 不是主体占位或图片。`, '先用 add_subject 放一个主体占位。')
      if (target.locked) return rejected(`${args.target} 已锁定。`)
      return jobStep({
        kind: 'canvas_edit',
        mode: 'in-context',
        targetElementId: target.id,
        prompt: args.brief,
        providerId: service.providerId,
        model: service.model,
        count: args.count,
        sourceMessageId: context.sourceMessageId,
        ephemeralAnnotation: null
      }, context, `已提交重画 ${args.target} 的任务（${args.count} 张），完成后用 place_result 放回，会自动裁出这一块并融入画面`)
    }
    if (args.scope === 'unified') {
      if (service.references === false) return rejected('当前生图服务不接受参考图，不能统一重绘。', '告诉用户换一个能用参考图的生图服务。')
      if (!context.scene.elements.some((element) => element.visible && element.type !== 'text' && element.type !== 'group' && element.type !== 'placeholder' && element.type !== 'light' && element.type !== 'mask')) {
        return rejected('画布上还没有可以统一重绘的图片或形状。', '先把画面拼出来，或者用 scope=canvas 按画布生成。')
      }
      return jobStep({
        kind: 'canvas_generation',
        mode: 'unified',
        originalRequirement: args.brief,
        providerId: service.providerId,
        model: service.model,
        count: args.count,
        referenceMode: 'visual',
        sourceMessageId: context.sourceMessageId
      }, context, `已提交统一重绘整张画面的任务（${args.count} 张），完成后用 place_result 放回：它会盖在原图层上面，文字留在最上层`)
    }
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
