import { describe, expect, it } from 'vitest'
import { CommandBus, createScene, type Scene, type SceneCommand } from '../../src/domain'
import { agentRequestSchema, agentToolPlanSchema, type AgentToolPlan } from '../../src/shared/agent'
import { agentTurnSchema } from '../../src/shared/agent-harness'
import { brandBriefLines, logoPlacement } from '../../src/shared/user-memory'
import { compileAtomicSceneCommands, isAtomicSceneWriteTool } from '../../src/main/agent/atomic-scene-tools'
import { availableAgentTools, llmToolDefinitions, AGENT_TOOLS, prepareAgentToolCall } from '../../src/main/agent/tools/catalogue'
import { colorSchema } from '../../src/main/agent/tools/geometry'
import { ElementRefs } from '../../src/main/agent/tools/refs'
import type { AgentToolContext, AgentToolResult } from '../../src/main/agent/tools/types'
import { ContextBuilder, plannerProjectContext } from '../../src/main/agent/context-builder'
import { multiStepTurnBrief } from '../../src/main/agent/multi-step/prompt'
import { contextManifestSchema } from '../../src/shared/agent-context'

const NOW = '2026-11-14T00:00:00.000Z'
const LOGO_ASSET = '00000000-0000-4000-8000-0000000009aa'

function ids(start = 1): () => string {
  let next = start
  return () => `00000000-0000-4000-8000-${String(next++).padStart(12, '0')}`
}

class Harness {
  scene: Scene = createScene({ id: ids(1)(), projectId: '00000000-0000-4000-8000-000000000002', now: NOW })
  readonly newId = ids(100)
  readonly refs = ElementRefs.fromScene(this.scene)
  extra: Partial<AgentToolContext> = {}

  context(): AgentToolContext {
    return { scene: this.scene, refs: this.refs, newId: this.newId, results: [], generation: null, activeJobId: null, sourceMessageId: 'm1', userText: '', ...this.extra }
  }

  async call(name: string, args: unknown): Promise<{ result: AgentToolResult | null; plan: AgentToolPlan | null }> {
    const { step } = await prepareAgentToolCall({ callId: 'c', name, argumentsText: JSON.stringify(args), arguments: args as Record<string, unknown>, argumentsError: null }, this.context())
    if (step.kind === 'answer') return { result: step.result, plan: null }
    if (step.kind === 'ask') return { result: null, plan: null }
    const plan = agentToolPlanSchema.parse(step.plan)
    const commands: SceneCommand[] | null = plan.kind === 'scene_batch' ? plan.commands : isAtomicSceneWriteTool(plan) ? compileAtomicSceneCommands(plan) : null
    if (commands === null) return { result: null, plan }
    const before = this.scene
    const executed = new CommandBus(before, { now: () => NOW }).execute({ id: this.newId(), origin: 'agent', summary: 'test', commands })
    if (!executed.ok) throw new Error(JSON.stringify(executed.error))
    this.scene = executed.scene
    return { result: step.report({ outcome: { toolIndex: 0, ok: true, batchId: null, jobId: null, affectedElementIds: [], message: 'ok' }, sceneBefore: before, sceneAfter: executed.scene }), plan }
  }
}

describe('brand tools for the Agent', () => {
  it('places the brand logo as a layer named Logo, keeping its shape inside the box', async () => {
    const harness = new Harness()
    expect(availableAgentTools(harness.context()).map((tool) => tool.name)).not.toContain('place_result')
    harness.extra = { brandLogo: async () => ({ assetId: LOGO_ASSET, width: 400, height: 100 }) }
    expect(availableAgentTools(harness.context()).map((tool) => tool.name)).toContain('place_result')
    const { result } = await harness.call('place_result', { result: 'logo', box: [70, 85, 25, 10] })
    expect(result?.ok).toBe(true)
    const logo = harness.scene.elements.at(-1)!
    expect(logo).toMatchObject({ type: 'image', name: 'Logo', assetId: LOGO_ASSET, fit: 'fill' })
    // 400×100 on a 4:5 canvas fits the box's width: 25% wide, 5% tall, centred in its 10% height.
    expect(logo.transform.x).toBeCloseTo(0.7)
    expect(logo.transform.width).toBeCloseTo(0.25)
    expect(logo.transform.height).toBeCloseTo(0.25 * (100 / 400) * (1200 / 1500))
    expect(logo.transform.y + logo.transform.height / 2).toBeCloseTo(0.9)
  })

  it('says how to get a logo when there is none to place', async () => {
    const harness = new Harness()
    harness.extra = { brandLogo: async () => null }
    const { result } = await harness.call('place_result', { result: 'logo' })
    expect(result).toMatchObject({ ok: false })
    expect(result?.hint).toContain('品牌与记忆')
  })

  it('proposes a preference for every project when the person says so', async () => {
    const harness = new Harness()
    const { plan } = await harness.call('remember', { content: '以后标题都用衬线体', kind: 'preference', scope: 'all' })
    expect(plan).toMatchObject({ kind: 'memory_candidate', scope: 'all', content: '以后标题都用衬线体' })
    const project = await harness.call('remember', { content: '这张用冷色', kind: 'preference' })
    expect(project.plan).toMatchObject({ kind: 'memory_candidate' })
    expect((project.plan as { scope?: string }).scope).toBeUndefined()
  })

  it('flags banned words in text the Agent writes, and not otherwise', async () => {
    const harness = new Harness()
    harness.extra = { bannedWords: ['最', '第一'] }
    const flagged = await harness.call('add_text', { content: '全城最好喝的咖啡', role: 'title' })
    expect(flagged.result?.details?.some((line) => line.includes('禁用词「最」'))).toBe(true)
    const clean = await harness.call('add_text', { content: '每天新鲜烘焙', role: 'subtitle' })
    expect(clean.result?.details?.some((line) => line.includes('禁用词'))).toBe(false)
  })

  it('accepts colours in either case without sending a pattern to the model', () => {
    expect(colorSchema.safeParse('#FFD2A1').success).toBe(true)
    expect(colorSchema.safeParse('#ffd2a1').success).toBe(true)
    expect(colorSchema.safeParse('red').success).toBe(false)
    expect(JSON.stringify(llmToolDefinitions(AGENT_TOOLS as never))).not.toContain('"pattern"')
  })

  it('puts a logo a fifth of the width into the top-left corner by default', () => {
    const placed = logoPlacement(undefined, { width: 200, height: 200 }, { outputWidth: 1000, outputHeight: 1000 })
    expect(placed).toMatchObject({ x: 0.04, y: 0.04, rotation: 0 })
    expect(placed.width).toBeCloseTo(0.2)
    expect(placed.height).toBeCloseTo(0.2)
  })
})

describe('brand and preferences in a turn', () => {
  it('carries the brand and confirmed preferences into the brief as reference', () => {
    const scene = createScene({ id: ids(1)(), projectId: '00000000-0000-4000-8000-000000000002', now: NOW })
    const request = agentRequestSchema.parse({
      text: '做一张新品海报',
      sceneSummary: { revision: 1, canvas: { aspectWidth: 4, aspectHeight: 5, outputWidth: 1200, outputHeight: 1500, globalStyle: '' }, elementCount: 0, elements: [] },
      selectedIds: [], selectedElements: [], attachments: [], ephemeralAnnotation: null, autoGenerate: false, activeGenerationJobId: null
    })
    const turn = agentTurnSchema.parse({
      id: '00000000-0000-4000-8000-000000000011', threadId: '00000000-0000-4000-8000-000000000010', goalId: null, inputMessageId: 'run-1', status: 'building_context',
      sceneRevisionAtStart: 1, contextManifestId: null, writeLeaseId: null, modelTurnsUsed: 0, toolCallsUsed: 0, sceneWriteBatchesUsed: 0, recoveryAttemptsUsed: 0,
      errorCode: null, errorMessage: null, createdAt: NOW, updatedAt: NOW, completedAt: null
    })
    const built = new ContextBuilder().build({
      projectId: scene.projectId,
      threadId: turn.threadId,
      turn,
      goal: null,
      request,
      items: [],
      directives: [],
      memories: [],
      outboundPolicy: 'minimal',
      allowedTools: [],
      userContext: {
        brand: { name: '晨雾咖啡', hasLogo: true, colors: ['#3B6FB6'], titleFont: 'Noto Serif SC', bodyFont: null, copy: ['每天新鲜烘焙'], bannedWords: ['最'] },
        preferences: [{ id: 'p1', kind: 'preference', content: '版面留白多一些' }]
      }
    })
    const manifest = contextManifestSchema.parse({
      id: '00000000-0000-4000-8000-000000000020',
      ...built.manifest,
      createdAt: NOW,
      entries: built.manifest.entries.map((entry, index) => ({
        id: `00000000-0000-4000-8000-${String(300 + index).padStart(12, '0')}`,
        manifestId: '00000000-0000-4000-8000-000000000020',
        ordinal: index,
        ...entry,
        createdAt: NOW
      }))
    })
    const context = plannerProjectContext(manifest, '做一张新品海报')
    expect(context?.brand).toMatchObject({ name: '晨雾咖啡', colors: ['#3B6FB6'], bannedWords: ['最'] })
    expect(context?.userPreferences).toEqual([{ kind: 'preference', content: '版面留白多一些' }])
    const brief = multiStepTurnBrief({ request, scene, refs: ElementRefs.fromScene(scene), results: [], projectContext: context })
    expect(brief).toContain('品牌（参考，和本轮要求或项目规则冲突时以它们为准）：')
    expect(brief).toContain('- 品牌名：晨雾咖啡')
    expect(brief).toContain('- 禁用词（画面文字里不要出现）：最')
    expect(brief).toContain('用户偏好（参考，所有作品共用；和本轮要求冲突时以本轮为准）：\n- 版面留白多一些')
  })

  it('writes only the brand lines that are set', () => {
    expect(brandBriefLines({ name: null, hasLogo: false, colors: ['#111111'], titleFont: null, bodyFont: null, copy: [], bannedWords: [] })).toEqual(['主色：#111111'])
  })
})
