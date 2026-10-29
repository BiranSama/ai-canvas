import { z } from 'zod'
import { defineTool } from './types'

export const askUserTool = defineTool({
  name: 'ask_user',
  title: '询问',
  description: '只在用户的话有两种差别很大的理解、猜错就要推倒重来时才问。用户说过的比例、文字、主体、颜色、风格都已确定，不要再问；没说的按常识补全并在汇报里说明。缺少要印在画面上的内容（日期、价格）时先用占位文字做出来，不要只问不做。给 2–4 个选项并推荐一个。',
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
