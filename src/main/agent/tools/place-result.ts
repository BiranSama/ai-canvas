import { z } from 'zod'
import { resolveResultRef } from './refs'
import { sceneWrite } from './scene-write'
import { defineTool, rejected } from './types'

export const placeResultTool = defineTool({
  name: 'place_result',
  title: '放回画布',
  description: '把一张成图放到画布上；指定 replace 时替换那个主体占位或图片，保留它的位置和层级。generate 的 layer 模式生成的图不填 replace 也会放回它重画的对象，并自动裁出、融入画面；unified 模式的图会盖在原图层上面、文字下面，不要填 replace。',
  parameters: z.object({
    result: z.string().min(1).max(8).describe('成图编号，如 "R1"'),
    replace: z.string().min(1).max(120).optional().describe('要替换的占位或图片编号')
  }).strict(),
  registryName: 'result.place_on_canvas',
  available: (context) => context.results.length > 0,
  describe: (args) => args.replace === undefined ? `把 ${args.result.toUpperCase()} 放到画布` : `用 ${args.result.toUpperCase()} 替换 ${args.replace}`,
  prepare(args, context) {
    const result = resolveResultRef(args.result, context.results)
    if (typeof result === 'string') return rejected(result)
    let targetId: string | undefined
    if (args.replace !== undefined) {
      const target = context.refs.resolve(args.replace, context.scene)
      if (typeof target === 'string') return rejected(target)
      if (target.type !== 'image' && target.type !== 'placeholder') return rejected(`${args.replace} 不是图片或主体占位，不能被替换。`)
      if (target.locked) return rejected(`${args.replace} 已锁定。`)
      targetId = target.id
    }
    return sceneWrite({
      kind: 'result.place_on_canvas',
      resultId: result.resultId,
      ...(targetId === undefined ? {} : { targetElementId: targetId })
    }, context, args.replace === undefined ? `已把 ${args.result.toUpperCase()} 放到画布` : `已用 ${args.result.toUpperCase()} 替换 ${args.replace}`, targetId === undefined ? [] : [targetId])
  }
})
