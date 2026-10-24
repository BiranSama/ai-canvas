import { z } from 'zod'
import { changeLines } from './geometry'
import { defineTool } from './types'

export const undoTool = defineTool({
  name: 'undo',
  title: '撤销',
  description: '撤销本轮最近一次画布修改。改坏了先撤销再换做法，不要叠加修补。',
  parameters: z.object({}).strict(),
  registryName: 'history.undo_batch',
  describe: () => '撤销上一步',
  prepare(_args, context) {
    return {
      kind: 'execute',
      plan: { kind: 'history.undo_batch', expectedSceneRevision: context.scene.revision, batchId: null },
      report: ({ outcome, sceneBefore, sceneAfter }) => {
        if (!outcome.ok) return { ok: false, summary: outcome.message }
        context.refs.sync(sceneAfter)
        const ids = [...new Set([...sceneBefore.elements, ...sceneAfter.elements].map((element) => element.id))]
        return { ok: true, summary: '已撤销上一步', details: changeLines(sceneBefore, sceneAfter, context.refs, ids) }
      }
    }
  }
})
