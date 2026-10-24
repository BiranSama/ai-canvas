import { randomUUID } from 'node:crypto'
import type { Scene } from '../../../domain'
import type { AgentModelEvalLayoutScore } from '../../../shared/agent-eval'
import { buildDesignContract, CompletionAssessor } from '../design-capability'
import { summarizeScene } from './scene-facts'

/**
 * Auxiliary score from the existing ten-dimension design rubric, computed from
 * the final Scene and its own Creative Brief. It is reported next to the
 * result and never decides pass or fail.
 */
export function auxiliaryLayoutScore(scene: Scene, requestText: string): AgentModelEvalLayoutScore | null {
  const brief = scene.creativeContext?.brief ?? null
  if (brief === null || (brief.version !== 2 && brief.version !== 3)) return null
  try {
    const assessment = new CompletionAssessor().assess({
      request: {
        text: requestText,
        sceneSummary: summarizeScene(scene),
        selectedIds: [],
        selectedElements: [],
        attachments: [],
        ephemeralAnnotation: null,
        autoGenerate: false,
        activeGenerationJobId: null
      },
      plan: { summary: '评测辅助评分', response: '评测辅助评分', nextAction: null, tools: [], designContract: buildDesignContract(brief, randomUUID) },
      localRefineCount: 1
    })
    if (assessment === null) return null
    return {
      total: assessment.design.total,
      max: 40,
      dimensions: Object.fromEntries(assessment.design.entries.map((entry) => [entry.dimension, entry.score]))
    }
  } catch {
    return null
  }
}
