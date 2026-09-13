import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GenerationRuntime } from '../../src/main/generation/generation-runtime'
import type { AgentRequest } from '../../src/shared/agent'

const roots: string[] = []

async function waitForAgent(runtime: GenerationRuntime, priorTurnIds: ReadonlySet<string> = new Set()): Promise<void> {
  const deadline = Date.now() + 8_000
  let latestSnapshot = await runtime.getAgentHarnessSnapshot()
  while (Date.now() < deadline) {
    latestSnapshot = await runtime.getAgentHarnessSnapshot()
    const latest = latestSnapshot.turns.find((turn) => !priorTurnIds.has(turn.id))
    if (latest?.status === 'failed') {
      throw new Error(`Agent turn failed: ${latest.errorCode}: ${latest.errorMessage}`)
    }
    if (latest !== undefined && ['completed', 'completed_with_notes', 'needs_user_review'].includes(latest.status)) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`Agent generation turn did not become terminal: ${JSON.stringify({
    turns: latestSnapshot.turns,
    items: latestSnapshot.items.map((item) => ({ type: item.type, status: item.status, payload: item.payload }))
  })}`)
}

afterEach(async () => {
  vi.unstubAllGlobals()
  while (roots.length > 0) {
    const root = roots.pop()
    if (root !== undefined) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

describe('AH1 S7 production Mock generation workflow', () => {
  it('records the compiled outbound scope, waits for the Job, and finishes with zero network', async () => {
    const fetcher = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetcher)
    const root = await mkdtemp(join(tmpdir(), 'ai-canvas-ah1-generation-agent-runtime-'))
    roots.push(root)
    const runtime = await GenerationRuntime.create(root)
    const scene = runtime.getWorkspaceBootstrap().scene
    const request: AgentRequest = {
      text: '直接生成一张 4:5 的山海封面，标题“山海之间”，冷白雾气与克制留白。',
      sceneSummary: {
        revision: scene.revision,
        canvas: {
          aspectWidth: scene.canvas.aspectWidth,
          aspectHeight: scene.canvas.aspectHeight,
          outputWidth: scene.canvas.outputWidth,
          outputHeight: scene.canvas.outputHeight,
          globalStyle: scene.canvas.globalStyle
        },
        elementCount: 0,
        elements: []
      },
      selectedIds: [],
      selectedElements: [],
      attachments: [],
      ephemeralAnnotation: null,
      autoGenerate: false,
      activeGenerationJobId: null
    }

    await runtime.startAgentRun(request, 'auto')
    await waitForAgent(runtime)
    const [harness, knowledge, jobs, families] = await Promise.all([
      runtime.getAgentHarnessSnapshot(),
      runtime.getProjectKnowledge(),
      runtime.listJobs(),
      runtime.resultFamilies()
    ])
    expect(harness.turns[0]?.errorMessage).toBeNull()
    expect(harness.turns[0]).toMatchObject({ status: 'completed', toolCallsUsed: 1, sceneWriteBatchesUsed: 0 })
    expect(harness.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'generation_subscription', status: 'completed' })
    ]))
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({ status: 'completed', providerId: 'mock', request: { parameters: { workflowIntentId: expect.any(String) } } })
    expect(families).toHaveLength(1)
    expect(knowledge.outboundRecords).toEqual([
      expect.objectContaining({
        providerId: 'mock',
        policy: 'minimal',
        status: 'prepared',
        dataTypes: ['user_text', 'prompt_package'],
        imageAssetIds: [],
        imageCount: 0,
        imageBytes: 0,
        approvalId: null,
        requestCorrelationId: expect.any(String),
        reason: expect.stringContaining('text data is prepared')
      })
    ])

    const beforePlacement = new Set(harness.turns.map((turn) => turn.id))
    await runtime.startAgentRun({ ...request, text: '把最近的生成结果放到画布里。' }, 'auto')
    await waitForAgent(runtime, beforePlacement)
    const placedScene = runtime.getWorkspaceBootstrap().scene
    if (placedScene.elements.length === 0) {
      const debug = await runtime.getAgentHarnessSnapshot()
      throw new Error(`Placement produced no element: ${JSON.stringify(debug.items.slice(-8))}`)
    }
    expect(placedScene.elements).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'image', assetId: jobs[0]!.results[0]!.assetId, provenance: expect.objectContaining({ origin: 'mock-generated' }) })
    ]))

    const beforeDirective = new Set((await runtime.getAgentHarnessSnapshot()).turns.map((turn) => turn.id))
    await runtime.startAgentRun({ ...request, text: '记住：这个项目始终使用克制的冷白留白。' }, 'auto')
    await waitForAgent(runtime, beforeDirective)
    expect((await runtime.getProjectKnowledge()).directives).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: '记住：这个项目始终使用克制的冷白留白。', category: 'creative', enabled: true })
    ]))
    expect(fetcher).not.toHaveBeenCalled()
    await runtime.close()
  })
})
