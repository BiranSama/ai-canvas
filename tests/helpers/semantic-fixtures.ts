import { CommandBus, type OperationBatch, type Scene, type SceneElement } from '../../src/domain'
import { DeterministicMockPlanner } from '../../src/main/agent'
import type { AgentPlan, AgentRequest, SceneSummary } from '../../src/shared/agent'

export const SEMANTIC_FIXTURES = [
  {
    key: 'portrait-editorial',
    prefix: '31',
    theme: 'portrait',
    title: 'QUIET FORM',
    request: '创建一张 4:5 人物编辑海报，主体是侧身人物，标题是 QUIET FORM，保留右侧留白与柔和侧光。先不要生成图片。'
  },
  {
    key: 'architecture-poster',
    prefix: '32',
    theme: 'architecture',
    title: 'OPEN SPACE',
    request: '创建一张 3:2 建筑海报，主体是山间美术馆，标题是 OPEN SPACE，强调入口透视和长阴影。先不要生成图片。'
  },
  {
    key: 'botanical-notes',
    prefix: '33',
    theme: 'botanical',
    title: 'FERN STUDY',
    request: '创建一张 4:5 植物笔记封面，主体是蕨类植物，标题是 FERN STUDY，枝叶自然不对称并带柔和自然光。先不要生成图片。'
  },
  {
    key: 'abstract-cover',
    prefix: '34',
    theme: 'abstract',
    title: 'FIELD NOTES',
    request: '创建一张 1:1 抽象封面，主体是几何拼贴，标题是 FIELD NOTES，强调切割色面、自由曲线和视觉重心。先不要生成图片。'
  },
  {
    key: 'product-speaker',
    prefix: '35',
    theme: 'product',
    title: 'SOFT SIGNAL',
    request: '创建一张 4:5 产品海报，主体是便携音箱，标题是 SOFT SIGNAL，强调织物材质、低矮落台和柔和轮廓光。先不要生成图片。'
  },
  {
    key: 'album-vinyl',
    prefix: '36',
    theme: 'album',
    title: 'ECHO FIELD',
    request: '创建一张 1:1 唱片封面，主体是黑胶唱片，标题是 ECHO FIELD，加入偏心轨道与细微声波。先不要生成图片。'
  },
  {
    key: 'coffee-campaign',
    prefix: '37',
    theme: 'coffee',
    title: 'MORNING RITUAL',
    request: '创建一张 4:5 咖啡海报，主体是陶瓷咖啡杯，标题是 MORNING RITUAL，保留杯碟、蒸汽和温暖晨间侧光。先不要生成图片。'
  },
  {
    key: 'landscape-cover',
    prefix: '38',
    theme: 'landscape',
    title: '山海之间',
    request: '创建一张 4:5 山海封面，主体是雾中远山与海面，标题是 山海之间，保留近中远景、细地平线与安静留白。先不要生成图片。'
  }
] as const

export type SemanticFixture = typeof SEMANTIC_FIXTURES[number]

export function deterministicFixtureIds(prefix: string): () => string {
  let value = 1
  return () => `${prefix}000000-0000-4000-8000-${String(value++).padStart(12, '0')}`
}

function summarize(scene: Scene): SceneSummary {
  return {
    revision: scene.revision,
    canvas: { ...scene.canvas },
    elementCount: scene.elements.length,
    relationCount: scene.relations.length,
    creativeBrief: scene.creativeContext?.brief ?? null,
    creativeContext: scene.creativeContext,
    elements: scene.elements.map((element) => ({
      id: element.id,
      type: element.type,
      name: element.name,
      description: element.description,
      semanticRole: element.semanticRole,
      zIndex: element.zIndex,
      groupId: element.groupId,
      ...(element.type === 'group' ? { childIds: [...element.childIds] } : {}),
      locked: element.locked,
      visible: element.visible,
      referencePolicy: element.referencePolicy,
      ...(element.controlIntent === undefined ? {} : { controlIntent: element.controlIntent }),
      ...(element.provenance === undefined ? {} : { provenance: element.provenance }),
      ...(element.type === 'text' ? { content: element.content, accuracy: element.accuracy, renderStrategy: element.renderStrategy, resultAssetId: element.resultAssetId } : {}),
      ...(element.type === 'placeholder' ? { subject: element.subject, visualKind: element.visualKind ?? 'generic' } : {}),
      ...(element.type === 'shape' ? { shapeRole: element.role, fill: element.fill } : {}),
      ...(element.type === 'light' ? { lightIntensity: element.intensity } : {}),
      transform: { ...element.transform }
    }))
  }
}

export function fixtureAgentRequest(scene: Scene, text: string, selectedElements: readonly SceneElement[] = []): AgentRequest {
  return {
    text,
    sceneSummary: summarize(scene),
    selectedIds: selectedElements.map((element) => element.id),
    selectedElements: [...selectedElements],
    attachments: selectedElements.map((element) => ({ kind: 'selection', id: element.id, name: element.name })),
    autoGenerate: false,
    ephemeralAnnotation: null,
    activeGenerationJobId: null
  }
}

export async function createSemanticFixtureScene(baseScene: Scene, fixture: SemanticFixture): Promise<{
  readonly scene: Scene
  readonly bus: CommandBus
  readonly batch: OperationBatch
  readonly plan: AgentPlan
  readonly nextId: () => string
}> {
  const nextId = deterministicFixtureIds(fixture.prefix)
  const planner = new DeterministicMockPlanner({ delayMs: 0, idFactory: nextId })
  const plan = await planner.plan(fixtureAgentRequest(baseScene, fixture.request), new AbortController().signal)
  const tool = plan.tools.find((candidate) => candidate.kind === 'scene_batch')
  if (tool?.kind !== 'scene_batch') throw new Error(`Fixture ${fixture.key} did not produce a Scene batch.`)
  const bus = new CommandBus(baseScene, { now: () => '2026-08-14T00:00:00.000Z' })
  const result = bus.execute({ id: nextId(), origin: 'agent', summary: tool.summary, commands: tool.commands })
  if (!result.ok) throw new Error(`${fixture.key}: ${result.error.message}`)
  return { scene: result.scene, bus, batch: result.batch, plan, nextId }
}
