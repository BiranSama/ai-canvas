import { z } from 'zod'
import { sceneWrite } from './scene-write'
import { defineTool, rejected, resolveTargets } from './types'

export const reorderTool = defineTool({
  name: 'reorder',
  title: '调整层级',
  description: '把一个对象移到最上层、最下层、上移或下移一层，或放到另一个对象的上面或下面。',
  parameters: z.object({
    target: z.string().min(1).max(120),
    to: z.enum(['front', 'back', 'forward', 'backward', 'above', 'below']).describe('front 最上层，back 最下层，forward 上移一层，backward 下移一层，above/below 相对 reference'),
    reference: z.string().min(1).max(120).optional().describe('to 为 above 或 below 时的参照对象')
  }).strict(),
  registryName: 'scene.reorder_elements',
  describe: (args) => `调整 ${args.target} 的层级`,
  prepare(args, context) {
    const targets = resolveTargets([args.target], context)
    if (typeof targets === 'string') return rejected(targets)
    const element = targets[0]!
    const count = context.scene.elements.length
    const from = context.scene.elements.indexOf(element)
    let toIndex: number
    if (args.to === 'front') toIndex = count - 1
    else if (args.to === 'back') toIndex = 0
    else if (args.to === 'forward') toIndex = Math.min(count - 1, from + 1)
    else if (args.to === 'backward') toIndex = Math.max(0, from - 1)
    else {
      if (args.reference === undefined) return rejected('above 和 below 需要 reference。')
      const reference = context.refs.resolve(args.reference, context.scene)
      if (typeof reference === 'string') return rejected(reference)
      if (reference.id === element.id) return rejected('参照对象不能是它自己。')
      const at = context.scene.elements.indexOf(reference)
      // Indexes are taken after the moved element leaves its slot.
      toIndex = args.to === 'above' ? (from < at ? at : at + 1) : (from < at ? at - 1 : at)
    }
    if (toIndex === from) return rejected(`${context.refs.ref(element.id)} 已经在这个层级。`)
    return sceneWrite({
      kind: 'scene.reorder_elements',
      expectedSceneRevision: context.scene.revision,
      summary: '调整层级',
      moves: [{ elementId: element.id, toIndex }]
    }, context, `已调整 ${context.refs.ref(element.id)} 的层级`, [element.id])
  }
})
