import { z } from 'zod'
import type { Scene, SceneElement } from '../../../domain'
import { boundsOf, elementFacts, percentBoxSchema, type PercentBox } from './geometry'
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

/**
 * One layer on its own, shown even when hidden: a group brings its members
 * and a mask the element it applies to, on a transparent canvas.
 */
function isolate(scene: Scene, root: SceneElement): { readonly scene: Scene; readonly members: readonly SceneElement[] } {
  const ids = new Set([root.id])
  if (root.type === 'mask') ids.add(root.targetElementId)
  for (let grew = true; grew;) {
    grew = false
    for (const element of scene.elements) {
      if (!ids.has(element.id) && element.groupId !== null && ids.has(element.groupId)) {
        ids.add(element.id)
        grew = true
      }
    }
  }
  const elements = scene.elements.filter((element) => ids.has(element.id)).map((element, index) => ({
    ...element,
    zIndex: index,
    visible: true,
    groupId: element.groupId !== null && ids.has(element.groupId) ? element.groupId : null,
    ...(element.type === 'light' ? { targetElementIds: element.targetElementIds.filter((id) => ids.has(id)) } : {})
  }) as SceneElement)
  return {
    scene: { ...scene, canvas: { ...scene.canvas, transparent: true }, elements, relations: [] },
    members: elements.filter((element) => element.type !== 'group')
  }
}

const TARGET_MARGIN = 0.03

/** The members' bounds with a little room around them, inside the canvas; null when nothing of them is on it. */
function targetRegion(members: readonly SceneElement[]): PercentBox | null {
  if (members.length === 0) return null
  const bounds = boundsOf(members)
  const left = Math.max(0, bounds.x - TARGET_MARGIN)
  const top = Math.max(0, bounds.y - TARGET_MARGIN)
  const right = Math.min(1, bounds.x + bounds.width + TARGET_MARGIN)
  const bottom = Math.min(1, bounds.y + bounds.height + TARGET_MARGIN)
  if (right - left <= 0.001 || bottom - top <= 0.001) return null
  return [left * 100, top * 100, (right - left) * 100, (bottom - top) * 100]
}

/** Asked once per turn under the per-image review policy, before the first screenshot leaves. */
export const SCREENSHOT_QUESTION = '要把画面截图发给文字模型吗？截图会发往外部服务，这一轮内不再重复询问。'

export const lookTool = defineTool({
  name: 'look',
  title: '看画面',
  description: '看当前画面的截图。「画面」模式显示真实文字和各对象的标记；「参考图」模式显示生图时会发给生图模型的合成图。填 target 时只看那一个对象（组会带上组里的对象），隐藏的也能看，它单独显示在灰白格子底上。动手前后各看一次即可，不要每步都看。',
  parameters: z.object({
    region: percentBoxSchema.optional().describe('只看画布的一块区域，[x, y, 宽, 高] 百分比；不填看整张'),
    target: z.string().min(1).max(80).optional().describe('只看这一个对象，编号或名字，如 "E3"；和 region 二选一'),
    mode: z.enum(['canvas', 'reference']).default('canvas').describe('canvas=画面，reference=参考图')
  }).strict(),
  registryName: 'scene.render_preview',
  available: (context) => context.looker !== undefined && context.looker !== null,
  describe: (args) => args.target !== undefined ? `查看对象 ${args.target}`
    : args.mode === 'reference' ? '查看生图参考图' : args.region === undefined ? '查看画面' : '查看画面局部',
  async prepare(args, context) {
    if (args.target !== undefined && args.region !== undefined) return rejected('target 和 region 只能填一个。')
    const element = args.target === undefined ? null : context.refs.resolve(args.target, context.scene)
    if (typeof element === 'string') return rejected(element)
    const isolated = element === null ? null : isolate(context.scene, element)
    const region = isolated === null ? args.region ?? null : targetRegion(isolated.members)
    if (isolated !== null && region === null) return rejected(`${context.refs.ref(element!.id)} 不在画布范围内，看不到。`, '用 inspect 读它的位置，需要时先移回画布。')
    const describeTarget = (summary: string): AgentToolResult => ({
      ok: true,
      summary,
      // The scene's own elements, so layer order and hidden state read as they are.
      details: context.scene.elements.filter((candidate) => isolated!.members.some((member) => member.id === candidate.id))
        .map((member) => elementFacts(member, context.refs, context.scene))
    })
    if (context.vision === false) {
      return answer(isolated === null ? describeLayout(context) : describeTarget('当前文字模型不能看图，这是这个对象的文字描述。'))
    }
    if (context.screenshots === 'ask') {
      return { kind: 'ask', question: SCREENSHOT_QUESTION, options: ['发送截图', '不发送，只用文字描述'], recommended: 0 }
    }
    if (context.screenshots === 'declined') {
      if (isolated !== null) return answer(describeTarget('用户这一轮不发送截图，这是这个对象的文字描述。'))
      const described = describeLayout(context)
      return answer({ ...described, summary: '用户这一轮不发送截图，这是画面的文字描述。' })
    }
    if (context.looker === undefined || context.looker === null) return rejected('当前无法渲染画面。', '用 inspect 读取对象属性代替。')
    const image = await context.looker.look(isolated?.scene ?? context.scene, {
      region,
      mode: args.mode,
      ...(isolated === null ? {} : { background: 'checker' as const })
    })
    const hidden = element !== null && !element.visible
    return answer({
      ok: true,
      summary: isolated !== null
        ? `这是 ${context.refs.ref(element!.id)} 单独的样子${hidden ? '（它在画布上是隐藏的，不出现在画面和生图参考里）' : ''}，灰白格子是透明处。`
        : args.mode === 'reference' ? '这是生图时会发给生图模型的参考图。' : args.region === undefined ? '这是当前整张画面。' : '这是画面的局部放大。',
      images: [image]
    })
  }
})
