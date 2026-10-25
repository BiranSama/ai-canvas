import { z } from 'zod'
import { answer, defineTool, rejected } from './types'

export const loadManualTool = defineTool({
  name: 'load_manual',
  title: '读手册',
  description: '加载一份专题手册（版式、配色、中文排版、生图提示词写法等），系统提示里列了可用的手册名。拿不准做法时再读。',
  parameters: z.object({ topic: z.string().min(1).max(80).describe('手册名') }).strict(),
  registryName: 'capability.load',
  available: (context) => (context.manuals?.list().length ?? 0) > 0,
  describe: (args, context) => `读手册「${context.manuals?.list().find((manual) => manual.id === args.topic)?.title ?? args.topic}」`,
  prepare(args, context) {
    const manuals = context.manuals
    if (manuals === undefined || manuals === null) return rejected('当前没有可用的手册。')
    const text = manuals.load(args.topic)
    if (text === null) {
      return rejected(`没有手册「${args.topic}」。`, `可用的手册：${manuals.list().map((manual) => manual.id).join('、')}`)
    }
    // Manuals are longer than ordinary results; they are the point of the call.
    return answer({ ok: true, summary: `手册「${args.topic}」：\n${text}`, maxChars: 8_000 })
  }
})
