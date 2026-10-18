import { describe, expect, it } from 'vitest'
import { CommandBus, createScene, type Scene, type SceneCommand } from '../../src/domain'
import { agentToolPlanSchema, type AgentToolPlan } from '../../src/shared/agent'
import { compileAtomicSceneCommands, isAtomicSceneWriteTool } from '../../src/main/agent/atomic-scene-tools'
import {
  AGENT_TOOLS,
  availableAgentTools,
  llmToolDefinitions,
  prepareAgentToolCall
} from '../../src/main/agent/tools/catalogue'
import { ElementRefs } from '../../src/main/agent/tools/refs'
import { formatToolResult, type AgentToolContext, type AgentToolResult } from '../../src/main/agent/tools/types'

const NOW = '2026-10-18T00:00:00.000Z'

function ids(start = 1): () => string {
  let next = start
  return () => `00000000-0000-4000-8000-${String(next++).padStart(12, '0')}`
}

function compile(plan: AgentToolPlan): SceneCommand[] {
  if (plan.kind === 'scene_batch') return plan.commands
  if (isAtomicSceneWriteTool(plan)) return compileAtomicSceneCommands(plan)
  throw new Error(`Not a scene write: ${plan.kind}`)
}

class Harness {
  scene: Scene
  readonly newId = ids(100)
  readonly refs: ElementRefs
  generation: AgentToolContext['generation'] = { providerId: 'image-provider', model: 'seedream', maxImages: 4 }

  constructor() {
    const base = createScene({ id: ids(1)(), projectId: '00000000-0000-4000-8000-000000000002', now: NOW })
    this.scene = base
    this.refs = ElementRefs.fromScene(base)
  }

  context(): AgentToolContext {
    return {
      scene: this.scene, refs: this.refs, newId: this.newId, results: [], generation: this.generation,
      activeJobId: null, sourceMessageId: 'message-1', userText: ''
    }
  }

  /** Runs a call the way the loop will: prepare, execute scene writes locally, report. */
  async call(name: string, args: unknown): Promise<{ result: AgentToolResult; plan: AgentToolPlan | null }> {
    const { step } = await prepareAgentToolCall({
      callId: 'call', name, argumentsText: JSON.stringify(args), arguments: args as Record<string, unknown>, argumentsError: null
    }, this.context())
    if (step.kind === 'answer') return { result: step.result, plan: null }
    if (step.kind === 'ask') return { result: { ok: true, summary: step.question }, plan: null }
    const plan = agentToolPlanSchema.parse(step.plan)
    if (plan.kind === 'canvas_generation' || plan.kind === 'generation') {
      return { result: step.report({ outcome: { toolIndex: 0, ok: true, batchId: null, jobId: 'job', affectedElementIds: [], message: '任务已创建' }, sceneBefore: this.scene, sceneAfter: this.scene }), plan }
    }
    const before = this.scene
    const executed = new CommandBus(before, { now: () => NOW }).execute({ id: this.newId(), origin: 'agent', summary: 'test', commands: compile(plan) })
    if (!executed.ok) throw new Error(JSON.stringify(executed.error))
    this.scene = executed.scene
    return {
      result: step.report({ outcome: { toolIndex: 0, ok: true, batchId: null, jobId: null, affectedElementIds: [], message: 'ok' }, sceneBefore: before, sceneAfter: executed.scene }),
      plan
    }
  }
}

describe('small agent tools', () => {
  it('keeps the whole catalogue small, uniquely named and valid for every protocol', () => {
    const definitions = llmToolDefinitions(AGENT_TOOLS as never)
    expect(definitions).toHaveLength(22)
    expect(new Set(definitions.map((definition) => definition.name)).size).toBe(22)
    for (const definition of definitions) expect(definition.name).toMatch(/^[a-z_]{1,64}$/)
    expect(JSON.stringify(definitions).length).toBeLessThan(20_000)
  })

  it('offers only the tools the current canvas and services support', () => {
    const harness = new Harness()
    const names = () => availableAgentTools(harness.context()).map((tool) => tool.name)
    expect(names()).toEqual(expect.arrayContaining(['inspect', 'add_text', 'generate']))
    expect(names()).not.toEqual(expect.arrayContaining(['edit_image']))
    expect(names()).not.toContain('place_result')
    expect(names()).not.toContain('look')
    harness.generation = null
    expect(names()).not.toContain('generate')
  })

  it('adds a title with role defaults and reports its new short reference', async () => {
    const harness = new Harness()
    const { result } = await harness.call('add_text', { content: '晨雾', role: 'title' })
    expect(result.ok).toBe(true)
    const title = harness.scene.elements[0]!
    expect(title).toMatchObject({ type: 'text', content: '晨雾', fontSize: 77, fontWeight: 600, align: 'center', fill: '#1F2328', semanticRole: 'title' })
    expect(result.details?.[0]).toContain('新建 E1「标题·晨雾」文字')
    expect(formatToolResult(result)).toMatch(/^成功：已添加标题「晨雾」/)
  })

  it('scales text about its centre and reports before and after values', async () => {
    const harness = new Harness()
    await harness.call('add_text', { content: '晨雾', role: 'title', box: [10, 10, 80, 20] })
    const { result } = await harness.call('update', { targets: ['E1'], set: { scale: 0.8 } })
    const title = harness.scene.elements[0]!
    expect(title).toMatchObject({ fontSize: 61.6 })
    expect([title.transform.x, title.transform.y, title.transform.width, title.transform.height].map((value) => Math.round(value * 1_000) / 1_000))
      .toEqual([0.18, 0.12, 0.64, 0.16])
    expect(result.details?.[0]).toBe('E1「标题·晨雾」：位置 [10, 10, 80, 20] → [18, 12, 64, 16]；字号 77 → 61.6')
  })

  it('returns mistakes to the model instead of failing the turn', async () => {
    const harness = new Harness()
    await harness.call('add_shape', { shape: 'rectangle', box: [0, 80, 100, 20] })
    expect((await harness.call('update', { targets: ['E1'], set: { content: 'x' } })).result)
      .toMatchObject({ ok: false, summary: 'E1「矩形」：content 只能用于文字对象。' })
    expect((await harness.call('update', { targets: ['E9'], set: { opacity: 0.5 } })).result.summary).toContain('没有对象 E9')
    expect((await harness.call('update', { targets: ['E1'], set: { opacity: 2 } })).result.summary).toMatch(/^参数不对：set\.opacity/)
    expect((await harness.call('paint', {})).result.summary).toBe('没有可用的工具 paint。')
    const broken = await prepareAgentToolCall({ callId: 'c', name: 'inspect', argumentsText: '{"targets":', arguments: null, argumentsError: 'incomplete' }, harness.context())
    expect(broken.step).toMatchObject({ kind: 'answer', result: { ok: false, summary: '参数没有写完整，可能是输出被截断。' } })
  })

  it('refuses locked objects but lets the model unlock them', async () => {
    const harness = new Harness()
    await harness.call('add_text', { content: 'AUREL', role: 'label' })
    await harness.call('update', { targets: ['E1'], set: { locked: true } })
    expect((await harness.call('update', { targets: ['E1'], set: { color: '#FFFFFF' } })).result.summary).toContain('已锁定')
    expect((await harness.call('update', { targets: ['E1'], set: { locked: false } })).result.ok).toBe(true)
  })

  it('aligns, distributes, reorders, groups and removes by short reference', async () => {
    const harness = new Harness()
    for (const x of [5, 20, 70]) await harness.call('add_shape', { shape: 'ellipse', box: [x, 40, 10, 10] })
    await harness.call('arrange', { targets: ['E1', 'E2', 'E3'], how: 'distribute-horizontal' })
    // 5 → 80 spans 75 with 30 of objects, so each of the two gaps is 22.5.
    expect(harness.scene.elements.map((element) => Math.round(element.transform.x * 1_000) / 10)).toEqual([5, 37.5, 70])
    expect((await harness.call('arrange', { targets: ['E1', 'E2'], how: 'distribute-vertical' })).result.summary).toBe('等距分布至少需要 3 个对象。')
    await harness.call('reorder', { target: 'E1', to: 'front' })
    expect(harness.scene.elements.at(-1)!.id).toBe(harness.refs.toJSON().E1)
    await harness.call('group', { targets: ['E2', 'E3'], name: '圆点组' })
    expect(harness.scene.elements.find((element) => element.type === 'group')).toMatchObject({ name: '圆点组' })
    const removal = await harness.call('remove', { targets: ['E1'] })
    expect(removal.result.details).toEqual(['E1「椭圆」已删除'])
  })

  it('changes the ratio without distorting existing objects', async () => {
    const harness = new Harness()
    await harness.call('add_subject', { subject: '香水瓶', box: [30, 30, 40, 40] })
    const { plan, result } = await harness.call('set_canvas', { ratio: '16:9' })
    expect(plan?.kind).toBe('scene_batch')
    expect(harness.scene.canvas).toMatchObject({ aspectWidth: 16, aspectHeight: 9, outputWidth: 1280, outputHeight: 720 })
    const subject = harness.scene.elements[0]!.transform
    expect(subject.width * 1280 / (subject.height * 720)).toBeCloseTo(1024 * 0.4 / (1280 * 0.4), 5)
    expect(result.details?.[0]).toContain('画布：4:5 1024×1280 → 16:9 1280×720')
  })

  it('compiles generation, edits and placing results to the existing paid and job tools', async () => {
    const harness = new Harness()
    const generated = await harness.call('generate', { scope: 'canvas', brief: '晨雾中的香水瓶', count: 2 })
    expect(generated.plan).toMatchObject({ kind: 'canvas_generation', providerId: 'image-provider', model: 'seedream', count: 2, sourceMessageId: 'message-1' })
    expect((await harness.call('generate', { scope: 'canvas', brief: 'x', count: 5 })).result.ok).toBe(false)
    await harness.call('add_subject', { subject: '香水瓶' })
    expect((await harness.call('add_mask', { target: 'E1', mode: 'edit', region: [40, 40, 20, 20] })).result.ok).toBe(true)
    expect(harness.scene.elements[1]).toMatchObject({ type: 'mask', mode: 'edit', targetElementId: harness.refs.toJSON().E1 })
  })

  it('keeps short references stable for the turn and resolves unique names', () => {
    const harness = new Harness()
    const refs = ElementRefs.fromScene(harness.scene, { E4: '00000000-0000-4000-8000-000000000999' })
    expect(refs.toJSON()).toEqual({})
    const scene = { elements: [{ id: 'a', zIndex: 0, name: '标题' }, { id: 'b', zIndex: 1, name: '标题' }] } as unknown as Scene
    const stable = ElementRefs.fromScene(scene, { E7: 'b' })
    expect(stable.toJSON()).toEqual({ E7: 'b', E8: 'a' })
    expect(stable.resolve('标题', scene)).toContain('有 2 个对象都叫「标题」')
    expect(stable.resolve('e7', scene)).toMatchObject({ id: 'b' })
  })

  it('caps result text for the model', () => {
    expect(formatToolResult({ ok: true, summary: 'x'.repeat(3_000) }).length).toBeLessThanOrEqual(2_000)
    expect(formatToolResult({ ok: false, summary: '不行', hint: '换个做法' })).toBe('未执行：不行\n建议：换个做法')
  })
})

describe('look', () => {
  it('describes the layout in words when the model cannot see images', async () => {
    const harness = new Harness()
    await harness.call('add_subject', { subject: '香水瓶', box: [20, 20, 60, 60] })
    await harness.call('add_text', { content: '晨雾', role: 'title', box: [30, 30, 40, 10] })
    const { step } = await prepareAgentToolCall(
      { callId: 'l', name: 'look', argumentsText: '{}', arguments: {}, argumentsError: null },
      { ...harness.context(), looker: { look: async () => { throw new Error('not used') } }, vision: false }
    )
    expect(step).toMatchObject({ kind: 'answer', result: { ok: true, summary: '当前文字模型不能看图，这是画面的文字描述。' } })
    const details = step.kind === 'answer' ? step.result.details ?? [] : []
    expect(details).toContain('E1 和 E2 重叠约 100%')
  })
})

describe('load_manual', () => {
  it('serves the built-in manuals on demand and names them in the system prompt', async () => {
    const { BUILT_IN_MANUALS } = await import('../../src/main/agent/manuals')
    const { multiStepSystemPrompt } = await import('../../src/main/agent/multi-step/prompt')
    const harness = new Harness()
    const context = { ...harness.context(), manuals: BUILT_IN_MANUALS }
    expect(availableAgentTools(context).map((tool) => tool.name)).toContain('load_manual')
    expect(multiStepSystemPrompt(BUILT_IN_MANUALS)).toContain('- chinese-typography：字体、字间距、行高、中英混排和竖排')
    const loaded = await prepareAgentToolCall({ callId: 'm', name: 'load_manual', argumentsText: '', arguments: { topic: 'color' }, argumentsError: null }, context)
    expect(loaded.step).toMatchObject({ kind: 'answer', result: { ok: true, summary: expect.stringContaining('# 配色') } })
    expect(formatToolResult((loaded.step as { result: AgentToolResult }).result)).not.toContain('已截断')
    const missing = await prepareAgentToolCall({ callId: 'n', name: 'load_manual', argumentsText: '', arguments: { topic: 'fonts' }, argumentsError: null }, context)
    expect(missing.step).toMatchObject({ kind: 'answer', result: { ok: false, hint: expect.stringContaining('poster-layout') } })
  })
})
