import type { ProviderCapabilities } from '../../shared/generation'
import { providerCompiledPromptSchema, type PromptIr, type PromptIrElement, type PromptPackage, type ProviderCompiledPrompt } from '../../shared/reference'
import { blendModeIntent, blendModeLabel } from '../../shared/blend-mode'

function percentage(value: unknown): string {
  return typeof value === 'number' ? `${Math.round(value * 100)}%` : '未指定'
}

/** Where an element sits, in words an image model reads well: 「画面上部居中，约占宽 40%、高 12%」. */
function placement(bounds: PromptIrElement['bounds']): string {
  const centerX = bounds.x + bounds.width / 2
  const centerY = bounds.y + bounds.height / 2
  const row = centerY < 0.36 ? '上部' : centerY > 0.64 ? '下部' : '中部'
  const column = centerX < 0.36 ? '偏左' : centerX > 0.64 ? '偏右' : '居中'
  const covers = bounds.width >= 0.9 && bounds.height >= 0.9 ? '铺满整个画面' : `位于画面${row}${column}，约占宽 ${percentage(bounds.width)}、高 ${percentage(bounds.height)}`
  return covers
}

const WEIGHT_COPY: Readonly<Record<string, string>> = { hero: '画面主视觉', primary: '醒目', secondary: '次要', whisper: '很轻' }
const ACCURACY_COPY: Readonly<Record<string, string>> = { strict: '一字不差', balanced: '内容不变，排列可微调', expressive: '可以艺术化处理' }

function describeElement(element: PromptIrElement, promptPackage?: PromptPackage): string {
  const position = placement(element.bounds)
  const blend = element.blendMode === 'normal' ? '' : `；与下方画面的混合：${blendModeLabel(element.blendMode)}，${blendModeIntent(element.blendMode)}`
  if (element.type === 'text') {
    const contract = promptPackage?.textContract.find((entry) => entry.elementId === element.id)
    const content = contract?.content ?? String(element.attributes.content ?? '')
    const style = contract?.style ?? String(element.attributes.styleDescription ?? element.description)
    const accuracy = contract?.accuracy ?? (element.attributes.accuracy as 'strict' | 'balanced' | 'expressive')
    const mode = contract?.mode ?? (element.attributes.renderStrategy === 'editable-overlay' ? 'exact-overlay' : element.attributes.renderStrategy === 'standard' ? 'reference' : 'image-text')
    const visualWeight = WEIGHT_COPY[contract?.visualWeight ?? String(element.attributes.visualWeight ?? 'secondary')] ?? '次要'
    if (mode === 'exact-overlay') {
      return `留给文字“${content}”的位置：不要在这里画任何字，只留出干净、适合之后叠放文字的空间（${visualWeight}）；${position}${blend}`
    }
    if (mode === 'image-text') {
      return `画进画面的文字“${content}”：${ACCURACY_COPY[accuracy] ?? ''}；字形、材质和光影由你重新设计，参考图里的字体和字号只是占位（${visualWeight}）；${style}；${position}${blend}`
    }
    return `文字参考“${content}”：内容${ACCURACY_COPY[accuracy] ?? ''}，位置和大小节奏照参考，字形重新设计，不照搬当前占位字体或字号（${visualWeight}）；${style}；${position}${blend}`
  }
  if (element.type === 'placeholder') {
    const details = [element.attributes.pose, element.attributes.facing, element.attributes.generationNotes].map((value) => String(value ?? '').trim()).filter((value) => value !== '')
    return `主体：${String(element.attributes.subject ?? element.name)}${details.length === 0 ? '' : `，${details.join('，')}`}；${position}${blend}`
  }
  if (element.type === 'light') {
    return `光线：${element.description || element.name}，颜色 ${String(element.attributes.color ?? '')}，从 ${String(element.attributes.direction ?? '')}° 方向照来，强度 ${percentage(element.attributes.intensity)}，柔和度 ${percentage(element.attributes.softness)}；${position}${blend}`
  }
  if (element.type === 'image') return `图片“${element.name}”（照参考图里的样子画进画面）${element.description ? `：${element.description}` : ''}；${position}${blend}`
  if (element.type === 'shape') return `${element.attributes.role === 'placeholder' ? '构图示意的色块' : '图形'}“${element.name}”${element.description ? `：${element.description}` : ''}；${position}${blend}`
  if (element.type === 'sketch') return `构图草图“${element.name}”，轮廓照着画的程度 ${percentage(element.attributes.fidelity)}${element.description ? `；${element.description}` : ''}；${position}${blend}`
  return `“${element.name}”${element.description ? `：${element.description}` : ''}；${position}${blend}`
}

export class ProviderPromptCompiler {
  compile(ir: PromptIr, providerId: string, capabilities: ProviderCapabilities, promptPackage?: PromptPackage): ProviderCompiledPrompt {
    const visible = ir.elements.filter((element) => element.presentation !== 'omitted' && element.type !== 'mask' && element.type !== 'group')
    const protectedNames = ir.protectedElementIds
      .map((id) => ir.elements.find((element) => element.id === id)?.name)
      .filter((name): name is string => name !== undefined)
    const relationLines = ir.relations.map((relation) => {
      const source = ir.elements.find((element) => element.id === relation.sourceElementId)?.name ?? relation.sourceElementId
      const target = ir.elements.find((element) => element.id === relation.targetElementId)?.name ?? relation.targetElementId
      return `${source} ${relation.type} ${target}${relation.description ? `：${relation.description}` : ''}`
    })
    const semanticGroupLines = ir.elements.flatMap((element) => {
      if (element.type !== 'group') return []
      const childIds = Array.isArray(element.attributes.childIds)
        ? element.attributes.childIds.filter((id): id is string => typeof id === 'string')
        : []
      const childNames = childIds
        .map((id) => ir.elements.find((candidate) => candidate.id === id)?.name)
        .filter((name): name is string => name !== undefined)
      if (childNames.length === 0) return []
      return [`${element.name}：由${childNames.map((name) => `“${name}”`).join('、')}组成；保持组件内的相对布局与共同语义，同时把每个子元素理解为可独立呈现的视觉对象。`]
    })
    const output = promptPackage?.targetOutput ?? ir.canvas
    const referenceMode = promptPackage?.referenceMode ?? 'hybrid'
    const sections = referenceMode === 'visual' ? [
      ir.originalRequirement,
      `输出画布：${output.aspectWidth}:${output.aspectHeight}，${output.outputWidth}×${output.outputHeight}。`,
      '本次使用画面参考；参考图片表达观感、构图、色彩和质感，不附带可编辑元素关系的约束。'
    ] : [
      ir.originalRequirement,
      promptPackage === undefined ? '' : `这是一幅完整的成品画面，用途：${promptPackage.sceneIntent.purpose}；媒介：${promptPackage.sceneIntent.medium.join('、')}。`,
      `输出画布：${output.aspectWidth}:${output.aspectHeight}，${output.outputWidth}×${output.outputHeight}。`,
      ir.canvas.globalStyle ? `整体风格：${ir.canvas.globalStyle}` : '',
      promptPackage === undefined || promptPackage.styleBible.length === 0 ? '' : `风格、色彩与光影：${promptPackage.styleBible.join('；')}`,
      `画面里有什么，从最远到最近：\n${visible.map((element) => `- ${describeElement(element, promptPackage)}${element.presentation === 'semantic-guide' ? '。这是构图示意，不是透明材质或要画出来的标签' : ''}`).join('\n')}`,
      semanticGroupLines.length > 0 ? `成组的部分：\n${semanticGroupLines.map((line) => `- ${line}`).join('\n')}` : '',
      relationLines.length > 0 ? `相互关系：\n${relationLines.map((line) => `- ${line}`).join('\n')}` : '',
      ir.occlusions.length > 0 ? `前后遮挡：\n${ir.occlusions.map((item) => `- ${item.instruction}`).join('\n')}` : '',
      protectedNames.length > 0 ? `保持不变：${protectedNames.map((name) => `“${name}”`).join('、')} 的位置、内容和样子。` : '',
      promptPackage?.referenceMode === 'structure'
        ? '本次使用结构参考；依照元素关系、层级和语义构图，不要模仿编辑器占位形态。'
        : '画面参考只表达构图与光影；其中的辅助轮廓和文字区域不是最终材质或字形。'
    ].filter(Boolean)
    const prompt = sections.join('\n\n').slice(0, 8_000)
    const negativePrompt = [
      ...(referenceMode === 'visual' ? [] : ir.prohibitions),
      ...(referenceMode === 'visual' ? [] : promptPackage?.negativeConstraints ?? []),
      '错误文字、额外标签、虚线选择框、透明塑料般的错误材质、错误层级、杂乱构图。',
      ...(referenceMode !== 'visual' && promptPackage?.textContract.some((text) => text.visualWeight !== 'hero') === true
        ? ['避免广告牌式巨大标题、粗重默认字体、复制占位字形；给非主视觉文字保留呼吸空间。']
        : [])
    ].join(' ').slice(0, 4_000)
    const usesComposite = referenceMode !== 'structure' && capabilities.imageReferences
    const warnings = referenceMode === 'structure' || capabilities.imageReferences
      ? []
      : [referenceMode === 'visual'
          ? '当前供应商不支持画面参考；本次无法按“画面参考”发送图片。'
          : '当前供应商不支持参考图，“同时参考”已明确适配为结构参考。']
    return providerCompiledPromptSchema.parse({
      providerId,
      prompt,
      negativePrompt,
      referenceStrategy: usesComposite ? 'composite' : 'text-only',
      referenceMode,
      warnings
    })
  }
}
