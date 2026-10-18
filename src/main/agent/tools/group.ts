import { z } from 'zod'
import { boundsOf } from './geometry'
import { elementBase, sceneWrite } from './scene-write'
import { defineTool, rejected, resolveTargets } from './types'

export const groupTool = defineTool({
  name: 'group',
  title: '编组',
  description: '把几个对象编成一组，便于整体移动；组内对象仍可单独修改。',
  parameters: z.object({
    targets: z.array(z.string().min(1).max(120)).min(2).max(50),
    name: z.string().min(1).max(60).describe('组名，如「标题组」')
  }).strict(),
  registryName: 'scene.group_elements',
  describe: (args) => `把 ${args.targets.join('、')} 编为「${args.name}」`,
  prepare(args, context) {
    const targets = resolveTargets(args.targets, context)
    if (typeof targets === 'string') return rejected(targets)
    const grouped = targets.find((element) => element.groupId !== null)
    if (grouped !== undefined) return rejected(`${context.refs.ref(grouped.id)} 已经在另一个组里。`)
    const group = {
      ...elementBase(context, { name: args.name, transform: boundsOf(targets), role: 'group' }),
      type: 'group' as const,
      childIds: targets.map((element) => element.id)
    }
    return sceneWrite({
      kind: 'scene.group_elements',
      expectedSceneRevision: context.scene.revision,
      summary: `编组「${args.name}」`,
      group,
      elementIds: group.childIds
    }, context, `已编组「${args.name}」`, [group.id])
  }
})
