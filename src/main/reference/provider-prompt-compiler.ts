import type { ProviderCapabilities } from '../../shared/generation'
import { providerCompiledPromptSchema, type PromptIr, type PromptIrElement, type PromptPackage, type ProviderCompiledPrompt } from '../../shared/reference'
import { blendModeIntent, blendModeLabel } from '../../shared/blend-mode'

function percentage(value: unknown): string {
  return typeof value === 'number' ? `${Math.round(value * 100)}%` : '未指定'
}

function describeElement(element: PromptIrElement, promptPackage?: PromptPackage): string {
  const bounds = element.bounds
  const position = `位置 x=${percentage(bounds.x)} y=${percentage(bounds.y)}，尺寸 ${percentage(bounds.width)}×${percentage(bounds.height)}，层级 ${element.zIndex}`
  const blend = element.blendMode === 'normal' ? '' : `；混合：${blendModeLabel(element.blendMode)}，${blendModeIntent(element.blendMode)}`
  if (element.type === 'text') {
    const contract = promptPackage?.textContract.find((entry) => entry.elementId === element.id)
    const content = contract?.content ?? String(element.attributes.content ?? '')
    const style = contract?.style ?? String(element.attributes.styleDescription ?? element.description)
    const accuracy = contract?.accuracy ?? (element.attributes.accuracy as 'strict' | 'balanced' | 'expressive')
    const mode = contract?.mode ?? (element.attributes.renderStrategy === 'editable-overlay' ? 'exact-overlay' : element.attributes.renderStrategy === 'standard' ? 'reference' : 'image-text')
    const visualWeight = contract?.visualWeight ?? String(element.attributes.visualWeight ?? 'secondary')
    const accuracyCopy = accuracy === 'strict' ? '内容需严格准确' : accuracy === 'balanced' ? '尽量保持内容，允许为整体节奏做有限调整' : '内容可服从字效表现'
    if (mode === 'exact-overlay') {
      return `可编辑文字预留区“${content}”：不要在背景中生成或烘焙字形，只保留适合后续独立文字图层的负空间；视觉权重 ${visualWeight}；${style}；${position}${blend}`
    }
    if (mode === 'image-text') {
      return `AI 字效“${content}”：${accuracyCopy}；由模型重新设计字形、材质、笔触与光影，当前占位字体和字号不是最终形态；视觉权重 ${visualWeight}；${style}；${position}${blend}`
    }
    return `文字参考“${content}”：${accuracyCopy}；内容、区域、层级和节奏是参考，重新设计字形与尺度，不复制当前占位字体或字号；视觉权重 ${visualWeight}；${style}；${position}${blend}`
  }
  if (element.type === 'placeholder') {
    return `主体：${String(element.attributes.subject ?? element.name)}；姿态 ${String(element.attributes.pose ?? '')}，朝向 ${String(element.attributes.facing ?? '')}；${String(element.attributes.generationNotes ?? '')}；${position}${blend}`
  }
  if (element.type === 'light') {
    return `光影：${element.description || element.name}；颜色 ${String(element.attributes.color ?? '')}，方向 ${String(element.attributes.direction ?? '')}°，强度 ${percentage(element.attributes.intensity)}，柔和度 ${percentage(element.attributes.softness)}；${position}${blend}`
  }
  if (element.type === 'image') return `图片参考“${element.name}”，用途 ${String(element.attributes.referenceRole ?? 'general')}；${element.description}；${position}${blend}`
  if (element.type === 'shape') return `${element.attributes.role === 'placeholder' ? '构图形状参考' : '最终形状'}“${element.name}”；${element.description}；${position}${blend}`
  if (element.type === 'sketch') return `构图草图“${element.name}”，轮廓保真 ${percentage(element.attributes.fidelity)}；${element.description}；${position}${blend}`
  return `${element.type}“${element.name}”；${element.description}；${position}${blend}`
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
      promptPackage === undefined ? '' : `创作目标：${promptPackage.sceneIntent.purpose}；媒介：${promptPackage.sceneIntent.medium.join('、')}。`,
      `输出画布：${output.aspectWidth}:${output.aspectHeight}，${output.outputWidth}×${output.outputHeight}。`,
      ir.canvas.globalStyle ? `全局风格：${ir.canvas.globalStyle}` : '',
      `按从后到前的层级组织：\n${visible.map((element) => `- ${describeElement(element, promptPackage)}${element.presentation === 'semantic-guide' ? '。这是构图语义参考，不是透明材质或最终标签' : ''}`).join('\n')}`,
      semanticGroupLines.length > 0 ? `语义组件：\n${semanticGroupLines.map((line) => `- ${line}`).join('\n')}` : '',
      relationLines.length > 0 ? `关系：\n${relationLines.map((line) => `- ${line}`).join('\n')}` : '',
      ir.occlusions.length > 0 ? `遮挡：\n${ir.occlusions.map((item) => `- ${item.instruction}`).join('\n')}` : '',
      protectedNames.length > 0 ? `保护：保持 ${protectedNames.map((name) => `“${name}”`).join('、')} 的位置、内容和身份不变。` : '',
      promptPackage === undefined || promptPackage.textContract.length === 0 ? '' : `文字合同：\n${promptPackage.textContract.map((text) => `- “${text.content}” / ${text.mode} / ${text.accuracy} / 视觉权重 ${text.visualWeight}；风格：${text.style}`).join('\n')}`,
      promptPackage === undefined || promptPackage.styleBible.length === 0 ? '' : `风格圣经：${promptPackage.styleBible.join('；')}`,
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
