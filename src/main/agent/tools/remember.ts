import { z } from 'zod'
import { jobStep } from './generation-report'
import { defineTool } from './types'

export const rememberTool = defineTool({
  name: 'remember',
  title: '记下',
  description: '用户说「记住」「以后都」时，提议一条项目规则（rule，以后每次都遵守）或一条偏好（preference，作参考）。用户确认后才生效。',
  parameters: z.object({
    content: z.string().min(1).max(1_000).describe('要记下的内容，写成一句完整的话'),
    kind: z.enum(['rule', 'preference']),
    scope: z.enum(['project', 'all']).optional().describe('all：以后所有作品都这样，记成用户偏好')
  }).strict(),
  registryName: 'memory.propose_candidate',
  describe: (args) => `提议${args.scope === 'all' ? '所有作品的偏好' : args.kind === 'rule' ? '规则' : '偏好'}「${args.content.slice(0, 30)}」`,
  prepare(args, context) {
    // Rules stay in the project; what holds for every project is a preference the person confirms.
    if (args.scope === 'all') {
      return jobStep({ kind: 'memory_candidate', memoryKind: 'direction', content: args.content, confidence: 0.8, scope: 'all' }, context, '已提议一条所有作品共用的偏好，等用户确认后生效')
    }
    return args.kind === 'rule'
      ? jobStep({ kind: 'directive_create', category: 'creative', text: args.content, priority: 100 }, context, '已提议一条项目规则，等用户确认后生效')
      : jobStep({ kind: 'memory_candidate', memoryKind: 'direction', content: args.content, confidence: 0.8 }, context, '已提议一条偏好，等用户确认后生效')
  }
})
