import { z } from 'zod'
import type { SceneElement } from '../../../domain'
import { logoPlacement } from '../../../shared/user-memory'
import { percentBoxSchema, type PercentBox } from './geometry'
import { resolveResultRef } from './refs'
import { createPlan, elementBase, sceneWrite } from './scene-write'
import { defineTool, rejected, type AgentToolContext } from './types'

async function placeLogo(box: PercentBox | undefined, context: AgentToolContext) {
  const logo = await context.brandLogo?.() ?? null
  if (logo === null) return rejected('没有可用的品牌 Logo。', '用户可以在设置的「品牌与记忆」里上传。')
  const layer: SceneElement = {
    ...elementBase(context, { name: 'Logo', transform: logoPlacement(box, logo, context.scene.canvas), role: 'logo' }),
    type: 'image',
    assetId: logo.assetId,
    crop: { x: 0, y: 0, width: 1, height: 1 },
    fit: 'fill',
    referenceRole: 'general'
  }
  return sceneWrite(createPlan(context, '放上品牌 Logo', [layer]), context, `已放上品牌 Logo，在最上面，位置 ${box === undefined ? '左上角' : `[${box.join(', ')}]`}`, [layer.id])
}

export const placeResultTool = defineTool({
  name: 'place_result',
  title: '放回画布',
  description: '把一张成图放到画布上；指定 replace 时替换那个主体占位或图片，保留它的位置和层级。generate 的 layer 模式生成的图不填 replace 也会放回它重画的对象，并自动裁出、融入画面；unified 模式的图会盖在原图层上面、文字下面，不要填 replace。',
  parameters: z.object({
    result: z.string().min(1).max(8).describe('成图编号，如 "R1"；logo 放品牌 Logo'),
    replace: z.string().min(1).max(120).optional().describe('要替换的占位或图片编号'),
    box: percentBoxSchema.optional().describe('logo 的位置，不填放左上角')
  }).strict(),
  registryName: 'result.place_on_canvas',
  available: (context) => context.results.length > 0 || (context.brandLogo !== null && context.brandLogo !== undefined),
  describe: (args) => args.result.toLowerCase() === 'logo' ? '放上品牌 Logo' : args.replace === undefined ? `把 ${args.result.toUpperCase()} 放到画布` : `用 ${args.result.toUpperCase()} 替换 ${args.replace}`,
  prepare(args, context) {
    if (args.result.toLowerCase() === 'logo') return placeLogo(args.box, context)
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
