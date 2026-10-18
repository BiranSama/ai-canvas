import { z } from 'zod'
import { elementFacts } from './geometry'
import { answer, defineTool } from './types'

export const inspectTool = defineTool({
  name: 'inspect',
  title: '查看对象',
  description: '读取对象的精确属性：位置、字号、颜色、层级等。按比例修改（如「缩小 20%」）前先用它拿到真实数值。',
  parameters: z.object({
    targets: z.array(z.string().min(1).max(120)).min(1).max(20).describe('对象编号，如 ["E3", "E5"]')
  }).strict(),
  registryName: 'scene.get_elements',
  describe: (args) => `查看 ${args.targets.join('、')}`,
  prepare(args, context) {
    const lines = args.targets.map((token) => {
      const element = context.refs.resolve(token, context.scene)
      return typeof element === 'string' ? element : elementFacts(element, context.refs, context.scene)
    })
    return answer({ ok: true, summary: `读取了 ${args.targets.length} 个对象`, details: lines })
  }
})
