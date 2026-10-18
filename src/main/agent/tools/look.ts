import { z } from 'zod'
import { percentBoxSchema } from './geometry'
import { answer, defineTool, rejected } from './types'

export const lookTool = defineTool({
  name: 'look',
  title: '看画面',
  description: '看当前画面的截图。「画面」模式显示真实文字和各对象的标记；「参考图」模式显示生图时会发给生图模型的合成图。动手前后各看一次即可，不要每步都看。',
  parameters: z.object({
    region: percentBoxSchema.optional().describe('只看画布的一块区域，[x, y, 宽, 高] 百分比；不填看整张'),
    mode: z.enum(['canvas', 'reference']).default('canvas').describe('canvas=画面，reference=参考图')
  }).strict(),
  registryName: 'scene.render_preview',
  available: (context) => context.looker !== undefined && context.looker !== null,
  describe: (args) => args.mode === 'reference' ? '查看生图参考图' : args.region === undefined ? '查看画面' : '查看画面局部',
  async prepare(args, context) {
    if (context.looker === undefined || context.looker === null) return rejected('当前无法渲染画面。', '用 inspect 读取对象属性代替。')
    const image = await context.looker.look(context.scene, { region: args.region ?? null, mode: args.mode })
    return answer({
      ok: true,
      summary: args.mode === 'reference' ? '这是生图时会发给生图模型的参考图。' : args.region === undefined ? '这是当前整张画面。' : '这是画面的局部放大。',
      images: [image]
    })
  }
})
