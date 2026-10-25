import { z } from 'zod'
import { jobStep } from './generation-report'
import { defineTool, rejected } from './types'

export const cancelGenerationTool = defineTool({
  name: 'cancel_generation',
  title: '停止生成',
  description: '停止正在进行的生成任务。',
  parameters: z.object({}).strict(),
  registryName: 'generation.cancel_job',
  available: (context) => context.activeJobId !== null,
  describe: () => '停止生成',
  prepare(_args, context) {
    if (context.activeJobId === null) return rejected('当前没有进行中的生成任务。')
    return jobStep({ kind: 'cancel_generation', jobId: context.activeJobId }, context, '已停止生成任务')
  }
})
