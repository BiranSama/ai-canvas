import { randomUUID } from 'node:crypto'
import {
  capabilityPackDescriptorSchema,
  creativeDesignContractSchema,
  directionProposalSchema,
  ELEMENT_SCHEMA_VERSION,
  type CapabilityPackDescriptor,
  type CreativeBriefV2,
  type CreativeBriefV3,
  type CreativeDesignContract,
  type DirectionProposal,
  type SceneCommand,
  type SceneElement
} from '../../domain'
import type { AgentPlan, AgentRequest, AgentToolPlan, SceneElementSummary } from '../../shared/agent'
import {
  designCompletionAssessmentSchema,
  designRubricSchema,
  type DesignCheckResult,
  type DesignCompletionAssessment,
  type DesignDimension,
  type DesignRubricEntry
} from '../../shared/design-capability'

const PACKS = [
  {
    id: 'product-poster', title: '产品海报', theme: 'product', purpose: '建立可调整的产品主体、卖点文字、环境台面与商业光影。',
    capabilities: ['产品轮廓', '卖点层级', '台面关系', '商业光影'],
    rules: ['主体保持独立可移动', '文字使用准确可编辑层', '不得把任意产品收敛为香水瓶']
  },
  {
    id: 'portrait-editorial', title: '人物编辑视觉', theme: 'portrait', purpose: '建立人物重心、视线、裁切、文字和留白关系。',
    capabilities: ['人物头肩与姿态', '视线留白', '编辑排版', '轮廓光'],
    rules: ['人物只是语义草图，不声称是真实成图', '面部与文字必须保持独立控制']
  },
  {
    id: 'architecture-poster', title: '建筑与空间', theme: 'architecture', purpose: '建立体块、入口、透视轴、地平线和长阴影。',
    capabilities: ['建筑体块', '透视轴', '入口层级', '空间光影'],
    rules: ['体块至少有前后层次', '透视辅助线默认只作为参考']
  },
  {
    id: 'botanical-editorial', title: '植物编辑视觉', theme: 'botanical', purpose: '建立枝干动势、叶片疏密、自然不对称与标本文字。',
    capabilities: ['枝干动势', '叶片节奏', '标本标签', '自然光'],
    rules: ['避免规则椭圆冒充植物', '枝叶结构保持可独立调整']
  },
  {
    id: 'abstract-composition', title: '抽象构成', theme: 'abstract', purpose: '建立几何色面、曲线、负空间与视觉张力。',
    capabilities: ['色面切割', '自由曲线', '负空间', '视觉张力'],
    rules: ['方向差异必须来自构成关系', '避免只替换同义风格词']
  },
  {
    id: 'album-cover', title: '唱片封面', theme: 'album', purpose: '建立方形封面、唱片/声波意象和艺人标题层级。',
    capabilities: ['方形封面', '唱片意象', '声波节奏', '艺人信息'],
    rules: ['标题保持可编辑', '唱片与封套可独立移动']
  },
  {
    id: 'coffee-campaign', title: '咖啡视觉', theme: 'coffee', purpose: '建立杯体、碟面、蒸汽、桌面与晨间光影。',
    capabilities: ['杯碟结构', '蒸汽手势', '桌面关系', '晨间光'],
    rules: ['不得复用香水瓶轮廓', '蒸汽与杯体分层']
  },
  {
    id: 'landscape-cover', title: '山海封面', theme: 'landscape', purpose: '建立山海远近、雾层、地平线和封面文字。',
    capabilities: ['山海层次', '雾气', '地平线', '封面排版'],
    rules: ['至少表达近中远景', '不要以单个通用主体框替代景观结构']
  },
  {
    id: 'general-visual', title: '通用视觉构成', theme: 'general', purpose: '在主题未明确时建立可逆的通用层级与留白。',
    capabilities: ['基础层级', '准确文字', '留白', '主题占位'],
    rules: ['不假定具体商品类别', '模糊请求最多提供三个真正不同方向']
  },
  {
    id: 'design-review', title: '设计评审', theme: 'general', purpose: '使用结构化 Rubric 检查需求、构图、文字、可编辑性与收敛。',
    capabilities: ['硬约束检查', '十维 Rubric', '单次本地精修', '诚实停止'],
    rules: ['模型自评分不得作为唯一依据', '低分最多本地精修一次']
  }
] as const

const BUILT_IN_PACKS = PACKS.map((pack) => capabilityPackDescriptorSchema.parse({ ...pack, version: 1 }))

export class CapabilityPackRegistry {
  readonly #packs = new Map(BUILT_IN_PACKS.map((pack) => [pack.id, pack]))

  list(): readonly CapabilityPackDescriptor[] {
    return [...this.#packs.values()]
  }

  get(id: string): CapabilityPackDescriptor | null {
    return this.#packs.get(id) ?? null
  }

  forTheme(theme: CreativeBriefV2['theme']): CapabilityPackDescriptor {
    return [...this.#packs.values()].find((pack) => pack.theme === theme && pack.id !== 'design-review')
      ?? this.#packs.get('general-visual')!
  }
}

const registry = new CapabilityPackRegistry()

type CurrentCreativeBrief = CreativeBriefV2 | CreativeBriefV3

const DIRECTION_VARIANTS: Record<CreativeBriefV2['theme'], readonly {
  readonly title: string
  readonly composition: string
  readonly subject: string
  readonly typography: string
  readonly lighting: string
  readonly difference: string
}[]> = {
  product: [
    { title: '静物主轴', composition: '主体沿单一主轴落位，卖点与留白形成克制层级。', subject: '产品轮廓和台面投影分层。', typography: '标题位于主体上方，保持准确可编辑。', lighting: '柔和轮廓光强调材质边缘。', difference: '最稳健的商业静物方向。' },
    { title: '对角动势', composition: '主体偏离中心，色面和光带沿对角线推进。', subject: '产品与辅助道具形成大小节奏。', typography: '标题靠近负空间边缘。', lighting: '斜向硬柔混合光建立速度感。', difference: '更有动势和活动感。' },
    { title: '材质近景', composition: '放大局部材质，把主体边缘作为构图切口。', subject: '主体允许局部越界，材质细节成为重心。', typography: '文字压在稳定留白区，不覆盖关键轮廓。', lighting: '低角度掠射光表现表面。', difference: '强调质感而非完整陈列。' }
  ],
  portrait: [
    { title: '编辑留白', composition: '人物偏置，视线指向大面积留白。', subject: '头肩与身体重心独立表达。', typography: '标题进入视线留白但不遮挡面部。', lighting: '柔和侧光和轮廓光。', difference: '克制的编辑杂志方向。' },
    { title: '近景裁切', composition: '人物近景越界，五官区域避开文字。', subject: '以面部和肩线建立强重心。', typography: '标题缩小并贴近边缘。', lighting: '较高反差的窗光。', difference: '更直接、更有情绪张力。' },
    { title: '动态步态', composition: '人物沿对角线移动，留下运动方向空间。', subject: '身体姿态和衣摆形成动势。', typography: '标题沿运动轴错位排列。', lighting: '背光勾勒动态轮廓。', difference: '从静态肖像转为叙事瞬间。' }
  ],
  architecture: [
    { title: '入口透视', composition: '以入口为消失点，前景路径引导视线。', subject: '主次体块和入口分别成层。', typography: '标题避开透视主轴。', lighting: '长阴影强化体块。', difference: '突出空间进入感。' },
    { title: '立面秩序', composition: '以网格和重复开窗建立静态秩序。', subject: '建筑立面被拆成多个比例体块。', typography: '标题与立面网格对齐。', lighting: '均匀侧光表现表皮。', difference: '突出理性和图形感。' },
    { title: '景观嵌入', composition: '建筑偏小，环境和地形占据更大篇幅。', subject: '建筑、山体与路径分层。', typography: '标题进入天空负空间。', lighting: '环境雾光拉开远近。', difference: '突出场所而非单体。' }
  ],
  botanical: [
    { title: '标本笔记', composition: '主枝斜向穿过画面，标签围绕节点布置。', subject: '枝干、叶簇和标记点分层。', typography: '标题像标本册眉题。', lighting: '柔和漫射自然光。', difference: '偏理性记录。' },
    { title: '野生成长', composition: '枝叶从边缘进入并局部越界。', subject: '大小叶片形成不规则疏密。', typography: '文字保持小而安静。', lighting: '斑驳侧光。', difference: '更自然、更具生命力。' },
    { title: '微观纹理', composition: '放大叶脉和局部结构作为抽象画面。', subject: '宏观轮廓退后，叶脉成为主体。', typography: '标题置于单色负空间。', lighting: '逆光强调透明纹理。', difference: '从植物肖像转为材质研究。' }
  ],
  abstract: [
    { title: '张力切割', composition: '大色面以非对称切口建立张力。', subject: '几何块和曲线交错但不粘连。', typography: '文字与切割边缘保持距离。', lighting: '使用色差而非写实光。', difference: '强调平面冲突。' },
    { title: '漂浮轨道', composition: '圆形与轨迹线围绕偏心重心旋转。', subject: '元素大小递进形成空间感。', typography: '标题贴近静止的负空间。', lighting: '柔和辉光表现漂浮层次。', difference: '更流动、更有空间感。' },
    { title: '纸张拼贴', composition: '多张半透明纸片以错位和遮挡构成。', subject: '纹理、纸边和印刷块分层。', typography: '标题像独立印刷标签。', lighting: '纸面阴影强调真实层叠。', difference: '强调手工拼贴质感。' }
  ],
  album: [
    { title: '唱片轨道', composition: '圆盘偏心，轨道线延伸到封面边缘。', subject: '唱片、中心标和声波独立。', typography: '艺人与标题分成两个层级。', lighting: '局部反光表现黑胶材质。', difference: '明确的音乐物件意象。' },
    { title: '声波留白', composition: '主体退小，声波和大面积负空间成为节奏。', subject: '声波线条承担视觉主体。', typography: '标题放大成为主要图形。', lighting: '微弱辉光而非物体照明。', difference: '以排版和声音图形为核心。' },
    { title: '封套拼贴', composition: '封套、标签与票据形成叠放拼贴。', subject: '多个纸面组件可独立移动。', typography: '标题像独立贴纸或印章。', lighting: '轻微纸面投影。', difference: '更手工、更具收藏物感。' }
  ],
  coffee: [
    { title: '晨间桌面', composition: '杯碟位于下部，桌面阴影引向标题。', subject: '杯体、杯碟、蒸汽和咖啡豆分层。', typography: '标题位于上方自然留白。', lighting: '温暖侧窗光。', difference: '温和的生活方式方向。' },
    { title: '俯拍秩序', composition: '圆形杯口与餐具构成俯拍网格。', subject: '杯口、碟面和配料形成几何关系。', typography: '文字沿网格边缘对齐。', lighting: '柔和顶光和短投影。', difference: '更图形化、更适合菜单。' },
    { title: '蒸汽叙事', composition: '杯体退小，蒸汽曲线占据上半画面。', subject: '蒸汽成为可编辑的叙事手势。', typography: '标题与蒸汽错开。', lighting: '暗背景上的逆光蒸汽。', difference: '更有情绪和故事感。' }
  ],
  landscape: [
    { title: '雾层远山', composition: '近景水面、中景山体、远景雾层依次展开。', subject: '山、海、雾和岸线独立。', typography: '标题位于天空留白。', lighting: '低反差漫射光。', difference: '安静的东方封面方向。' },
    { title: '海岸切线', composition: '海岸线形成强对角，近景岩石压住重心。', subject: '海面与陆地构成清晰切线。', typography: '标题贴近水平线但不相交。', lighting: '侧逆光表现波面。', difference: '更有力量和方向性。' },
    { title: '极简地平线', composition: '大面积天空与极细地平线构成极简比例。', subject: '景物缩小为符号化层次。', typography: '标题成为主要视觉元素。', lighting: '以色温渐变表达时间。', difference: '突出留白和文字。' }
  ],
  general: [
    { title: '稳健主轴', composition: '主体、标题和留白沿清晰主轴组织。', subject: '主体保持语义中性和独立可编辑。', typography: '准确文字处于稳定层级。', lighting: '柔和方向光建立层次。', difference: '最稳健、最少假设。' },
    { title: '非对称编辑', composition: '主体偏置，以侧边留白和错位色面建立编辑感。', subject: '主体与辅助形状形成大小对比。', typography: '标题在负空间内错位对齐。', lighting: '局部光带引导视线。', difference: '更有编辑感和节奏。' },
    { title: '近景材质', composition: '主体局部越界，以材质和边缘作为构图。', subject: '细节代替完整轮廓成为重心。', typography: '文字收缩为辅助信息。', lighting: '掠射光强调材质。', difference: '强调触感和氛围。' }
  ]
}

export function buildDirectionProposals(brief: CurrentCreativeBrief, idFactory: () => string): readonly DirectionProposal[] {
  const pack = registry.forTheme(brief.theme)
  const count = brief.precision === 'precise' ? 1 : 3
  return DIRECTION_VARIANTS[brief.theme].slice(0, count).map((variant, index) => directionProposalSchema.parse({
    version: 1,
    id: idFactory(),
    briefId: brief.id,
    capabilityPackId: pack.id,
    title: variant.title,
    recommended: index === 0,
    composition: variant.composition,
    subject: variant.subject,
    typography: variant.typography,
    palette: brief.palette,
    lighting: variant.lighting,
    localSketchCost: 'no-cost',
    difference: variant.difference
  }))
}

export function buildDesignContract(brief: CurrentCreativeBrief, idFactory: () => string): CreativeDesignContract {
  const directions = buildDirectionProposals(brief, idFactory)
  return creativeDesignContractSchema.parse({
    version: brief.version === 3 ? 2 : 1,
    brief,
    directions,
    selectedDirectionId: directions[0]!.id,
    capabilityPackIds: [registry.forTheme(brief.theme).id, 'design-review']
  })
}

function summarizedEvidence(evidence: readonly string[]): string[] {
  const unique = [...new Set(evidence)].map(value => value.slice(0, 500))
  return unique.length <= 20 ? unique : [...unique.slice(0, 19), `另有 ${unique.length - 19} 项证据；完整要求和作品仍保留，可逐项复核。`]
}

function check(id: string, label: string, status: DesignCheckResult['status'], evidence: readonly string[]): DesignCheckResult {
  return { id, label: label.length <= 240 ? label : `${label.slice(0, 239)}…`, status, evidence: summarizedEvidence(evidence) }
}

export function designAssessmentNotes(design: DesignCompletionAssessment): string[] {
  const suffix = '…（完整证据见逐项检查）'
  const notes = [...design.requirements, ...design.structure].filter(item => item.status !== 'pass').map(item => {
    const note = `${item.label}：${item.evidence.join('；')}`
    return note.length <= 1000 ? note : note.slice(0, 1000 - suffix.length) + suffix
  })
  return notes.length <= 100 ? notes : [...notes.slice(0, 99), `另有 ${notes.length - 99} 项检查，完整要求仍保留，请逐项复核。`]
}

function rubricEntry(dimension: DesignDimension, score: number, rationale: string, evidence: readonly string[]): DesignRubricEntry {
  return { dimension, score: Math.max(0, Math.min(4, Math.round(score))), rationale, evidence: summarizedEvidence(evidence) }
}

function exactTextEvidence(brief: CurrentCreativeBrief, elements: readonly SceneElementSummary[]): { readonly ok: boolean; readonly evidence: readonly string[] } {
  const evidence: string[] = []
  let ok = true
  for (const text of brief.text.filter((item) => item.accuracy === 'strict')) {
    const match = elements.find((element) => element.type === 'text' && element.content === text.content)
    if (match === undefined) {
      ok = false
      evidence.push(`缺少准确文字“${text.content}”`)
    } else if (match.renderStrategy !== 'standard' || match.resultAssetId !== null) {
      ok = false
      evidence.push(`“${text.content}”未保留为标准可编辑文字层`)
    } else {
      evidence.push(`“${text.content}”为独立标准文字层`)
    }
  }
  if (brief.text.length === 0) evidence.push('Brief 未要求固定文字')
  return { ok, evidence }
}

export function atomicAspectCriterion(text: string): { width: number; height: number } | null {
  const ratio = text.trim().replace(/[。.]$/u, '').match(/^(?:画布)?比例(?:保持|为|是)?\s*(\d{1,3})\s*[:：]\s*(\d{1,3})$/u)
  return ratio === null ? null : { width: Number(ratio[1]), height: Number(ratio[2]) }
}

export class CompletionAssessor {
  assess(input: {
    readonly request: AgentRequest
    readonly plan: AgentPlan
    readonly localRefineCount: number
    readonly unresolvedDecisionIds?: readonly string[]
    readonly generationJobsCreated?: number
  }): DesignCompletionAssessment | null {
    const contract = input.plan.designContract
    if (contract === undefined) return null
    const brief = contract.brief
    const scene = input.request.sceneSummary
    const elements = scene.elements.filter((element) => element.visible)
    const subjects = elements.filter((element) => element.semanticRole === 'subject')
    const guides = elements.filter((element) => element.referencePolicy === 'reference-only')
    const text = exactTextEvidence(brief, elements)
    const ratioOk = brief.aspectPreference === null || (
      brief.aspectPreference.width === scene.canvas.aspectWidth && brief.aspectPreference.height === scene.canvas.aspectHeight
    )
    const subjectOk = subjects.length > 0 && brief.subjects.every((required) => subjects.some((element) => (
      element.name.includes(required.name) || element.description.includes(required.name) || element.subject?.includes(required.name) === true
    )))
    const localSemantic = elements.every((element) => element.provenance?.origin !== 'provider-generated')
    const editable = elements.length > 0 && elements.filter((element) => element.controlIntent !== undefined).length / elements.length >= 0.8
    const requiredLighting = brief.lighting.length > 0
    const lightingOk = !requiredLighting || elements.some((element) => element.type === 'light' && (element.lightIntensity ?? 0) > 0)
    const acceptanceChecks = brief.version !== 3 ? [] : brief.acceptanceCriteria.map((criterion) => {
      // Only complete, atomic structural statements have an automatic verifier.
      // A keyword inside a visual or compound sentence is not evidence for it.
      const value = criterion.criterion.trim().replace(/[。.]$/u, '')
      const subject = value.match(/^主体“([^”]+)”保留独立可编辑元素$/u)
      const exactText = value.match(/^“([^”]+)”按 exact-overlay 语义保留$/u)
      const expectedRatio = atomicAspectCriterion(value)
      const knownResult = expectedRatio !== null
        ? expectedRatio.width === scene.canvas.aspectWidth && expectedRatio.height === scene.canvas.aspectHeight
        : subject !== null
          ? subjects.some((element) => (element.name.includes(subject[1]!) || element.description.includes(subject[1]!) || element.subject?.includes(subject[1]!) === true) && element.controlIntent !== undefined)
          : /^(?:主要|所有)元素保持独立可编辑$/u.test(value)
            ? editable
            : value === '准确文字逐字保留'
              ? text.ok
              : exactText !== null
                ? elements.some((element) => element.type === 'text' && element.content === exactText[1] && element.renderStrategy === 'standard' && element.resultAssetId === null)
              : /^(?:避免|不)(?:生成图片|生图|出图)$/u.test(value) && input.generationJobsCreated !== undefined
                ? input.generationJobsCreated === 0
              : null
      const status: DesignCheckResult['status'] = knownResult === true
        ? 'pass'
        : knownResult === false && criterion.priority === 'must'
          ? 'fail'
          : 'warning'
      return check(
        `acceptance:${criterion.id}`,
        `${criterion.priority === 'must' ? '必须' : '优先'}：${criterion.criterion}`,
        status,
        [criterion.criterion, knownResult === null ? '该标准需要视觉或用户复核，未伪装为自动验证通过' : knownResult ? '结构化 Scene 证据通过' : '结构化 Scene 证据未通过']
      )
    })

    const requirements = [
      check('aspect', '画布比例符合 Brief', ratioOk ? 'pass' : 'fail', [`当前 ${scene.canvas.aspectWidth}:${scene.canvas.aspectHeight}`]),
      check('subject', '主体语义完整', subjectOk ? 'pass' : 'fail', subjects.map((element) => element.name)),
      check('text', '准确文字与来源层保留', text.ok ? 'pass' : 'fail', text.evidence),
      check('lighting', '光影要求可见且可控', lightingOk ? 'pass' : 'warning', requiredLighting ? ['Brief 要求独立光影层'] : ['Brief 未强制光影']),
      check('prohibitions', '未使用真实 Provider 成图冒充本地草图', localSemantic ? 'pass' : 'fail', [localSemantic ? '全部元素来自用户或本地 Agent' : '检测到 Provider 生成来源']),
      ...acceptanceChecks
    ]

    const outOfBounds = elements.filter((element) => element.transform.x < 0 || element.transform.y < 0 || element.transform.x + element.transform.width > 1 || element.transform.y + element.transform.height > 1)
    const structure = [
      check('editability', '主要元素保持独立可编辑', editable ? 'pass' : 'fail', [`${elements.filter((element) => element.controlIntent !== undefined).length}/${elements.length} 个可见元素带控制意图`]),
      check('semantic-guides', '草图辅助层与最终内容分离', guides.length > 0 ? 'pass' : 'warning', [`${guides.length} 个 reference-only 元素`]),
      check('bounds', '主要构图在画布边界内', outOfBounds.length === 0 ? 'pass' : 'warning', outOfBounds.map((element) => element.name)),
      check('relations', '存在可解释的空间关系', (scene.relationCount ?? 0) > 0 ? 'pass' : 'warning', [`${scene.relationCount ?? 0} 条关系`])
    ]

    const hardFailures = requirements.filter((item) => item.status === 'fail').length + structure.filter((item) => item.status === 'fail').length
    const subjectArea = subjects.reduce((sum, element) => sum + element.transform.width * element.transform.height, 0)
    const title = elements.find((element) => element.type === 'text' && element.semanticRole === 'title')
    const distinctRoles = new Set(elements.map((element) => element.semanticRole)).size
    const styleSpecific = elements.filter((element) => element.visualKind === brief.theme || element.semanticRole.includes(brief.theme)).length

    const entries = [
      rubricEntry('requirements_fidelity', hardFailures === 0 ? 4 : hardFailures === 1 ? 2 : 0, '根据比例、主体、文字和禁止项的结构化证据评分。', requirements.flatMap((item) => item.evidence)),
      rubricEntry('composition', subjects.length > 0 && (scene.relationCount ?? 0) > 0 ? 4 : subjects.length > 0 ? 3 : 1, '主体落位与空间关系共同决定构图完整度。', [`主体 ${subjects.length} 个，关系 ${scene.relationCount ?? 0} 条`]),
      rubricEntry('hierarchy', title !== undefined && subjects.length > 0 ? 4 : subjects.length > 0 ? 3 : 1, '文字与主体是否形成可读的主次层级。', [title === undefined ? '无标题层' : '标题层存在']),
      rubricEntry('whitespace', subjectArea > 0 && subjectArea <= 0.55 ? 4 : subjectArea <= 0.75 ? 3 : 1, '用主体占画面面积作为本地可复现的留白代理指标。', [`主体面积比 ${subjectArea.toFixed(2)}`]),
      rubricEntry('text', text.ok ? 4 : 0, '准确文字必须是独立标准层，AI 字效结果只能作为旁路资产。', text.evidence),
      rubricEntry('subject', subjectOk && subjects.some((element) => element.visualKind === brief.theme) ? 4 : subjectOk ? 3 : 0, '主体名称、语义描述与主题草图类型共同作为证据。', subjects.map((element) => `${element.name}:${element.visualKind ?? 'generic'}`)),
      rubricEntry('lighting', lightingOk && requiredLighting ? 4 : lightingOk ? 3 : 1, '有要求时必须存在独立可控光影层。', [requiredLighting ? 'Brief 有光影要求' : 'Brief 未强制光影']),
      rubricEntry('style', styleSpecific > 0 && distinctRoles >= 5 ? 4 : distinctRoles >= 4 ? 3 : 2, '主题专属元素和角色多样性避免单模板换名。', [`${styleSpecific} 个主题专属元素，${distinctRoles} 个语义角色`]),
      rubricEntry('editability', editable && text.ok ? 4 : editable ? 2 : 0, '控制意图、独立元素与准确文字层共同决定可编辑性。', structure[0]!.evidence),
      rubricEntry('convergence', brief.precision === 'precise' ? 4 : 3, '精确请求收敛到一个方向；模糊请求保留可比较方向。', [`${contract.directions.length} 个方向，精度 ${brief.precision}`])
    ]
    const design = designRubricSchema.parse({ version: 1, entries, total: entries.reduce((sum, entry) => sum + entry.score, 0) })
    const hardZero = entries.some((entry) => ['requirements_fidelity', 'text', 'editability'].includes(entry.dimension) && entry.score === 0)
    const mustAcceptanceFailure = acceptanceChecks.some((item) => item.status === 'fail')
    const unverifiedMust = acceptanceChecks.filter((item) => item.status === 'warning' && item.label.startsWith('必须：'))
      .map((item) => ({ id: item.id, label: item.label, reason: item.evidence.join('；') }))
    const unresolvedDecisionIds = [...(input.unresolvedDecisionIds ?? [])]
    let recommendation: DesignCompletionAssessment['recommendation']
    if (unresolvedDecisionIds.length > 0) recommendation = 'needs_user_review'
    else if (mustAcceptanceFailure) recommendation = input.localRefineCount === 0 ? 'refine_once' : 'needs_user_review'
    else if (hardZero || design.total < 24) recommendation = input.localRefineCount === 0 ? 'refine_once' : 'needs_user_review'
    else if (unverifiedMust.length > 0) recommendation = 'needs_user_review'
    else if (design.total < 28) recommendation = 'needs_user_review'
    else recommendation = 'complete'
    return designCompletionAssessmentSchema.parse({
      version: 1,
      // A legal Brief can contain 100 criteria. Keep all of them; place the
      // five built-in structural checks with structure when this array is full.
      requirements: requirements.length > 100 ? acceptanceChecks : requirements,
      structure: requirements.length > 100 ? [...requirements.slice(0, 5), ...structure] : structure,
      design,
      unresolvedDecisionIds,
      budgetState: input.localRefineCount === 0 ? '尚未使用本地精修额度（最多 1 次）' : '本地精修额度已使用 1/1，禁止再次自动精修',
      recommendation,
      localRefineCount: input.localRefineCount,
      sceneRevision: scene.revision,
      unverifiedMust
    })
  }
}

function base(id: string, type: SceneElement['type'], name: string, zIndex: number, contract: CreativeDesignContract) {
  return {
    id, version: ELEMENT_SCHEMA_VERSION, type, name, description: '', zIndex, opacity: 1, blendMode: 'normal' as const, visible: true, locked: false, groupId: null,
    semanticRole: 'content', referencePolicy: 'include' as const,
    controlIntent: { kind: 'layout' as const, priority: 'prefer' as const, instruction: '保持本地设计精修后的可编辑布局', strength: 0.8 },
    provenance: { origin: 'agent-local' as const, sourceBriefId: contract.brief.id, sourceDirectionId: contract.selectedDirectionId, sourceAssetId: null }
  }
}

export function buildLocalRefineTool(
  request: AgentRequest,
  plan: AgentPlan,
  assessment: DesignCompletionAssessment,
  idFactory: () => string = randomUUID
): AgentToolPlan | null {
  const contract = plan.designContract
  if (contract === undefined || assessment.recommendation !== 'refine_once' || assessment.localRefineCount !== 0) return null
  const commands: SceneCommand[] = []
  const scene = request.sceneSummary
  const subject = scene.elements.find((element) => element.semanticRole === 'subject')
  if (subject !== undefined && subject.transform.width * subject.transform.height > 0.55) {
    commands.push({
      kind: 'element.update', elementId: subject.id,
      changes: { transform: { ...subject.transform, x: 0.25, y: 0.3, width: Math.min(0.5, subject.transform.width), height: Math.min(0.55, subject.transform.height) } }
    })
  }
  for (const text of contract.brief.text.filter((item) => item.accuracy === 'strict' && item.mode === 'exact-overlay')) {
    const existing = scene.elements.find((element) => element.type === 'text' && element.content === text.content)
    if (existing !== undefined) continue
    const id = idFactory()
    commands.push({
      kind: 'element.add',
      element: {
        ...base(id, 'text', text.role === 'title' ? '主标题' : '准确文字', scene.elementCount + commands.length, contract),
        type: 'text', description: `Brief 中要求准确保留的文字“${text.content}”`, semanticRole: text.role,
        controlIntent: { kind: 'exact-text', priority: 'must', instruction: `逐字保留“${text.content}”，AI 字效只能作为独立旁路资产`, strength: 1 },
        transform: { x: 0.1, y: 0.07, width: 0.8, height: 0.13, rotation: 0 },
        content: text.content, orientation: 'horizontal', align: 'center', wrapping: 'word', fontFamily: 'Segoe UI Variable', fontSize: 72, fontWeight: 500,
        fill: '#F4F4F2', stroke: null, strokeWidth: 0, shadowColor: null, shadowBlur: 0, letterSpacing: 3, lineHeight: 1.1,
        accuracy: 'strict', visualWeight: text.visualWeight ?? 'secondary', styleDescription: text.style, renderStrategy: 'editable-overlay', resultAssetId: null
      }
    })
  }
  if (commands.length === 0) return null
  return { kind: 'scene_batch', summary: '本地设计精修（仅此一次）', commands }
}

export const builtInCapabilityPacks = registry.list()
