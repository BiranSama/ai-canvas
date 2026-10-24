import { z } from 'zod'
import { sceneWrite } from './scene-write'
import { defineTool, rejected, resolveTargets } from './types'

export const removeTool = defineTool({
  name: 'remove',
  title: '删除对象',
  description: '删除对象（可撤销）。只删被要求删的。',
  parameters: z.object({ targets: z.array(z.string().min(1).max(120)).min(1).max(50) }).strict(),
  registryName: 'scene.remove_elements',
  describe: (args) => `删除 ${args.targets.join('、')}`,
  prepare(args, context) {
    const targets = resolveTargets(args.targets, context)
    if (typeof targets === 'string') return rejected(targets)
    return sceneWrite({
      kind: 'scene.remove_elements',
      expectedSceneRevision: context.scene.revision,
      summary: `删除 ${targets.length} 个对象`,
      elementIds: targets.map((element) => element.id)
    }, context, `已删除 ${targets.map((element) => `${context.refs.ref(element.id)}「${element.name}」`).join('、')}`, targets.map((element) => element.id))
  }
})
