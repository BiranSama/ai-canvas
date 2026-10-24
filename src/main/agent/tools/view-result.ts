import { z } from 'zod'
import { resolveResultRef } from './refs'
import { answer, defineTool, rejected } from './types'

export const viewResultTool = defineTool({
  name: 'view_result',
  title: '看成图',
  description: '查看一张已生成的图片（R1、R2……，按生成先后编号）。评价效果或决定放回哪里之前用。',
  parameters: z.object({ result: z.string().min(1).max(8).describe('成图编号，如 "R1"') }).strict(),
  registryName: 'generation.get_results',
  available: (context) => context.results.length > 0 && context.readAsset !== undefined && context.readAsset !== null,
  describe: (args) => `查看成图 ${args.result.toUpperCase()}`,
  async prepare(args, context) {
    const result = resolveResultRef(args.result, context.results)
    if (typeof result === 'string') return rejected(result)
    if (context.readAsset === undefined || context.readAsset === null) return rejected('当前无法读取成图。')
    return answer({
      ok: true,
      summary: `成图 ${args.result.toUpperCase()}，${result.width}×${result.height}。`,
      images: [await context.readAsset(result.assetId)]
    })
  }
})
