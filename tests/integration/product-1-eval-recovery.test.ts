import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Scene, SceneElement } from '../../src/domain'
import { GenerationRuntime } from '../../src/main/generation/generation-runtime'
import type { AgentRequest, SceneSummary } from '../../src/shared/agent'
import type { AgentTurnStatus } from '../../src/shared/agent-harness'
import type { GenerationJob, GenerationRequest } from '../../src/shared/generation'
import { makeText } from '../fixtures/scene-fixtures'

const roots: string[] = []
const runtimes: GenerationRuntime[] = []

function summarize(scene: Scene): SceneSummary {
  return {
    revision: scene.revision,
    canvas: {
      aspectWidth: scene.canvas.aspectWidth,
      aspectHeight: scene.canvas.aspectHeight,
      outputWidth: scene.canvas.outputWidth,
      outputHeight: scene.canvas.outputHeight,
      globalStyle: scene.canvas.globalStyle
    },
    elementCount: scene.elements.length,
    elements: scene.elements.map((element) => ({
      id: element.id,
      type: element.type,
      name: element.name,
      description: element.description,
      semanticRole: element.semanticRole,
      groupId: element.groupId,
      locked: element.locked,
      visible: element.visible,
      transform: element.transform
    }))
  }
}

function agentRequest(scene: Scene, text: string, selected: readonly SceneElement[]): AgentRequest {
  return {
    text,
    sceneSummary: summarize(scene),
    selectedIds: selected.map((element) => element.id),
    selectedElements: [...selected],
    attachments: selected.map((element) => ({ kind: 'selection', id: element.id, name: element.name })),
    autoGenerate: false,
    ephemeralAnnotation: null,
    activeGenerationJobId: null
  }
}

function generationRequest(): GenerationRequest {
  return {
    prompt: 'Local recovery proof: quiet pearl editorial composition with restrained blue light',
    negativePrompt: '',
    aspectWidth: 4,
    aspectHeight: 5,
    outputWidth: 320,
    outputHeight: 400,
    count: 1,
    providerId: 'mock',
    model: 'mock-balanced',
    references: [],
    parameters: { eval: 'EVAL-10' },
    sourceMessageId: null,
    parentResultId: null,
    referenceMode: 'hybrid',
    variationInstruction: '',
    preserveConstraints: '保留 4:5、标题留白与蓝色背光意图'
  }
}

async function waitForCompletedJob(runtime: GenerationRuntime, jobId: string): Promise<GenerationJob> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const job = (await runtime.listJobs()).find((candidate) => candidate.id === jobId)
    if (job?.status === 'completed') return job
    if (job !== undefined && ['failed', 'cancelled', 'timed_out', 'interrupted'].includes(job.status)) {
      throw new Error(`EVAL-10 local generation ended as ${job.status}: ${job.error?.message ?? ''}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('EVAL-10 local generation did not complete in time.')
}

async function waitForTurnStatus(
  runtime: GenerationRuntime,
  turnId: string,
  statuses: readonly AgentTurnStatus[]
): Promise<AgentTurnStatus> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const turn = (await runtime.getAgentHarnessSnapshot()).turns.find((candidate) => candidate.id === turnId)
    if (turn !== undefined && statuses.includes(turn.status)) return turn.status
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`EVAL-10 Agent turn ${turnId} did not reach ${statuses.join(', ')}.`)
}

async function waitForWaitingDecision(runtime: GenerationRuntime): Promise<{
  readonly turnId: string
  readonly decisionId: string
}> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const snapshot = await runtime.getAgentHarnessSnapshot()
    const turn = snapshot.turns.find((candidate) => candidate.status === 'waiting_decision')
    const decision = turn === undefined
      ? undefined
      : snapshot.items.find((item) => item.turnId === turn.id && item.type === 'decision' && item.status === 'waiting')
    if (turn !== undefined && decision !== undefined) return { turnId: turn.id, decisionId: decision.id }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('EVAL-10 Agent did not expose a persistent waiting decision.')
}

afterEach(async () => {
  while (runtimes.length > 0) await runtimes.pop()?.close().catch(() => undefined)
  while (roots.length > 0) {
    const root = roots.pop()
    if (root !== undefined) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

describe('Product 1.0 EVAL-10 project recovery', () => {
  it('reopens one project with Scene, undo, result lineage, project knowledge and the same waiting Agent decision', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ai-canvas-product-1-eval-10-'))
    roots.push(root)
    const userData = join(root, 'user-data')
    const first = await GenerationRuntime.create(userData)
    runtimes.push(first)
    await first.createProjectInLibrary('EVAL-10 恢复作品')

    const initial = first.getWorkspaceBootstrap()
    const title = { ...makeText(), id: randomUUID(), content: 'MORNING RITUAL', name: '可恢复标题' }
    const sceneMutation = await first.executeSceneCommands({
      expectedSceneRevision: initial.scene.revision,
      batch: {
        id: randomUUID(),
        origin: 'user',
        summary: 'EVAL-10 建立可恢复 4:5 标题场景',
        commands: [
          {
            kind: 'scene.set-canvas',
            canvas: {
              ...initial.scene.canvas,
              aspectWidth: 4,
              aspectHeight: 5,
              outputWidth: 1024,
              outputHeight: 1280,
              globalStyle: '珍珠白、克制蓝色背光、疏朗编辑感'
            }
          },
          { kind: 'element.add', element: title }
        ]
      }
    })
    expect(sceneMutation.ok).toBe(true)

    const completedJob = await waitForCompletedJob(first, (await first.enqueue(generationRequest())).id)
    const result = completedJob.results[0]
    expect(result).toBeDefined()
    const placementId = randomUUID()
    const placement = await first.placeGenerationResult({ resultId: result!.id, placementId, origin: 'user' })
    await first.setGenerationResultFavorite({ resultId: result!.id, favorite: true })

    await first.createProjectDirective({
      text: '文字保持轻盈疏朗，蓝色背光作为保留项。',
      category: 'creative',
      priority: 160,
      sourceMessageId: null
    })
    await first.createProjectMemory({
      kind: 'constraint',
      content: '用户确认保留 4:5 与蓝色背光。',
      sourceType: 'user',
      sourceId: 'eval-10-user-confirmation',
      confidence: 1,
      supersedesId: null
    })

    const beforeWaiting = first.getWorkspaceBootstrap()
    const selectedTitle = beforeWaiting.scene.elements.find((element) => element.id === title.id)
    expect(selectedTitle).toBeDefined()
    const run = await first.startAgentRun(
      agentRequest(beforeWaiting.scene, '标题再疏一点并略微下移，保留 4:5 和蓝色背光。', [selectedTitle!]),
      'review'
    )
    const waiting = await waitForWaitingDecision(first)
    await waitForTurnStatus(first, waiting.turnId, ['waiting_decision'])
    const beforeRestart = await first.getAgentHarnessSnapshot()
    const waitingTurn = beforeRestart.turns.find((turn) => turn.id === waiting.turnId)
    const waitingDecision = beforeRestart.items.find((item) => item.id === waiting.decisionId)
    expect(waitingTurn).toBeDefined()
    expect(waitingDecision).toBeDefined()
    expect(beforeRestart.activeGoal?.budget.maxCostCny).toBe(0)

    await first.close()
    runtimes.pop()

    const reopened = await GenerationRuntime.create(userData)
    runtimes.push(reopened)
    const bootstrap = reopened.getWorkspaceBootstrap()
    const jobs = await reopened.listJobs()
    const restoredJob = jobs.find((job) => job.id === completedJob.id)
    const restoredHarness = await reopened.getAgentHarnessSnapshot()
    const restoredKnowledge = await reopened.getProjectKnowledge()
    const restoredConversation = await reopened.getConversation()
    const families = await reopened.resultFamilies()

    expect(bootstrap).toMatchObject({
      projectId: initial.projectId,
      projectName: 'EVAL-10 恢复作品',
      canUndo: true,
      scene: {
        canvas: { aspectWidth: 4, aspectHeight: 5, outputWidth: 1024, outputHeight: 1280 },
        elements: expect.arrayContaining([
          expect.objectContaining({ id: title.id, type: 'text', content: 'MORNING RITUAL' }),
          expect.objectContaining({ id: placementId, type: 'image', assetId: result!.assetId })
        ])
      }
    })
    expect(restoredJob).toMatchObject({
      id: completedJob.id,
      status: 'completed',
      providerId: 'mock',
      model: 'mock-balanced',
      results: [expect.objectContaining({ id: result!.id, assetId: result!.assetId, favorite: true })]
    })
    expect(jobs.map((job) => job.id)).toEqual([completedJob.id])
    expect(families).toEqual(expect.arrayContaining([
      expect.objectContaining({
        rootResultId: result!.id,
        favoriteResultIds: [result!.id],
        members: [expect.objectContaining({ resultId: result!.id, favorite: true })]
      })
    ]))
    expect(restoredHarness.thread.activeTurnId).toBe(waitingTurn!.id)
    expect(restoredHarness.turns.find((turn) => turn.id === waitingTurn!.id)).toMatchObject({ status: 'waiting_decision' })
    expect(restoredHarness.items.find((item) => item.id === waitingDecision!.id)).toMatchObject({ status: 'waiting', type: 'decision' })
    expect(restoredHarness.activeGoal).toMatchObject({ mode: 'review', budget: { maxCostCny: 0 } })
    expect(restoredKnowledge.directives).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: '文字保持轻盈疏朗，蓝色背光作为保留项。', enabled: true })
    ]))
    expect(restoredKnowledge.memories).toEqual(expect.arrayContaining([
      expect.objectContaining({ content: '用户确认保留 4:5 与蓝色背光。', status: 'active' })
    ]))
    expect(restoredKnowledge.outboundRecords).toEqual([])
    expect(restoredConversation.activities).toEqual(expect.arrayContaining([
      expect.objectContaining({ jobId: completedJob.id, state: 'completed' }),
      expect.objectContaining({ runId: run.id, state: 'waiting' })
    ]))
    expect(placement.batchId).toBe(placementId)
  })
})
