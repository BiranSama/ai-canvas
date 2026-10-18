import { z } from 'zod'
import type { SceneElement } from '../../../domain'
import { elementFacts, percentBoxSchema } from './geometry'
import { answer, defineTool, rejected, type AgentToolContext, type AgentToolResult } from './types'

function overlapRatio(left: SceneElement, right: SceneElement): number {
  const a = left.transform
  const b = right.transform
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  if (width <= 0 || height <= 0) return 0
  return width * height / Math.min(a.width * a.height, b.width * b.height)
}

/** For models that cannot see images: the layout in words, with overlaps that involve text. */
function describeLayout(context: AgentToolContext): AgentToolResult {
  const visible = context.scene.elements.filter((element) => element.visible && element.type !== 'group')
  const overlaps = visible.flatMap((element, index) => visible.slice(index + 1).flatMap((other) => {
    if (element.type !== 'text' && other.type !== 'text') return []
    const ratio = overlapRatio(element, other)
    return ratio > 0.05 ? [`${context.refs.ref(element.id)} 和 ${context.refs.ref(other.id)} 重叠约 ${Math.round(ratio * 100)}%`] : []
  }))
  const margin = visible.filter((element) => element.type === 'text' && (element.transform.x < 0.05 || element.transform.y < 0.05
    || element.transform.x + element.transform.width > 0.95 || element.transform.y + element.transform.height > 0.95))
  return {
    ok: true,
    summary: '当前文字模型不能看图，这是画面的文字描述。',
    details: [
      ...visible.map((element) => elementFacts(element, context.refs, context.scene)),
      ...(overlaps.length === 0 ? ['文字没有和其他对象明显重叠。'] : overlaps),
      ...margin.map((element) => `${context.refs.ref(element.id)} 离画布边缘不到 5%`)
    ]
  }
}

/** Asked once per turn under the per-image review policy, before the first screenshot leaves. */
export const SCREENSHOT_QUESTION = '要把画面截图发给文字模型吗？截图会发往外部服务，这一轮内不再重复询问。'

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
    if (context.vision === false) return answer(describeLayout(context))
    if (context.screenshots === 'ask') {
      return { kind: 'ask', question: SCREENSHOT_QUESTION, options: ['发送截图', '不发送，只用文字描述'], recommended: 0 }
    }
    if (context.screenshots === 'declined') {
      const described = describeLayout(context)
      return answer({ ...described, summary: '用户这一轮不发送截图，这是画面的文字描述。' })
    }
    if (context.looker === undefined || context.looker === null) return rejected('当前无法渲染画面。', '用 inspect 读取对象属性代替。')
    const image = await context.looker.look(context.scene, { region: args.region ?? null, mode: args.mode })
    return answer({
      ok: true,
      summary: args.mode === 'reference' ? '这是生图时会发给生图模型的参考图。' : args.region === undefined ? '这是当前整张画面。' : '这是画面的局部放大。',
      images: [image]
    })
  }
})
