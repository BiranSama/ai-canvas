import { z } from 'zod'
import { defineTool } from './types'

export const askUserTool = defineTool({
  name: 'ask_user',
  title: '询问',
  description: '真的拿不准、而且猜错代价大时才问（比如要不要花钱、两种方向差别很大）。给 2–4 个选项并推荐一个。能做合理假设时直接做，并在汇报里说明假设。',
  parameters: z.object({
    question: z.string().min(1).max(300),
    options: z.array(z.string().min(1).max(80)).min(2).max(4),
    recommended: z.number().int().min(0).max(3).describe('推荐选项的序号，从 0 开始')
  }).strict(),
  registryName: 'project.get_context',
  describe: (args) => args.question,
  prepare(args) {
    return {
      kind: 'ask',
      question: args.question,
      options: args.options,
      recommended: Math.min(args.recommended, args.options.length - 1)
    }
  }
})
