import { createHash, randomUUID } from 'node:crypto'
import { authorCreativeBriefV3, creativeBriefV2Schema, creativeContextSchema, creativeDesignContractSchema, ELEMENT_SCHEMA_VERSION, reviseCreativeBriefToV3, scenePlanSchema, type CreativeBriefV2, type CreativeBriefV3, type CreativeContext, type CreativeDesignContract, type Scene, type SceneCommand, type SceneElement, type ScenePlan } from '../../domain'
import { agentPlanSchema, agentRequestSchema, type AgentPlan, type AgentRequest } from '../../shared/agent'
import type { AgentFailureEnvelope } from '../../shared/agent-recovery'
import { buildDesignContract } from './design-capability'
import { hasExplicitGenerationInstruction, hasNegatedGenerationInstruction } from './generation-policy'
import type { AgentObservableEvent } from '../../shared/agent-observability'

export interface AgentPlannerAttemptContext {
  readonly attempt: number
  readonly requestCorrelationId: string
  readonly deadlineAt: number
  readonly deadlineCode: 'PROVIDER_TOTAL_TIMEOUT' | 'BUDGET_WALL_TIME'
  readonly observe?: (event: AgentObservableEvent, delivery?: { readonly checkpoint: boolean }) => void | Promise<void>
}

export interface AgentPlanner {
  plan(
    request: AgentRequest,
    signal: AbortSignal,
    recovery?: AgentFailureEnvelope | null,
    context?: AgentPlannerAttemptContext
  ): Promise<AgentPlan>
}

export interface DeterministicMockPlannerOptions {
  readonly delayMs?: number
  readonly idFactory?: () => string
  readonly now?: () => string
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(signal.reason)
    }, { once: true })
  })
}

function derivedCriterionId(briefId: string, index: number, criterion: string): string {
  const hex = createHash('sha256').update(`${briefId}:${index}:${criterion}`).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

function base(id: string, type: SceneElement['type'], name: string, zIndex: number) {
  return {
    id,
    version: ELEMENT_SCHEMA_VERSION,
    type,
    name,
    description: '',
    zIndex,
    opacity: 1,
    blendMode: 'normal' as const,
    visible: true,
    locked: false,
    groupId: null,
    semanticRole: 'content',
    referencePolicy: 'include' as const,
    controlIntent: { kind: 'layout' as const, priority: 'prefer' as const, instruction: '保持该元素的语义位置与可编辑性', strength: .78 },
    provenance: { origin: 'agent-local' as const, sourceBriefId: null, sourceDirectionId: null, sourceAssetId: null }
  }
}

interface ParsedComposition {
  readonly aspectWidth: number
  readonly aspectHeight: number
  readonly sceneKind: string
  readonly subject: string
  readonly subjectPosition: 'center' | 'center-lower' | 'left-lower' | 'right-lower'
  readonly title: string | null
  readonly titlePosition: 'top' | 'top-left' | 'top-right'
  readonly backgroundColor: string
  readonly lightRequested: boolean
}

interface PlannedComposition {
  readonly brief: CreativeBriefV3
  readonly plan: ScenePlan
  readonly directions: CreativeContext['directions']
  readonly selectedDirectionId: string
}

function parseComposition(text: string): ParsedComposition {
  const aspect = text.match(/(\d{1,3})\s*[:：]\s*(\d{1,3})/)
  const aspectWidth = Math.max(1, Math.min(100, Number(aspect?.[1] ?? 4)))
  const aspectHeight = Math.max(1, Math.min(100, Number(aspect?.[2] ?? 5)))
  const titleMatch = text.match(/标题(?:是|为|写着|写成|写)?\s*[“"「『]?([^，。,.；;”"」』]{1,80})/i)
  const subjectPositionMatch = text.match(/(?:^|[，。,.；;]\s*)([^，。,.；;]{1,40}?)(?:放在?|位于|置于|在)(?:画面)?(?:的)?\s*(中央偏下|中间偏下|中央|中心|左下|左下方|右下|右下方)/)
    ?? text.match(/(?:^|[，。,.；;]\s*)([^，。,.；;]{1,40}?)(中央偏下|中间偏下|中央|中心|左下|左下方|右下|右下方)/)
  const explicitSubject = text.match(/(?:画面)?主体(?:是|为|写成)?\s*[“"「『]?([^，。,.；;”"」』]{1,60})/)
  const inferredSubject = /唱片|专辑/.test(text)
    ? '黑胶唱片'
    : /香水/.test(text)
      ? '香水瓶'
      : /咖啡/.test(text)
        ? '咖啡杯'
        : /人物|肖像|人像/.test(text)
          ? '人物'
          : /建筑/.test(text)
            ? '建筑主体'
            : /植物|花卉|花朵/.test(text)
              ? '植物主体'
              : '画面主体'
  const positionCopy = subjectPositionMatch?.[2] ?? ''
  const sceneKind = /唱片|专辑/.test(text)
    ? '唱片封面'
    : /封面/.test(text)
      ? '封面'
      : /海报/.test(text)
        ? '海报'
        : /广告/.test(text)
          ? '广告画面'
          : '构图'
  return {
    aspectWidth,
    aspectHeight,
    sceneKind,
    subject: (explicitSubject?.[1] ?? subjectPositionMatch?.[1] ?? inferredSubject).trim(),
    subjectPosition: /左下/.test(positionCopy)
      ? 'left-lower'
      : /右下/.test(positionCopy)
        ? 'right-lower'
        : /偏下/.test(positionCopy)
          ? 'center-lower'
          : 'center',
    title: titleMatch?.[1]?.trim() ?? null,
    titlePosition: /标题.*右上|右上.*标题/.test(text)
      ? 'top-right'
      : /标题.*左上|左上.*标题/.test(text)
        ? 'top-left'
        : 'top',
    backgroundColor: /浅色|明亮|白色|米白|暖白/.test(text)
      ? '#F1EFEA'
      : /暖色|夕阳|琥珀/.test(text)
        ? '#342820'
        : '#111722',
    lightRequested: /光|照明|背光|轮廓光|投影|雨夜|夜景|霓虹/.test(text)
  }
}

function outputSize(aspectWidth: number, aspectHeight: number): { readonly width: number; readonly height: number } {
  const longEdge = 1280
  if (aspectWidth >= aspectHeight) {
    return { width: longEdge, height: Math.max(64, Math.round(longEdge * aspectHeight / aspectWidth)) }
  }
  return { width: Math.max(64, Math.round(longEdge * aspectWidth / aspectHeight)), height: longEdge }
}

function themeFor(text: string): CreativeBriefV2['theme'] {
  if (/唱片|专辑|黑胶|音乐封面/.test(text)) return 'album'
  if (/咖啡|拿铁|浓缩|咖啡杯/.test(text)) return 'coffee'
  if (/山海|山水|海岸|海面|远山|湖面/.test(text)) return 'landscape'
  if (/人物|肖像|人像|模特/.test(text)) return 'portrait'
  if (/建筑|城市|空间|室内/.test(text)) return 'architecture'
  if (/植物|花卉|花朵|叶片|园艺/.test(text)) return 'botanical'
  if (/抽象|几何|拼贴/.test(text)) return 'abstract'
  if (/产品|商品|香水|器物/.test(text)) return 'product'
  return 'general'
}

function positionFor(value: ParsedComposition['subjectPosition']): CreativeBriefV2['subjects'][number]['position'] {
  if (value === 'left-lower') return 'bottom-left'
  if (value === 'right-lower') return 'bottom-right'
  if (value === 'center-lower') return 'bottom'
  return 'center'
}

function titlePositionFor(value: ParsedComposition['titlePosition']): CreativeBriefV2['text'][number]['position'] {
  return value
}

export function buildCreativePlan(request: AgentRequest, idFactory: () => string, createdAt = new Date().toISOString()): PlannedComposition {
  const composition = parseComposition(request.text)
  const output = outputSize(composition.aspectWidth, composition.aspectHeight)
  const briefId = idFactory()
  const planId = idFactory()
  const subjectBriefId = idFactory()
  const titleBriefId = composition.title === null ? null : idFactory()
  const theme = themeFor(request.text)
  const lightRequested = composition.lightRequested || theme !== 'general'
  const subjectBounds = composition.subjectPosition === 'left-lower'
    ? { x: 0.08, y: 0.45, width: 0.44, height: 0.46 }
    : composition.subjectPosition === 'right-lower'
      ? { x: 0.48, y: 0.45, width: 0.44, height: 0.46 }
      : composition.subjectPosition === 'center-lower'
        ? { x: 0.27, y: 0.43, width: 0.46, height: 0.48 }
        : { x: 0.25, y: 0.25, width: 0.5, height: 0.52 }
  const subjectDescription = ({
    portrait: '具有肩颈、身体重心与视线方向的人物编辑轮廓',
    architecture: '由前后体块、入口、地平线和透视轴组成的建筑空间',
    botanical: '由枝干动势、叶片疏密和自然不对称轮廓组成的植物结构',
    abstract: '由切割色面、漂浮几何与自由曲线形成的抽象视觉重心',
    product: `${composition.subject}的主题专属产品轮廓、落台关系和材质边缘`,
    album: '由唱片圆盘、中心标、声波与封套关系组成的音乐封面主体',
    coffee: '由杯体、杯碟、蒸汽手势和桌面投影组成的咖啡场景',
    landscape: '由近景水面、中景山体、远景雾层与地平线组成的山海层次',
    general: `${composition.subject}的主题中性构图轮廓，不预设为任何具体商品`
  } satisfies Record<CreativeBriefV2['theme'], string>)[theme]
  const subjectFrame = theme === 'portrait'
    ? 'portrait'
    : ['botanical', 'abstract', 'landscape'].includes(theme)
      ? 'free'
      : ['album', 'coffee'].includes(theme)
        ? 'ellipse'
        : 'rectangle'
  const titlePosition = composition.titlePosition === 'top-left'
    ? { x: 0.08, y: 0.07, width: 0.62, height: 0.13 }
    : composition.titlePosition === 'top-right'
      ? { x: 0.3, y: 0.07, width: 0.62, height: 0.13 }
      : { x: 0.12, y: 0.07, width: 0.76, height: 0.13 }
  const mood = [
    /安静|克制|柔和/.test(request.text) ? '安静克制' : '方向明确',
    /雨夜|夜景|深色/.test(request.text) ? '低照度' : /明亮|浅色|白色/.test(request.text) ? '明亮通透' : '柔和层次'
  ]
  const palette = composition.backgroundColor === '#F1EFEA'
    ? ['#F1EFEA', '#64768A', '#2A3037']
    : composition.backgroundColor === '#342820'
      ? ['#342820', '#C39267', '#F0D1A9']
      : ['#111722', '#355275', '#A7C9F4']
  const hasExplicitAspect = /\d{1,3}\s*[:：]\s*\d{1,3}/.test(request.text)
  const precision = hasExplicitAspect && theme !== 'general' ? 'precise' : 'ambiguous'
  const keep = [...request.text.matchAll(/保留([^，。,.；;]{1,80})/g)].map((match) => match[1]!.trim())
  const prohibitions = [...request.text.matchAll(/(?:不要|禁止|避免)([^，。,.；;]{1,80})/g)].map((match) => match[1]!.trim())
  const ambiguities = [
    ...(!hasExplicitAspect ? [{ id: idFactory(), topic: '画布比例', question: '未指定比例，推荐方向将使用内容友好的默认比例。', impact: 'high' as const }] : []),
    ...(theme === 'general' ? [{ id: idFactory(), topic: '主题', question: '主体类别仍然模糊，将保留中性、可逆的草图表达。', impact: 'high' as const }] : []),
    ...(composition.title === null ? [{ id: idFactory(), topic: '文字', question: '未指定固定标题，不擅自添加品牌或文案。', impact: 'medium' as const }] : [])
  ]
  const briefV2 = creativeBriefV2Schema.parse({
    version: 2,
    id: briefId,
    originalRequirement: request.text,
    purpose: `用于${composition.sceneKind}的可编辑视觉方向探索`,
    intent: `建立可编辑的${composition.sceneKind}语义草图`,
    theme,
    media: ['结构化本地草图', composition.sceneKind],
    mood,
    usage: composition.sceneKind,
    aspectPreference: { width: composition.aspectWidth, height: composition.aspectHeight },
    subjects: [{ id: subjectBriefId, name: composition.subject, description: subjectDescription, pose: composition.subjectPosition.includes('lower') ? '重心位于画面下部' : '视觉重心居中', position: positionFor(composition.subjectPosition), prominence: 'primary' }],
    text: titleBriefId === null || composition.title === null ? [] : [{ id: titleBriefId, content: composition.title, role: 'title', style: '轻盈、克制、留有呼吸感；占位字体和字号仅作参考', accuracy: 'balanced', mode: 'reference', visualWeight: 'secondary', position: titlePositionFor(composition.titlePosition) }],
    composition: titleBriefId === null ? [] : [{
      kind: 'above',
      sourceId: titleBriefId,
      targetId: subjectBriefId,
      description: '标题位于主体上方的留白区域'
    }],
    compositionNotes: [
      `主体位于${positionFor(composition.subjectPosition)}`,
      composition.title === null ? '不擅自添加固定文案' : `标题保持在${titlePositionFor(composition.titlePosition)}`,
      '所有主要视觉组件保持独立可选择和移动'
    ],
    style: mood,
    palette,
    lighting: lightRequested ? [{ description: '用于建立主体层次的柔和方向光', color: /暖|夕阳|琥珀/.test(request.text) ? '#FFD2A1' : '#A7C9F4', direction: 24, intensity: .68, softness: .86 }] : [],
    keep,
    prohibitions,
    constraints: ['不显示编辑器控制点或占位标签', '保持所有主要对象可独立选择和移动'],
    ambiguities,
    precision,
    generationIntent: hasNegatedGenerationInstruction(request.text) ? 'none' : hasExplicitGenerationInstruction(request.text) ? 'final' : 'ask'
  })
  const audience = [...request.text.matchAll(/(?:面向|受众(?:是|为)?)[：:\s]*([^，。,.；;]{1,120})/g)]
    .map((match) => match[1]!.trim())
    .filter(Boolean)
    .slice(0, 20)
  const acceptanceCriteria = [
    ...(hasExplicitAspect ? [{ criterion: `画布比例保持 ${composition.aspectWidth}:${composition.aspectHeight}`, priority: 'must' as const }] : []),
    { criterion: `主体“${composition.subject}”保留独立可编辑元素`, priority: 'must' as const },
    ...(composition.title === null ? [] : [{ criterion: `“${composition.title}”作为排版与字效参考，不默认压过主体`, priority: 'prefer' as const }]),
    ...keep.map((item) => ({ criterion: `保留${item}`, priority: 'must' as const })),
    ...prohibitions.map((item) => ({ criterion: `避免${item}`, priority: 'must' as const }))
  ].slice(0, 100).map((criterion, index) => ({
    ...criterion,
    id: derivedCriterionId(briefId, index, criterion.criterion)
  }))
  const explicitSources = [
    { path: '/originalRequirement', source: 'user' as const, sourceId: null, evidence: request.text },
    ...(hasExplicitAspect ? [{ path: '/aspectPreference', source: 'user' as const, sourceId: null, evidence: request.text }] : []),
    { path: '/subjects', source: 'user' as const, sourceId: null, evidence: request.text },
    ...(composition.title === null ? [] : [{ path: '/text', source: 'user' as const, sourceId: null, evidence: request.text }]),
    ...(keep.length === 0 ? [] : [{ path: '/keep', source: 'user' as const, sourceId: null, evidence: request.text }]),
    ...(prohibitions.length === 0 ? [] : [{ path: '/prohibitions', source: 'user' as const, sourceId: null, evidence: request.text }]),
    ...(audience.length === 0 ? [] : [{ path: '/audience', source: 'user' as const, sourceId: null, evidence: request.text }])
  ]
  const brief = authorCreativeBriefV3({
    brief: briefV2,
    id: briefId,
    createdAt,
    supersedesId: null,
    audience,
    acceptanceCriteria,
    defaultEvidence: request.text,
    fieldSources: explicitSources
  })
  const designContract = buildDesignContract(brief, idFactory)
  const selectedDirectionId = designContract.selectedDirectionId
  const elements: ScenePlan['elements'][number][] = []
  const add = (element: Omit<ScenePlan['elements'][number], 'zIntent' | 'controlIntent' | 'provenance'> & {
    readonly controlIntent?: ScenePlan['elements'][number]['controlIntent']
  }): string => {
    elements.push({
      ...element,
      zIntent: elements.length,
      controlIntent: element.controlIntent ?? { kind: element.type === 'text' ? 'style' : element.type === 'light' ? 'lighting' : element.semanticRole === 'subject' ? 'subject' : 'layout', priority: element.type === 'text' ? 'guide' : element.semanticRole === 'subject' ? 'must' : 'prefer', instruction: element.semanticDescription, strength: element.type === 'sketch' ? .56 : element.type === 'text' ? .68 : .86 },
      provenance: { origin: 'agent-local', sourceBriefId: element.sourceBriefId, sourceDirectionId: selectedDirectionId, sourceAssetId: null }
    })
    return element.id
  }
  const backgroundId = add({
    id: idFactory(), sourceBriefId: null, type: 'shape', name: '背景基底', semanticDescription: `为${composition.sceneKind}建立的整体底色`, semanticRole: 'background', layerGroup: 'environment', locked: false,
    normalizedBounds: { x: 0, y: 0, width: 1, height: 1 }, rotation: 0, relations: [], generationPolicy: 'local',
    visualTreatment: { shape: 'rectangle', fill: composition.backgroundColor, stroke: null, strokeWidth: 0, cornerRadius: 0, role: 'final' }
  })
  const accentSpecs: Record<CreativeBriefV2['theme'], readonly { name: string; role: string; layerGroup: 'environment' | 'subjects'; shape: 'rectangle' | 'ellipse' | 'line'; bounds: { x: number; y: number; width: number; height: number }; rotation: number; opacity: number }[]> = {
    product: [
      { name: '产品落台', role: 'product-stage', layerGroup: 'environment', shape: 'ellipse', bounds: { x: .16, y: .7, width: .68, height: .13 }, rotation: 0, opacity: .38 },
      { name: '产品结构细节', role: 'product-detail', layerGroup: 'subjects', shape: 'rectangle', bounds: { x: .37, y: .48, width: .26, height: .12 }, rotation: 0, opacity: .32 }
    ],
    portrait: [{ name: '人物裁切色面', role: 'portrait-crop', layerGroup: 'subjects', shape: 'rectangle', bounds: { x: .06, y: .18, width: .44, height: .66 }, rotation: -3, opacity: .22 }, { name: '视线留白边界', role: 'portrait-gaze-space', layerGroup: 'environment', shape: 'line', bounds: { x: .5, y: .42, width: .4, height: .02 }, rotation: -4, opacity: .44 }],
    architecture: [{ name: '建筑基座', role: 'architecture-ground', layerGroup: 'environment', shape: 'rectangle', bounds: { x: .08, y: .68, width: .84, height: .13 }, rotation: 0, opacity: .38 }, { name: '入口体块', role: 'architecture-entry', layerGroup: 'subjects', shape: 'rectangle', bounds: { x: .42, y: .48, width: .16, height: .3 }, rotation: 0, opacity: .3 }],
    botanical: [{ name: '叶簇一', role: 'botanical-leaf', layerGroup: 'subjects', shape: 'ellipse', bounds: { x: .12, y: .38, width: .24, height: .14 }, rotation: -28, opacity: .3 }, { name: '叶簇二', role: 'botanical-leaf', layerGroup: 'subjects', shape: 'ellipse', bounds: { x: .58, y: .3, width: .25, height: .14 }, rotation: 24, opacity: .26 }],
    abstract: [{ name: '切割色面', role: 'abstract-plane', layerGroup: 'subjects', shape: 'rectangle', bounds: { x: .08, y: .23, width: .44, height: .28 }, rotation: -12, opacity: .42 }, { name: '漂浮圆', role: 'abstract-orbit', layerGroup: 'subjects', shape: 'ellipse', bounds: { x: .58, y: .52, width: .28, height: .28 }, rotation: 0, opacity: .3 }],
    album: [{ name: '唱片圆盘', role: 'album-disc', layerGroup: 'subjects', shape: 'ellipse', bounds: { x: .2, y: .28, width: .58, height: .58 }, rotation: 0, opacity: .42 }, { name: '中心标', role: 'album-label', layerGroup: 'subjects', shape: 'ellipse', bounds: { x: .42, y: .5, width: .14, height: .14 }, rotation: 0, opacity: .56 }],
    coffee: [
      { name: '杯碟', role: 'coffee-saucer', layerGroup: 'subjects', shape: 'ellipse', bounds: { x: .23, y: .68, width: .54, height: .12 }, rotation: 0, opacity: .38 },
      { name: '杯柄', role: 'coffee-handle', layerGroup: 'subjects', shape: 'ellipse', bounds: { x: .61, y: .49, width: .19, height: .2 }, rotation: 0, opacity: .3 },
      { name: '桌面边界', role: 'coffee-table', layerGroup: 'environment', shape: 'line', bounds: { x: .08, y: .8, width: .84, height: .02 }, rotation: 0, opacity: .52 }
    ],
    landscape: [{ name: '远山层', role: 'landscape-far', layerGroup: 'subjects', shape: 'ellipse', bounds: { x: .08, y: .38, width: .84, height: .3 }, rotation: 0, opacity: .18 }, { name: '水面层', role: 'landscape-water', layerGroup: 'subjects', shape: 'rectangle', bounds: { x: .04, y: .66, width: .92, height: .2 }, rotation: 0, opacity: .28 }],
    general: [{ name: '中性留白色面', role: 'editorial-space', layerGroup: 'subjects', shape: 'rectangle', bounds: { x: .08, y: .19, width: .48, height: .62 }, rotation: -5, opacity: .18 }]
  }
  const accentIds = accentSpecs[theme].map((spec) => add({
    id: idFactory(), sourceBriefId: null, type: 'shape', name: spec.name, semanticDescription: `${spec.name}用于建立${theme}主题的结构差异`, semanticRole: spec.role, layerGroup: spec.layerGroup, locked: false,
    normalizedBounds: spec.bounds, rotation: spec.rotation, relations: [], generationPolicy: 'local',
    visualTreatment: { shape: spec.shape, fill: palette[1], stroke: palette[2], strokeWidth: spec.shape === 'line' ? .006 : .002, cornerRadius: .035, role: 'placeholder', opacity: spec.opacity }
  }))
  add({
    id: idFactory(), sourceBriefId: null, type: 'sketch', name: ({ portrait: '姿态轴线', architecture: '透视轴线', botanical: '枝叶动势', abstract: '构成轨迹', product: '产品轮廓线', album: '声波轨迹', coffee: '蒸汽手势', landscape: '山海轮廓', general: '构图手势' } as const)[theme],
    semanticDescription: `表达${theme}主题的视觉动势、空间轴线与叙事方向`, semanticRole: `${theme}-guide`, layerGroup: 'guides', locked: false,
    normalizedBounds: { x: .04, y: .14, width: .92, height: .72 }, rotation: 0, relations: [], generationPolicy: 'local',
    visualTreatment: { theme, color: palette[2], width: .012, opacity: .66, fidelity: .62, finalVisible: false }
  })
  const subjectId = add({
    id: idFactory(), sourceBriefId: subjectBriefId, type: 'placeholder', name: composition.subject, semanticDescription: subjectDescription, semanticRole: 'subject', layerGroup: 'subjects', locked: false,
    normalizedBounds: theme === 'landscape' ? { x: .1, y: .32, width: .8, height: .48 } : subjectBounds, rotation: theme === 'botanical' ? -3 : 0,
    relations: [{ id: idFactory(), kind: 'in-front-of', targetElementId: accentIds[0] ?? backgroundId, description: '主体位于主题结构前方并保留可解释遮挡' }], generationPolicy: 'local',
    visualTreatment: { subject: composition.subject, pose: composition.subjectPosition.includes('lower') ? '位于画面下部' : '位于画面中心区域', facing: theme === 'portrait' ? '视线略偏向留白' : '', allowOverflow: theme === 'landscape', transparentBackground: true, frameShape: subjectFrame, visualKind: theme === 'general' ? 'generic' : theme, generationNotes: subjectDescription }
  })
  if (lightRequested) add({
    id: idFactory(), sourceBriefId: null, type: 'light', name: theme === 'coffee' ? '晨间侧光' : theme === 'landscape' ? '雾层环境光' : '构图光影', semanticDescription: '根据 Brief 建立的独立方向光和阴影边界', semanticRole: 'lighting', layerGroup: 'lighting', locked: false,
    normalizedBounds: { x: .2, y: .13, width: .62, height: .66 }, rotation: 0, relations: [{ id: idFactory(), kind: 'illuminates', targetElementId: subjectId, description: '光影建立主体轮廓与空间层次' }], generationPolicy: 'local',
    visualTreatment: { direction: 24, color: /暖|夕阳|琥珀|晨/.test(request.text) || theme === 'coffee' ? '#FFD2A1' : '#A7C9F4', intensity: .68, softness: .86, range: .92, targetElementIds: [subjectId] }
  })
  if (titleBriefId !== null && composition.title !== null) add({
    id: idFactory(), sourceBriefId: titleBriefId, type: 'text', name: '主标题', semanticDescription: `${composition.sceneKind}的标题内容、区域与字效方向参考；占位字形不是最终形态`, semanticRole: 'title', layerGroup: 'typography', normalizedBounds: titlePosition,
    locked: false, rotation: 0, relations: [{ id: idFactory(), kind: 'above', targetElementId: subjectId, description: '标题位于主体上方的留白区' }], generationPolicy: 'local',
    controlIntent: { kind: 'style', priority: 'guide', instruction: `“${composition.title}”提供内容、区域和层级参考；重新设计字形与尺度，保持轻盈留白，除非用户明确要求不要做成主视觉大字`, strength: .68 },
    visualTreatment: { content: composition.title, orientation: 'horizontal', align: composition.titlePosition === 'top-left' ? 'start' : composition.titlePosition === 'top-right' ? 'end' : 'center', wrapping: 'word', fontFamily: 'Segoe UI Variable', fontSize: 48, fontWeight: 400, fill: composition.backgroundColor === '#F1EFEA' ? '#202329' : '#F3F3F0', stroke: null, strokeWidth: 0, shadowColor: null, shadowBlur: 0, letterSpacing: 6, lineHeight: 1.1, accuracy: 'balanced', visualWeight: 'secondary', styleDescription: '轻盈、克制、留有呼吸感；占位字体与字号不是最终形态', renderStrategy: 'standard', resultAssetId: null }
  })
  const plan = scenePlanSchema.parse({
    version: 1, id: planId, briefId, directionId: selectedDirectionId, capabilityPackIds: designContract.capabilityPackIds,
    canvas: { aspectWidth: composition.aspectWidth, aspectHeight: composition.aspectHeight, outputWidth: output.width, outputHeight: output.height, backgroundColor: composition.backgroundColor, transparent: false, globalStyle: `${mood.join('，')}；${request.text}`.slice(0, 4000) },
    elements
  })
  return creativeContextSchema.parse({ brief, directions: designContract.directions, selectedDirectionId, plan }) as PlannedComposition
}

export function compileCreativeLayoutCommands(request: AgentRequest, idFactory: () => string): readonly SceneCommand[] {
  const creativeContext = buildCreativePlan(request, idFactory)
  return compileCreativeContextCommands(request.sceneSummary.elements, creativeContext, idFactory)
}

function storedDirectionBaseBounds(element: ScenePlan['elements'][number]): ScenePlan['elements'][number]['normalizedBounds'] {
  const stored = element.visualTreatment.directionBaseBounds
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return element.normalizedBounds
  const candidate = stored as Record<string, unknown>
  const bounds = {
    x: Number(candidate.x),
    y: Number(candidate.y),
    width: Number(candidate.width),
    height: Number(candidate.height)
  }
  return Object.values(bounds).every((value) => Number.isFinite(value))
    && bounds.x >= 0 && bounds.y >= 0 && bounds.width > 0 && bounds.height > 0
    && bounds.x + bounds.width <= 1.000_001 && bounds.y + bounds.height <= 1.000_001
      ? bounds
      : element.normalizedBounds
}

function insetBounds(
  bounds: ScenePlan['elements'][number]['normalizedBounds'],
  scale: number
): ScenePlan['elements'][number]['normalizedBounds'] {
  const width = Math.min(.9, Math.max(.04, bounds.width * scale))
  const height = Math.min(.86, Math.max(.04, bounds.height * scale))
  const centerX = bounds.x + bounds.width / 2
  const centerY = bounds.y + bounds.height / 2
  return {
    x: Math.max(.04, Math.min(.96 - width, centerX - width / 2)),
    y: Math.max(.06, Math.min(.94 - height, centerY - height / 2)),
    width,
    height
  }
}

function directionBounds(
  element: ScenePlan['elements'][number],
  baseBounds: ScenePlan['elements'][number]['normalizedBounds'],
  directionIndex: number
): ScenePlan['elements'][number]['normalizedBounds'] {
  if (directionIndex === 0 || element.semanticRole === 'background') return baseBounds
  if (directionIndex === 1) {
    if (element.semanticRole === 'subject') return { x: .08, y: .42, width: .46, height: .44 }
    if (element.semanticRole === 'title') return { x: .54, y: .12, width: .38, height: Math.min(.22, baseBounds.height) }
    if (element.type === 'light') return { x: .1, y: .12, width: .58, height: .7 }
    if (element.layerGroup === 'subjects') {
      const mirroredX = 1 - baseBounds.x - baseBounds.width
      return { ...baseBounds, x: Math.max(.04, Math.min(.96 - baseBounds.width, mirroredX)) }
    }
    return baseBounds
  }
  if (element.semanticRole === 'subject') return { x: .18, y: .18, width: .76, height: .7 }
  if (element.semanticRole === 'title') return { x: .08, y: .1, width: .32, height: Math.min(.18, baseBounds.height) }
  if (element.type === 'light') return { x: .22, y: .08, width: .7, height: .78 }
  if (element.layerGroup === 'subjects') return insetBounds(baseBounds, 1.24)
  return baseBounds
}

export function selectCreativeDirection(
  creativeContextInput: CreativeContext,
  directionId: string,
  idFactory: () => string
): CreativeContext {
  const creativeContext = creativeContextSchema.parse(creativeContextInput)
  const directions = creativeContext.directions
  if (directions === undefined) throw Object.assign(new Error('The current creative context has no selectable directions.'), { code: 'DIRECTION_NOT_FOUND' })
  const directionIndex = directions.findIndex((direction) => direction.id === directionId && direction.briefId === creativeContext.brief.id)
  if (directionIndex < 0) throw Object.assign(new Error('The selected direction does not belong to the current Creative Brief.'), { code: 'DIRECTION_NOT_FOUND' })
  const direction = directions[directionIndex]!
  const elements = creativeContext.plan.elements.map((element) => {
    const baseBounds = storedDirectionBaseBounds(element)
    const treatment: Record<string, unknown> = {
      ...element.visualTreatment,
      directionBaseBounds: baseBounds,
      directionTitle: direction.title
    }
    if (element.type === 'text') {
      treatment.visualWeight = directionIndex === 2 ? 'whisper' : 'secondary'
      treatment.fontSize = directionIndex === 2 ? 34 : Number(treatment.fontSize)
      treatment.letterSpacing = directionIndex === 1 ? 8 : Number(treatment.letterSpacing)
    }
    if (element.type === 'light') {
      treatment.direction = directionIndex === 1 ? -34 : directionIndex === 2 ? 58 : Number(treatment.direction)
      treatment.intensity = directionIndex === 2 ? Math.min(.82, Number(treatment.intensity) + .08) : Number(treatment.intensity)
    }
    return {
      ...element,
      normalizedBounds: directionBounds(element, baseBounds, directionIndex),
      provenance: {
        origin: element.provenance?.origin ?? 'agent-local',
        sourceBriefId: element.sourceBriefId,
        sourceDirectionId: direction.id,
        sourceAssetId: element.provenance?.sourceAssetId ?? null
      },
      visualTreatment: treatment
    }
  })
  const plan = scenePlanSchema.parse({
    ...creativeContext.plan,
    id: idFactory(),
    directionId: direction.id,
    canvas: {
      ...creativeContext.plan.canvas,
      globalStyle: `${creativeContext.brief.mood.join('，')}；方向：${direction.title}；${direction.difference}`.slice(0, 4_000)
    },
    elements
  })
  return creativeContextSchema.parse({
    ...creativeContext,
    selectedDirectionId: direction.id,
    plan
  })
}

function compileCreativeContextCommands(
  existingElements: readonly Pick<SceneElement, 'id' | 'groupId'>[],
  creativeContext: PlannedComposition,
  idFactory: () => string,
  removableRootIds: ReadonlySet<string> | null = null
): readonly SceneCommand[] {
  const commands: SceneCommand[] = existingElements
    .filter((element) => element.groupId === null && (removableRootIds === null || removableRootIds.has(element.id)))
    .map((element) => ({ kind: 'element.remove', elementId: element.id }))
  commands.push({ kind: 'scene.set-creative-context', creativeContext })
  commands.push({
    kind: 'scene.set-canvas',
    canvas: creativeContext.plan.canvas
  })
  const planElements = [...creativeContext.plan.elements].sort((left, right) => left.zIntent - right.zIntent)
  for (const planned of planElements) {
    const common = {
      ...base(planned.id, planned.type, planned.name, planned.zIntent),
      description: planned.semanticDescription,
      transform: { ...planned.normalizedBounds, rotation: planned.rotation },
      semanticRole: planned.semanticRole,
      referencePolicy: planned.type === 'sketch' || (planned.type === 'shape' && planned.visualTreatment.role === 'placeholder') ? 'reference-only' as const : 'include' as const,
      locked: planned.locked,
      ...(planned.controlIntent === undefined ? {} : { controlIntent: planned.controlIntent }),
      ...(planned.provenance === undefined ? {} : { provenance: planned.provenance }),
      ...(typeof planned.visualTreatment.opacity === 'number' ? { opacity: planned.visualTreatment.opacity } : {})
    }
    const treatment = planned.visualTreatment
    let element: SceneElement
    if (planned.type === 'shape') element = { ...common, type: 'shape', shape: treatment.shape as 'rectangle' | 'ellipse' | 'line', fill: String(treatment.fill), stroke: treatment.stroke === null ? null : String(treatment.stroke), strokeWidth: Number(treatment.strokeWidth), cornerRadius: Number(treatment.cornerRadius), role: treatment.role as 'final' | 'placeholder' }
    else if (planned.type === 'sketch') {
      const theme = String(treatment.theme)
      const points = theme === 'architecture'
        ? [{ x: .04, y: .8 }, { x: .47, y: .34 }, { x: .96, y: .8 }, { x: .47, y: .34 }, { x: .49, y: .02 }]
        : theme === 'botanical'
          ? [{ x: .08, y: .9 }, { x: .28, y: .58 }, { x: .42, y: .67 }, { x: .54, y: .34 }, { x: .72, y: .46 }, { x: .9, y: .1 }]
          : theme === 'portrait'
            ? [{ x: .38, y: .08 }, { x: .48, y: .28 }, { x: .43, y: .53 }, { x: .62, y: .78 }, { x: .72, y: .94 }]
            : theme === 'album'
              ? [{ x: .08, y: .5 }, { x: .2, y: .42 }, { x: .32, y: .6 }, { x: .44, y: .35 }, { x: .58, y: .66 }, { x: .72, y: .4 }, { x: .92, y: .5 }]
              : theme === 'coffee'
                ? [{ x: .38, y: .88 }, { x: .45, y: .68 }, { x: .38, y: .5 }, { x: .58, y: .32 }, { x: .5, y: .1 }]
                : theme === 'landscape'
                  ? [{ x: .02, y: .62 }, { x: .19, y: .45 }, { x: .34, y: .6 }, { x: .52, y: .34 }, { x: .71, y: .56 }, { x: .98, y: .42 }]
                  : theme === 'product'
                    ? [{ x: .3, y: .82 }, { x: .34, y: .34 }, { x: .5, y: .18 }, { x: .66, y: .34 }, { x: .7, y: .82 }]
                    : [{ x: .04, y: .78 }, { x: .24, y: .48 }, { x: .51, y: .6 }, { x: .76, y: .3 }, { x: .94, y: .16 }]
      element = { ...common, type: 'sketch', strokes: [{ id: idFactory(), points, color: String(treatment.color), width: Number(treatment.width), opacity: Number(treatment.opacity) }], fidelity: Number(treatment.fidelity), finalVisible: Boolean(treatment.finalVisible) }
    } else if (planned.type === 'light') element = { ...common, type: 'light', direction: Number(treatment.direction), color: String(treatment.color), intensity: Number(treatment.intensity), softness: Number(treatment.softness), range: Number(treatment.range), targetElementIds: treatment.targetElementIds as string[] }
    else if (planned.type === 'placeholder') element = { ...common, type: 'placeholder', subject: String(treatment.subject), pose: String(treatment.pose), facing: String(treatment.facing), allowOverflow: Boolean(treatment.allowOverflow), transparentBackground: Boolean(treatment.transparentBackground), frameShape: treatment.frameShape as 'rectangle' | 'ellipse' | 'portrait' | 'free', visualKind: treatment.visualKind as Extract<SceneElement, { type: 'placeholder' }>['visualKind'], generationNotes: String(treatment.generationNotes) }
    else element = { ...common, type: 'text', content: String(treatment.content), orientation: treatment.orientation as 'horizontal' | 'vertical', align: treatment.align as 'start' | 'center' | 'end' | 'justify', wrapping: treatment.wrapping as 'none' | 'word' | 'character', fontFamily: String(treatment.fontFamily), fontSize: Number(treatment.fontSize), fontWeight: Number(treatment.fontWeight), fill: String(treatment.fill), stroke: treatment.stroke === null ? null : String(treatment.stroke), strokeWidth: Number(treatment.strokeWidth), shadowColor: treatment.shadowColor === null ? null : String(treatment.shadowColor), shadowBlur: Number(treatment.shadowBlur), letterSpacing: Number(treatment.letterSpacing), lineHeight: Number(treatment.lineHeight), accuracy: treatment.accuracy as 'strict' | 'balanced' | 'expressive', visualWeight: (treatment.visualWeight ?? 'secondary') as 'whisper' | 'secondary' | 'primary' | 'hero', styleDescription: String(treatment.styleDescription), renderStrategy: treatment.renderStrategy as 'standard' | 'ai-material' | 'ai-complete' | 'editable-overlay', resultAssetId: null }
    commands.push({ kind: 'element.add', element })
  }
  const subjectAssemblyIds = planElements
    .filter((planned) => planned.layerGroup === 'subjects')
    .map((planned) => planned.id)
  if (subjectAssemblyIds.length >= 2) {
    const groupId = idFactory()
    const groupName = ({
      product: '产品主体组',
      portrait: '人物主体组',
      architecture: '建筑主体组',
      botanical: '植物主体组',
      abstract: '抽象构成组',
      album: '唱片主体组',
      coffee: '咖啡杯组',
      landscape: '景深层次组',
      general: '主体构成组'
    } satisfies Record<CreativeBriefV2['theme'], string>)[creativeContext.brief.theme]
    commands.push({
      kind: 'element.group',
      elementIds: subjectAssemblyIds,
      group: {
        ...base(groupId, 'group', groupName, 0),
        type: 'group',
        description: '需要整体控制、也允许进入组内编辑的浅层语义组件',
        transform: { x: 0, y: 0, width: 1, height: 1, rotation: 0 },
        semanticRole: 'subject-assembly',
        childIds: subjectAssemblyIds,
        controlIntent: { kind: 'group', priority: 'prefer', instruction: '保持主体组件整体关系，同时允许每个子元素独立修改', strength: .9 }
      }
    })
  }
  for (const planned of planElements) {
    for (const relation of planned.relations) {
      commands.push({ kind: 'relation.add', relation: { id: relation.id, type: relation.kind, sourceElementId: planned.id, targetElementId: relation.targetElementId, description: relation.description } })
    }
  }
  return commands
}

export function compileCreativeContextReplacementCommands(
  scene: Scene,
  creativeContext: CreativeContext,
  removableRootIds: ReadonlySet<string>,
  idFactory: () => string
): readonly SceneCommand[] {
  const parsed = creativeContextSchema.parse(creativeContext) as PlannedComposition
  return compileCreativeContextCommands(scene.elements, parsed, idFactory, removableRootIds)
}

function selectionCommands(request: AgentRequest, idFactory: () => string): { readonly summary: string; readonly commands: readonly SceneCommand[] } | null {
  const selected = request.selectedElements.filter((element) => request.selectedIds.includes(element.id))
  if (selected.length === 0) return null
  if (/删除|移除/.test(request.text)) {
    return {
      summary: `删除 ${selected.length} 个选中元素`,
      commands: selected.filter((element) => element.groupId === null).map((element) => ({
        kind: 'element.remove' as const,
        elementId: element.id
      }))
    }
  }
  if (/组合|成组/.test(request.text) && selected.length >= 2) {
    const groupId = idFactory()
    return {
      summary: `组合 ${selected.length} 个选中元素`,
      commands: [{
        kind: 'element.group',
        elementIds: selected.map((element) => element.id),
        group: {
          ...base(groupId, 'group', 'Agent 组合', 0),
          type: 'group',
          transform: { x: 0, y: 0, width: 1, height: 1, rotation: 0 },
          semanticRole: 'composition',
          childIds: selected.map((element) => element.id)
        }
      }]
    }
  }
  const commands: SceneCommand[] = []
  for (const element of selected) {
    if (/置顶|移到最上|顶层/.test(request.text)) {
      commands.push({ kind: 'element.reorder', elementId: element.id, toIndex: Math.max(0, request.sceneSummary.elementCount - 1) })
      continue
    }
    if (/置底|移到最下|底层/.test(request.text)) {
      commands.push({ kind: 'element.reorder', elementId: element.id, toIndex: 0 })
      continue
    }
    if (/上移一层/.test(request.text)) {
      commands.push({ kind: 'element.reorder', elementId: element.id, toIndex: Math.min(request.sceneSummary.elementCount - 1, element.zIndex + 1) })
      continue
    }
    if (/下移一层/.test(request.text)) {
      commands.push({ kind: 'element.reorder', elementId: element.id, toIndex: Math.max(0, element.zIndex - 1) })
      continue
    }
    const transform = { ...element.transform }
    if (/左移|向左/.test(request.text)) transform.x = Math.max(-4, transform.x - 0.08)
    if (/右移|向右/.test(request.text)) transform.x = Math.min(4, transform.x + 0.08)
    if (/上移|向上/.test(request.text)) transform.y = Math.max(-4, transform.y - 0.06)
    if (/下移|向下/.test(request.text)) transform.y = Math.min(4, transform.y + 0.06)
    const asksToEnlargeThisElement = /放大|大一点/.test(request.text) || (
      element.type === 'text' && /(?:标题.*更大|更大.*标题)/.test(request.text)
    )
    if (asksToEnlargeThisElement) {
      transform.width = Math.min(4, transform.width * 1.12)
      transform.height = Math.min(4, transform.height * 1.12)
    }
    if (/缩小|小一点/.test(request.text)) {
      transform.width *= 0.9
      transform.height *= 0.9
    }
    const changes: Record<string, unknown> = { transform }
    if (element.type === 'text' && /更厚|粗一点|加粗/.test(request.text)) {
      changes.styleDescription = `${element.styleDescription}，字形更厚重，保持原文字准确`
    }
    commands.push({ kind: 'element.update', elementId: element.id, changes })
  }
  return { summary: `调整 ${selected.length} 个选中元素`, commands }
}

function buildRevisedCreativeContext(request: AgentRequest, idFactory: () => string, createdAt: string): CreativeContext | null {
  const current = request.sceneSummary.creativeContext
  if (current === null || current === undefined) return null
  const revision = request.text.replace(/^\s*(?:修正|修改|更新)当前创作简报[：:]\s*/u, '').trim()
  if (revision.length === 0) return null
  const prior = current.brief
  const priorAcceptance = prior.version === 3 ? prior.acceptanceCriteria : []
  const audiences = [...revision.matchAll(/(?:面向|受众(?:是|为)?)[：:\s]*([^，。,.；;]{1,120})/g)]
    .map((match) => match[1]!.trim())
    .filter(Boolean)
    .slice(0, 20)
  const addedKeep = [...revision.matchAll(/保留([^，。,.；;]{1,80})/g)].map((match) => match[1]!.trim())
  const addedProhibitions = [...revision.matchAll(/(?:不要|禁止|避免)([^，。,.；;]{1,80})/g)].map((match) => match[1]!.trim())
  const currentKeep = prior.version === 1 ? prior.constraints : prior.keep
  const currentProhibitions = prior.version === 1 ? [] : prior.prohibitions
  const revisionPriority: 'must' | 'prefer' = /必须|不要|禁止|保留|准确/u.test(revision) ? 'must' : 'prefer'
  const changes: Parameters<typeof reviseCreativeBriefToV3>[1]['changes'] = {
    originalRequirement: `${prior.originalRequirement}\n修订：${revision}`.slice(0, 8_000),
    acceptanceCriteria: [
      ...priorAcceptance,
      {
        id: idFactory(),
        criterion: revision.slice(0, 500),
        priority: revisionPriority
      }
    ].slice(-100)
  }
  if (audiences.length > 0) changes.audience = audiences
  if (addedKeep.length > 0) changes.keep = [...new Set([...currentKeep, ...addedKeep])].slice(0, 100)
  if (addedProhibitions.length > 0) changes.prohibitions = [...new Set([...currentProhibitions, ...addedProhibitions])].slice(0, 100)
  if (/标题|文字|字效|字体|排版/u.test(revision) && prior.text.length > 0) {
    changes.text = prior.text.map((text) => ({ ...text, style: `${text.style}；修订：${revision}`.slice(0, 1_000) }))
  }
  const brief = reviseCreativeBriefToV3(prior, {
    id: idFactory(),
    createdAt,
    changes,
    evidence: revision
  })
  const directions = current.directions?.map((direction) => ({ ...direction, briefId: brief.id }))
  const plan = { ...current.plan, briefId: brief.id }
  return creativeContextSchema.parse({
    brief,
    directions,
    selectedDirectionId: current.selectedDirectionId,
    plan
  })
}

export class DeterministicMockPlanner implements AgentPlanner {
  readonly #delayMs: number
  readonly #idFactory: () => string
  readonly #now: () => string

  constructor(options: DeterministicMockPlannerOptions = {}) {
    this.#delayMs = options.delayMs ?? 36
    this.#idFactory = options.idFactory ?? randomUUID
    this.#now = options.now ?? (() => new Date().toISOString())
  }

  async plan(requestInput: AgentRequest, signal: AbortSignal): Promise<AgentPlan> {
    const request = agentRequestSchema.parse(requestInput)
    await wait(this.#delayMs, signal)
    const tools: AgentPlan['tools'][number][] = []
    const isCompositionLayout = /(?:创建|建立|布局|排版|做一张|制作)/.test(request.text) && /(?:画布|海报|封面|广告|画面|构图)/.test(request.text)
    const composition = parseComposition(request.text)
    const isBriefRevision = /^\s*(?:修正|修改|更新)当前创作简报[：:]/u.test(request.text)
    const plannedComposition = isCompositionLayout ? buildCreativePlan(request, this.#idFactory, this.#now()) : null
    const revisedContext = !isCompositionLayout && isBriefRevision
      ? buildRevisedCreativeContext(request, this.#idFactory, this.#now())
      : null
    const creativeContext = plannedComposition ?? revisedContext
    const canBuildDesignContract = creativeContext !== null
      && creativeContext.directions !== undefined
      && creativeContext.selectedDirectionId !== undefined
      && (creativeContext.plan.capabilityPackIds?.length ?? 0) > 0
    const designContract: CreativeDesignContract | undefined = !canBuildDesignContract
      ? undefined
      : creativeDesignContractSchema.parse({
          version: 2,
          brief: creativeContext!.brief,
          directions: creativeContext!.directions,
          selectedDirectionId: creativeContext!.selectedDirectionId,
          capabilityPackIds: creativeContext!.plan.capabilityPackIds
        })
    const selectedUpdate = selectionCommands(request, this.#idFactory)
    const selectedMask = request.selectedElements.find((element) => element.type === 'mask')
    const selectedImage = request.selectedElements.find((element) => element.type === 'image')
    const localEditTargetId = request.ephemeralAnnotation?.targetElementId
      ?? (selectedMask?.type === 'mask' ? selectedMask.targetElementId : selectedImage?.id)
    const wantsLocalEdit = localEditTargetId !== undefined && /(?:局部|蒙版|标记|这块|这里).*(?:修改|替换|改成|重绘|生成)|(?:修改|替换|改成|重绘).*(?:局部|蒙版|标记|这块|这里)/i.test(request.text)
    const wantsDirective = /(?:记住|以后|始终|必须|作为规则|每次都|不要再)/u.test(request.text)
    const wantsResultPlacement = /(?:把|将).*(?:结果|生成图).*(?:放入|放到|加入).*画布|(?:放入|放到|加入).*画布/u.test(request.text)
    if (wantsDirective) {
      tools.push({
        kind: 'directive_create',
        category: /(?:隐私|外发|本地|保密)/u.test(request.text) ? 'privacy' : 'creative',
        text: request.text,
        priority: 100
      })
    }
    if (wantsResultPlacement && (request.generationResults?.length ?? 0) > 0) {
      tools.push({ kind: 'place_generation_result', resultId: request.generationResults!.at(-1)!.resultId })
    }
    if (isCompositionLayout || isBriefRevision && creativeContext !== null) {
      if (creativeContext === null) throw new Error('Creative context was not built for a composition request.')
      tools.push({
        kind: 'scene_batch',
        summary: isBriefRevision ? '修正当前创作简报' : `创建 ${composition.aspectWidth}:${composition.aspectHeight} ${composition.sceneKind}布局`,
        commands: isBriefRevision
          ? [{ kind: 'scene.set-creative-context', creativeContext }]
          : [...compileCreativeContextCommands(request.sceneSummary.elements, plannedComposition!, this.#idFactory)]
      })
    } else if (!wantsLocalEdit && selectedUpdate !== null && selectedUpdate.commands.length > 0) {
      tools.push({ kind: 'scene_batch', summary: selectedUpdate.summary, commands: [...selectedUpdate.commands] })
    }

    if (wantsLocalEdit && localEditTargetId !== undefined) {
      const mockModel = process.env.AI_CANVAS_E2E !== undefined && request.text.includes('[模拟失败]') ? 'mock-failure' : 'mock-balanced'
      tools.push({
        kind: 'canvas_edit',
        targetElementId: localEditTargetId,
        prompt: request.text,
        providerId: 'mock',
        model: mockModel,
        count: 1,
        sourceMessageId: null,
        ephemeralAnnotation: request.ephemeralAnnotation
      })
    }

    // “把生成结果放到画布” refers to an existing result; it must never create
    // another paid generation job merely because the phrase contains “生成”.
    const explicitlyGenerate = !wantsResultPlacement && hasExplicitGenerationInstruction(request.text)
    const inferredCompositionGeneration = isCompositionLayout && !hasNegatedGenerationInstruction(request.text)
    if (!wantsLocalEdit && !hasNegatedGenerationInstruction(request.text) && (explicitlyGenerate || request.autoGenerate || inferredCompositionGeneration)) {
      if (request.sceneSummary.elementCount > 0 || isCompositionLayout) {
        tools.push({
          kind: 'canvas_generation',
          originalRequirement: request.text,
          providerId: 'mock',
          model: 'mock-balanced',
          count: 1,
          referenceMode: 'hybrid',
          sourceMessageId: null
        })
      } else {
        tools.push({
          kind: 'generation',
          request: {
            prompt: request.text,
            negativePrompt: '低清晰度，杂乱布局，错误文字',
            aspectWidth: request.sceneSummary.canvas.aspectWidth,
            aspectHeight: request.sceneSummary.canvas.aspectHeight,
            outputWidth: request.sceneSummary.canvas.outputWidth,
            outputHeight: request.sceneSummary.canvas.outputHeight,
            count: 1,
            providerId: 'mock',
            model: 'mock-balanced',
            references: request.attachments.filter((attachment) => attachment.kind === 'asset').map((attachment) => ({
              assetId: attachment.id,
              intent: 'composition' as const,
              strength: 0.72
            })),
            parameters: {},
            sourceMessageId: null,
            parentResultId: null,
            referenceMode: 'hybrid',
            variationInstruction: '',
            preserveConstraints: ''
          }
        })
      }
    }
    if (/取消.*生成/.test(request.text) && request.activeGenerationJobId !== null) {
      tools.push({ kind: 'cancel_generation', jobId: request.activeGenerationJobId })
    }

    if (tools.length === 0) {
      return agentPlanSchema.parse({
        summary: wantsResultPlacement ? '没有可放入的生成结果' : '已阅读当前场景',
        response: wantsResultPlacement
          ? '当前项目还没有可放入画布的生成结果。请先生成图片，或从本地导入一张图片。'
          : request.selectedIds.length > 0
          ? '我已理解当前选区。请告诉我希望移动、缩放、加粗、组合还是删除。'
          : `当前画布有 ${request.sceneSummary.elementCount} 个元素。你可以直接描述布局、选中元素后要求修改，或明确让我生成图片。`,
        nextAction: null,
        tools: []
      })
    }
    return agentPlanSchema.parse({
      summary: wantsDirective
        ? '保存项目规则'
        : wantsResultPlacement
          ? '将生成结果放入画布'
          : wantsLocalEdit ? '局部修改图片' : isCompositionLayout ? `创建${composition.sceneKind}布局` : explicitlyGenerate ? '生成图片' : '调整画布',
      response: wantsDirective
        ? '这条长期要求已保存为项目规则，可随时在设置中修改或停用。'
        : wantsResultPlacement
          ? '最近的生成结果已作为可编辑图片层放入画布。'
          : isCompositionLayout
        ? `布局已创建：${composition.aspectWidth}:${composition.aspectHeight} 画布、${composition.subject}${composition.title === null ? '' : `与标题“${composition.title}”`}已经就位。`
        : wantsLocalEdit
          ? '已按选中图片的蒙版创建局部修改任务；源图不会被覆盖。'
        : explicitlyGenerate
          ? '生成任务已创建，结果会保存在当前项目。'
          : '已按当前选区完成调整。',
      nextAction: isCompositionLayout && !request.autoGenerate && !explicitlyGenerate ? '需要成图时，可以继续说“生成图片”。' : null,
      tools,
      ...(designContract === undefined ? {} : { designContract })
    })
  }
}
