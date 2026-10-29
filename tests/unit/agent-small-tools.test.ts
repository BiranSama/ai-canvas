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
import { formatToolResult, type AgentToolContext, type AgentToolResult, type LookRequest } from '../../src/main/agent/tools/types'

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
  /** Main's services a test stands in for, such as drawing layers. */
  extra: Partial<AgentToolContext> = {}

  constructor() {
    const base = createScene({ id: ids(1)(), projectId: '00000000-0000-4000-8000-000000000002', now: NOW })
    this.scene = base
    this.refs = ElementRefs.fromScene(base)
  }

  context(): AgentToolContext {
    return {
      scene: this.scene, refs: this.refs, newId: this.newId, results: [], generation: this.generation,
      activeJobId: null, sourceMessageId: 'message-1', userText: '', ...this.extra
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
    expect(definitions).toHaveLength(26)
    expect(new Set(definitions.map((definition) => definition.name)).size).toBe(26)
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

  it('shows one layer on its own, hidden or not, cropped to it on transparency', async () => {
    const harness = new Harness()
    await harness.call('add_subject', { subject: '香水瓶', box: [20, 20, 60, 60] })
    await harness.call('add_text', { content: '晨雾', role: 'title', box: [30, 10, 40, 10] })
    await harness.call('update', { targets: ['E2'], set: { visible: false } })
    const seen: { scene: Scene; request: LookRequest }[] = []
    const looker = { look: async (scene: Scene, request: LookRequest) => {
      seen.push({ scene, request })
      return { mimeType: 'image/jpeg' as const, base64: 'AA==' }
    } }
    const look = (args: Record<string, unknown>) => prepareAgentToolCall(
      { callId: 'l', name: 'look', argumentsText: JSON.stringify(args), arguments: args, argumentsError: null },
      { ...harness.context(), looker, vision: true, screenshots: 'allowed' }
    )

    const { step } = await look({ target: 'E2' })
    expect(step).toMatchObject({ kind: 'answer', result: { ok: true, summary: expect.stringContaining('它在画布上是隐藏的') } })
    const [{ scene, request }] = seen as [typeof seen[number]]
    expect(scene.canvas.transparent).toBe(true)
    expect(scene.elements.map((element) => [element.type, element.visible, element.zIndex])).toEqual([['text', true, 0]])
    expect(request).toMatchObject({ mode: 'canvas', background: 'checker' })
    expect(request.region?.map((value) => Math.round(value))).toEqual([27, 7, 46, 16])
    // The real scene is untouched.
    expect(harness.scene.elements.find((element) => element.type === 'text')?.visible).toBe(false)

    expect((await look({ target: 'E2', region: [0, 0, 50, 50] })).step).toMatchObject({ kind: 'answer', result: { ok: false } })
    expect((await look({ target: 'E9' })).step).toMatchObject({ kind: 'answer', result: { ok: false, summary: expect.stringContaining('没有对象 E9') } })
    const described = await prepareAgentToolCall(
      { callId: 'l', name: 'look', argumentsText: '', arguments: { target: 'E2' }, argumentsError: null },
      { ...harness.context(), looker, vision: false }
    )
    expect(described.step).toMatchObject({ kind: 'answer', result: { details: [expect.stringContaining('隐藏')] } })
  })

  it('draws an isolated layer over grey and white squares', async () => {
    const { SceneLooker } = await import('../../src/main/agent/multi-step/scene-looker')
    const base = createScene({ id: ids(1)(), projectId: '00000000-0000-4000-8000-000000000002', now: NOW })
    const scene = { ...base, canvas: { ...base.canvas, transparent: true } }
    const image = await new SceneLooker(async () => null).look(scene, { region: null, mode: 'canvas', background: 'checker' })
    const { default: sharp } = await import('sharp')
    const { data, info } = await sharp(Buffer.from(image.base64, 'base64')).raw().toBuffer({ resolveWithObject: true })
    const at = (x: number, y: number) => data[(y * info.width + x) * info.channels]!
    // One light square and one darker square of the checker.
    expect(at(2, 2)).toBeLessThan(230)
    expect(at(18, 2)).toBeGreaterThan(245)
  })
})

describe('generate a layer', () => {
  it('redraws one placeholder in context when the service can repaint part of an image', async () => {
    const harness = new Harness()
    harness.generation = { providerId: 'image-provider', model: 'seedream', maxImages: 4, localEdits: true }
    await harness.call('add_subject', { subject: '香水瓶', box: [30, 30, 40, 40] })
    await harness.call('add_text', { content: '晨雾', role: 'title' })
    const call = (args: unknown) => prepareAgentToolCall({ callId: 'g', name: 'generate', argumentsText: JSON.stringify(args), arguments: args as Record<string, unknown>, argumentsError: null }, harness.context())
    const { step } = await call({ scope: 'layer', target: 'E1', brief: '磨砂玻璃香水瓶，清晨侧光' })
    expect(step).toMatchObject({ kind: 'execute', plan: { kind: 'canvas_edit', mode: 'in-context', prompt: '磨砂玻璃香水瓶，清晨侧光', providerId: 'image-provider', count: 1 } })
    expect((await call({ scope: 'layer', brief: 'x' })).step).toMatchObject({ kind: 'answer', result: { ok: false, summary: 'scope=layer 需要 target。' } })
    expect((await call({ scope: 'layer', target: 'E2', brief: 'x' })).step).toMatchObject({ kind: 'answer', result: { ok: false, summary: 'E2 不是主体占位或图片。' } })
    harness.generation = { ...harness.generation, localEdits: false }
    expect((await call({ scope: 'layer', target: 'E1', brief: 'x' })).step).toMatchObject({ kind: 'answer', result: { ok: false, summary: '当前生图服务不支持局部重画。' } })
  })
})

describe('unified render', () => {
  it('redraws the whole picture when there is something to redraw and the service takes references', async () => {
    const harness = new Harness()
    harness.generation = { providerId: 'image-provider', model: 'seedream', maxImages: 4, references: true }
    const call = async (args: unknown) => (await prepareAgentToolCall({ callId: 'u', name: 'generate', argumentsText: JSON.stringify(args), arguments: args as Record<string, unknown>, argumentsError: null }, harness.context())).step
    await harness.call('add_text', { content: '晨雾', role: 'title' })
    expect(await call({ scope: 'unified', brief: '统一成清晨柔光' })).toMatchObject({ kind: 'answer', result: { ok: false, summary: '画布上还没有可以统一重绘的图片或形状。' } })
    await harness.call('add_shape', { shape: 'rectangle', box: [0, 0, 100, 100], color: '#335577' })
    expect(await call({ scope: 'unified', brief: '统一成清晨柔光', count: 2 })).toMatchObject({
      kind: 'execute', plan: { kind: 'canvas_generation', mode: 'unified', originalRequirement: '统一成清晨柔光', providerId: 'image-provider', count: 2, referenceMode: 'visual' }
    })
    harness.generation = { ...harness.generation, references: false }
    expect(await call({ scope: 'unified', brief: 'x' })).toMatchObject({ kind: 'answer', result: { ok: false, summary: '当前生图服务不接受参考图，不能统一重绘。' } })
  })
})

describe('blend', () => {
  it('matches tone, fades edges and adds a shadow as layer effects, keeping the asset', async () => {
    const harness = new Harness()
    const image = {
      id: '00000000-0000-4000-8000-000000000501', version: 1, type: 'image', name: '香水瓶', description: '',
      transform: { x: 0.3, y: 0.3, width: 0.4, height: 0.4, rotation: 0 }, zIndex: 0, opacity: 1, blendMode: 'normal', visible: true, locked: false,
      groupId: null, semanticRole: 'content', referencePolicy: 'include', assetId: '00000000-0000-4000-8000-000000000502',
      crop: { x: 0, y: 0, width: 1, height: 1 }, fit: 'fill', referenceRole: 'general'
    } as const
    harness.scene = { ...harness.scene, elements: [image] }
    harness.refs.sync(harness.scene)
    const measured: [string, number][] = []
    const context = (opaque: boolean): AgentToolContext => ({
      ...harness.context(),
      measureTone: async (elementId, strength) => {
        measured.push([elementId, strength])
        return { colorMatch: { gain: [1, 1, 1], offset: [-6, 2, 9] }, opaque }
      }
    })
    const blend = async (args: Record<string, unknown>, opaque = true) => (await prepareAgentToolCall({ callId: 'b', name: 'blend', argumentsText: JSON.stringify(args), arguments: args, argumentsError: null }, context(opaque))).step
    const changes = (step: Awaited<ReturnType<typeof blend>>) => step.kind === 'execute' && step.plan.kind === 'scene.update_elements' ? step.plan.updates[0]!.changes : null

    // Only the target: moderate tone, and a little feather for an opaque picture.
    const defaults = await blend({ target: 'E1' })
    expect(changes(defaults)).toEqual({ effects: { colorMatch: { gain: [1, 1, 1], offset: [-6, 2, 9] }, feather: 0.04, shadow: null } })
    expect(measured).toEqual([[image.id, 0.4]])
    // A cut-out gets no feather by default; a shadow is asked for explicitly.
    expect(changes(await blend({ target: 'E1' }, false))).toMatchObject({ effects: { feather: 0 } })
    expect(changes(await blend({ target: 'E1', shadow: 0.5 }))).toEqual({ effects: { colorMatch: null, feather: 0, shadow: { color: '#000000', opacity: 0.275, blur: 0.04, offsetX: 0, offsetY: 0.025 } } })

    // The plan is a valid scene write; later calls build on what is set and 0 removes.
    const executed = new CommandBus(harness.scene, { now: () => NOW }).execute({ id: harness.newId(), origin: 'agent', summary: 'blend', commands: compile(agentToolPlanSchema.parse((defaults as { plan: AgentToolPlan }).plan)) })
    if (!executed.ok) throw new Error(JSON.stringify(executed.error))
    harness.scene = executed.scene
    expect(harness.scene.elements[0]).toMatchObject({ assetId: image.assetId, effects: { feather: 0.04 } })
    expect(changes(await blend({ target: 'E1', tone: 0, feather: 0.1 }))).toEqual({ effects: { colorMatch: null, feather: 0.1, shadow: null } })

    await harness.call('add_text', { content: '晨雾', role: 'title' })
    expect(await blend({ target: 'E2' })).toMatchObject({ kind: 'answer', result: { ok: false, summary: 'E2 不是图片。' } })
  })
})

describe('free-form shapes', () => {
  it('draws an outline from SVG path syntax, filling closed ones and stroking open ones', async () => {
    const harness = new Harness()
    const leaf = await harness.call('add_shape', { shape: 'path', box: [10, 10, 20, 30], path: 'M50 0 C80 30 80 70 50 100 C20 70 20 30 50 0 Z', color: '#4A7A4A', name: '叶子' })
    expect(leaf.result).toMatchObject({ ok: true })
    expect(harness.scene.elements[0]).toMatchObject({
      type: 'shape', shape: 'path', path: 'M50 0C80 30 80 70 50 100C20 70 20 30 50 0Z', fill: '#4A7A4A', stroke: null, strokeWidth: 0, name: '叶子'
    })
    await harness.call('add_shape', { shape: 'path', box: [0, 60, 100, 10], path: 'M0 50 Q25 0 50 50 T100 50', stroke: '#2B5D8A' })
    expect(harness.scene.elements[1]).toMatchObject({ fill: '#00000000', stroke: '#2B5D8A', strokeWidth: 0.02 })

    expect((await harness.call('add_shape', { shape: 'path', box: [0, 0, 10, 10] })).result).toMatchObject({ ok: false, summary: 'shape=path 需要 path。' })
    expect((await harness.call('add_shape', { shape: 'path', box: [0, 0, 10, 10], path: 'L1 1' })).result).toMatchObject({ ok: false, summary: '路径无法使用：路径要以 M 开头。' })

    // An existing rectangle can be redrawn as an outline.
    await harness.call('add_shape', { shape: 'rectangle', box: [40, 40, 20, 20] })
    await harness.call('update', { targets: ['E3'], set: { path: 'M0 0 L100 0 L50 100 Z' } })
    expect(harness.scene.elements[2]).toMatchObject({ shape: 'path', path: 'M0 0L100 0L50 100Z' })
    const facts = (await harness.call('inspect', { targets: ['E3'] })).result.details?.join('\n') ?? ''
    expect(facts).toContain('路径 M0 0L100 0L50 100Z')
  })
})

describe('fonts', () => {
  const FONTS = [
    { family: 'Microsoft YaHei', localName: '微软雅黑', styles: ['Regular', 'Bold'], chinese: true },
    { family: 'Georgia', localName: null, styles: ['Regular'], chinese: false }
  ]

  it('stores the English family for a font named either way and refuses one the computer lacks', async () => {
    const harness = new Harness()
    const withFonts = { ...harness.context(), fonts: FONTS }
    const call = (name: string, args: unknown, context: AgentToolContext = withFonts) => prepareAgentToolCall(
      { callId: 'f', name, argumentsText: JSON.stringify(args), arguments: args as Record<string, unknown>, argumentsError: null }, context
    )
    const added = await call('add_text', { content: '晨雾', role: 'title', font: '微软雅黑' })
    expect(added.step.kind === 'execute' && JSON.stringify(added.step.plan)).toContain('"fontFamily":"Microsoft YaHei"')
    expect((await call('add_text', { content: '晨雾', role: 'title', font: '方正兰亭' })).step).toMatchObject({
      kind: 'answer', result: { ok: false, summary: '这台电脑上没有字体「方正兰亭」。', hint: expect.stringContaining('用第一条消息里「本机字体」') }
    })
    expect((await call('add_text', { content: '晨雾', role: 'title', font: 'Microsoft' })).step).toMatchObject({
      kind: 'answer', result: { ok: false, hint: '相近的有：微软雅黑 (Microsoft YaHei)。' }
    })
    // Unknown fonts on this computer: the name is used as given.
    const unknown = await call('add_text', { content: '晨雾', role: 'title', font: 'Some Font' }, harness.context())
    expect(unknown.step.kind === 'execute' && JSON.stringify(unknown.step.plan)).toContain('"fontFamily":"Some Font"')

    await harness.call('add_text', { content: '晨雾', role: 'title' })
    const updated = await call('update', { targets: ['E1'], set: { font: 'georgia' } }, { ...harness.context(), fonts: FONTS })
    expect(updated.step.kind === 'execute' && JSON.stringify(updated.step.plan)).toContain('"fontFamily":"Georgia"')
  })

  it('lists the fonts in the turn brief, Chinese ones first', async () => {
    const { multiStepTurnBrief } = await import('../../src/main/agent/multi-step/prompt')
    const harness = new Harness()
    const brief = multiStepTurnBrief({
      request: { text: '换个字体', selectedIds: [] } as never, scene: harness.scene, refs: harness.refs, results: [], projectContext: null, fonts: FONTS
    })
    expect(brief).toContain('本机字体（文字工具的 font 用这里的中文名或英文名）：\n- 中文：微软雅黑 (Microsoft YaHei)\n- 其他：Georgia')
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

describe('fill and merge_layers', () => {
  const ASSET = '00000000-0000-4000-8000-000000000602'
  function withImage(harness: Harness): void {
    const image = {
      id: '00000000-0000-4000-8000-000000000601', version: 1, type: 'image', name: '底图', description: '',
      transform: { x: 0, y: 0, width: 1, height: 1, rotation: 0 }, zIndex: 0, opacity: 1, blendMode: 'normal', visible: true, locked: false,
      groupId: null, semanticRole: 'content', referencePolicy: 'include', assetId: ASSET,
      crop: { x: 0, y: 0, width: 1, height: 1 }, fit: 'fill', referenceRole: 'general'
    } as const
    harness.scene = { ...harness.scene, elements: [image] }
    harness.refs.sync(harness.scene)
  }

  it('fills an image layer with a colour or a gradient across its own pixels, as one recorded paint step', async () => {
    const harness = new Harness()
    withImage(harness)
    harness.extra = { assetSize: async () => ({ width: 200, height: 100 }) }
    expect((await harness.call('fill', { target: 'E1', color: '#3366cc', keep_transparency: true })).result.ok).toBe(true)
    expect((harness.scene.elements[0] as { paint?: unknown[] }).paint).toEqual([
      { id: expect.any(String), kind: 'fill-all', color: '#3366CC', opacity: 1, lockAlpha: true }
    ])
    const { result } = await harness.call('fill', { target: 'E1', color: '#000', to_color: '#FFFFFF80', direction: 'left_to_right' })
    expect(result.summary).toBe('已给 E1 铺上从左到右的 #000000 → #FFFFFF 渐变')
    expect((harness.scene.elements[0] as { paint?: unknown[] }).paint?.[1]).toMatchObject({
      kind: 'gradient', shape: 'linear', from: [0, 50], to: [200, 50], colors: ['#000000', '#FFFFFF'], opacity: 128 / 255, lockAlpha: false
    })
    await harness.call('fill', { target: 'E1', color: '#FF0000', to_color: '#0000FF', direction: 'radial' })
    expect((harness.scene.elements[0] as { paint?: unknown[] }).paint?.[2]).toMatchObject({ shape: 'radial', from: [100, 50], to: [100 + Math.round(Math.hypot(200, 100) / 2 * 100) / 100, 50] })

    await harness.call('add_text', { content: '晨雾', role: 'title' })
    expect((await harness.call('fill', { target: 'E2', color: '#FF0000' })).result).toMatchObject({ ok: false, summary: 'E2 是文字，不是像素图层。' })
    expect((await harness.call('fill', { target: 'E1', color: '#FF0000', direction: 'radial' })).result).toMatchObject({ ok: false, summary: 'direction 只用于渐变。' })
  })

  it('fills a new canvas-sized layer when no target is given', async () => {
    const harness = new Harness()
    harness.extra = { blankLayer: async () => ASSET }
    const { result } = await harness.call('fill', { color: '#F4EDE2', to_color: '#D9C7B0', name: '暖色背景' })
    expect(result).toMatchObject({ ok: true, summary: '已新建图层并铺上从上到下的 #F4EDE2 → #D9C7B0 渐变，在最上面' })
    expect(harness.scene.elements[0]).toMatchObject({
      type: 'image', name: '暖色背景', assetId: ASSET, fit: 'fill', transform: { x: 0, y: 0, width: 1, height: 1 },
      paint: [{ kind: 'gradient', from: [512, 0], to: [512, 1280] }]
    })
    harness.extra = {}
    expect((await harness.call('fill', { color: '#FFFFFF' })).result).toMatchObject({ ok: false, summary: '现在建不了新图层。' })
  })

  it('rasterizes one text or shape layer in place and merges several into the lowest', async () => {
    const harness = new Harness()
    const drawn: [readonly string[], string | undefined][] = []
    harness.extra = {
      drawLayers: async (elementIds, base) => {
        drawn.push([elementIds, base])
        return { assetId: ASSET, transform: { x: 0.1, y: 0.2, width: 0.5, height: 0.25, rotation: 0 } }
      }
    }
    await harness.call('add_shape', { shape: 'rectangle', box: [10, 20, 50, 25], color: '#AA3300' })
    await harness.call('add_text', { content: '晨雾', role: 'title' })
    const [shape, title] = harness.scene.elements

    const rasterized = await harness.call('merge_layers', { targets: ['E1'] })
    expect(rasterized.result.summary).toBe('已把 E1「矩形」栅格化成图片，样子不变')
    expect(drawn.at(-1)).toEqual([[shape!.id], shape!.id])
    expect(harness.scene.elements[0]).toMatchObject({ id: shape!.id, type: 'image', name: '矩形', assetId: ASSET, fit: 'fill', transform: { x: 0.1, y: 0.2, width: 0.5, height: 0.25 } })

    const merged = await harness.call('merge_layers', { targets: ['E2', 'E1'] })
    expect(merged.result.summary).toBe('已把 2 个图层合并进 E1「矩形」')
    expect(drawn.at(-1)).toEqual([[shape!.id, title!.id], undefined])
    expect(harness.scene.elements.map((element) => element.id)).toEqual([shape!.id])
    expect(harness.scene.elements[0]).toMatchObject({ opacity: 1, blendMode: 'normal' })

    await harness.call('add_subject', { subject: '一只猫', box: [20, 20, 40, 40] })
    expect((await harness.call('merge_layers', { targets: ['E1', 'E3'] })).result).toMatchObject({ ok: false, summary: 'E3「主体·一只猫」是 AI 标注，不能合并。' })
  })
})

describe('mask_layer', () => {
  const ASSET = '00000000-0000-4000-8000-000000000702'
  const MASK = '00000000-0000-4000-8000-000000000703'
  const BAKED = '00000000-0000-4000-8000-000000000704'
  function withImage(harness: Harness): void {
    const image = {
      id: '00000000-0000-4000-8000-000000000701', version: 1, type: 'image', name: '人像', description: '',
      transform: { x: 0, y: 0, width: 1, height: 1, rotation: 0 }, zIndex: 0, opacity: 1, blendMode: 'normal', visible: true, locked: false,
      groupId: null, semanticRole: 'content', referencePolicy: 'include', assetId: ASSET,
      crop: { x: 0, y: 0, width: 1, height: 1 }, fit: 'fill', referenceRole: 'general'
    } as const
    harness.scene = { ...harness.scene, elements: [image] }
    harness.refs.sync(harness.scene)
  }

  it('masks a layer by its subject, a box or the person\'s selection, and reworks the mask it has', async () => {
    const harness = new Harness()
    withImage(harness)
    const specs: unknown[] = []
    harness.extra = { layerMask: async (spec) => { specs.push(spec); return { assetId: MASK } } }
    expect(availableAgentTools(harness.context()).some((tool) => tool.name === 'mask_layer')).toBe(true)

    const subject = await harness.call('mask_layer', { target: 'E1', source: 'subject', feather: 2 })
    expect(subject.result.summary).toBe('已给 E1 加上蒙版：主体，边缘羽化 2 像素')
    expect(specs.at(-1)).toEqual({ elementId: harness.scene.elements[0]!.id, shape: { kind: 'subject' }, combine: 'replace', invert: false, feather: 2 })
    expect(harness.scene.elements[0]).toMatchObject({ mask: { assetId: MASK, enabled: true } })

    await harness.call('mask_layer', { target: 'E1', source: 'ellipse', region: [10, 20, 30, 40], invert: true, combine: 'subtract' })
    expect(specs.at(-1)).toMatchObject({ shape: { kind: 'ellipse', box: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 } }, combine: 'subtract', invert: true })

    expect((await harness.call('mask_layer', { target: 'E1', source: 'selection' })).result).toMatchObject({ ok: false, summary: '用户这一轮没有选区。' })
    const outline = [{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.1 }, { x: 0.5, y: 0.5 }]
    harness.extra = {
      ...harness.extra,
      marked: {
        id: '00000000-0000-4000-8000-000000000705', mode: 'edit', points: outline, closed: true, width: 0.015, targetElementId: null,
        regions: [
          { id: '00000000-0000-4000-8000-000000000705', mode: 'edit', points: outline, closed: true, width: 0.015 },
          { id: '00000000-0000-4000-8000-000000000706', mode: 'protect', points: [{ x: 0.6, y: 0.6 }, { x: 0.9, y: 0.6 }, { x: 0.9, y: 0.9 }], closed: true, width: 0.015 }
        ]
      }
    }
    expect((await harness.call('mask_layer', { target: 'E1', source: 'selection' })).result.summary).toBe('已给 E1 改了蒙版：用户的选区')
    expect(specs.at(-1)).toMatchObject({ shape: { kind: 'polygons', polygons: [outline], holes: [[{ x: 0.6, y: 0.6 }, { x: 0.9, y: 0.6 }, { x: 0.9, y: 0.9 }]] } })

    expect((await harness.call('mask_layer', { target: 'E1', source: 'current', invert: true })).result.summary).toBe('已把 E1 的蒙版反相')
    expect(specs.at(-1)).toMatchObject({ shape: { kind: 'current' }, invert: true })

    expect((await harness.call('mask_layer', { target: 'E1', source: 'box' })).result).toMatchObject({ ok: false, summary: 'source=box 要给 region。' })
    expect((await harness.call('mask_layer', { target: 'E1' })).result).toMatchObject({ ok: false, summary: 'action=set 要给 source。' })
    expect((await harness.call('mask_layer', { target: 'E1', source: 'current' })).result).toMatchObject({ ok: false, summary: 'source=current 要配合 invert 或 feather。' })

    harness.extra = { layerMask: async () => '选择主体用的模型还没有下载。' }
    expect((await harness.call('mask_layer', { target: 'E1', source: 'subject' })).result).toMatchObject({ ok: false, hint: expect.stringContaining('选择主体') })
  })

  it('disables, enables, deletes and applies a mask; applying rasterizes text and shapes', async () => {
    const harness = new Harness()
    withImage(harness)
    const baked: string[] = []
    harness.extra = {
      layerMask: async () => ({ assetId: MASK }),
      bakeImage: async (elementId) => { baked.push(elementId); return BAKED },
      drawLayers: async () => ({ assetId: BAKED, transform: { x: 0.1, y: 0.1, width: 0.2, height: 0.2, rotation: 0 } })
    }
    expect((await harness.call('mask_layer', { target: 'E1', action: 'apply' })).result).toMatchObject({ ok: false, summary: 'E1 没有蒙版。' })
    await harness.call('mask_layer', { target: 'E1', source: 'box', region: [0, 0, 50, 100] })

    expect((await harness.call('mask_layer', { target: 'E1', action: 'disable' })).result.summary).toBe('已停用 E1 的蒙版')
    expect(harness.scene.elements[0]).toMatchObject({ mask: { assetId: MASK, enabled: false } })
    expect((await harness.call('mask_layer', { target: 'E1', action: 'apply' })).result).toMatchObject({ ok: false, summary: 'E1 的蒙版停用着。' })
    await harness.call('mask_layer', { target: 'E1', action: 'enable' })
    expect((await harness.call('mask_layer', { target: 'E1', action: 'delete', invert: true })).result.ok).toBe(false)

    const applied = await harness.call('mask_layer', { target: 'E1', action: 'apply' })
    expect(applied.result.summary).toBe('已把 E1 的蒙版应用进像素：遮住的部分删掉了')
    expect(baked).toEqual([harness.scene.elements[0]!.id])
    expect(harness.scene.elements[0]).toMatchObject({ assetId: BAKED, paint: [], mask: null })

    await harness.call('add_text', { content: '晨雾', role: 'title' })
    expect((await harness.call('mask_layer', { target: 'E2', source: 'subject' })).result).toMatchObject({ ok: false, summary: 'E2 不是图片，没有主体可找。' })
    await harness.call('mask_layer', { target: 'E2', source: 'box', region: [0, 0, 50, 100] })
    expect(harness.scene.elements[1]).toMatchObject({ type: 'text', mask: { assetId: MASK } })
    expect((await harness.call('mask_layer', { target: 'E2', action: 'apply' })).result.summary).toBe('已把 E2 的蒙版应用进像素：遮住的部分删掉了，图层已栅格化')
    expect(harness.scene.elements[1]).toMatchObject({ type: 'image', assetId: BAKED })
    expect(harness.scene.elements[1]).not.toHaveProperty('mask')

    await harness.call('mask_layer', { target: 'E1', source: 'box', region: [0, 0, 50, 100] })
    expect((await harness.call('mask_layer', { target: 'E1', action: 'delete' })).result.summary).toBe('已删掉 E1 的蒙版，整个图层重新露出')
    expect(harness.scene.elements[0]).toMatchObject({ mask: null })
  })
})
