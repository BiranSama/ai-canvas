import type { EditRequest, GenerationRequest } from '../../shared/generation'

/**
 * Image models differ in what a prompt should carry. GPT Image and Seedream
 * take the frame from the prompt as well as from the size; Grok and Gemini
 * take it from a parameter only; Seedream reads 图1/图2 for references.
 */
export type ImagePromptFamily = 'gpt-image' | 'seedream' | 'grok' | 'gemini' | 'generic'

export function imagePromptFamily(model: string): ImagePromptFamily {
  if (/^(?:gpt-image-|chatgpt-image)/i.test(model)) return 'gpt-image'
  if (/(?:seedream|seededit)/i.test(model)) return 'seedream'
  if (/^grok-/i.test(model)) return 'grok'
  if (/^gemini-.*image|^imagen-/i.test(model)) return 'gemini'
  return 'generic'
}

function isEdit(request: GenerationRequest | EditRequest): request is EditRequest {
  return 'kind' in request && request.kind === 'edit'
}

/** The text sent as the prompt, shaped for the model family; one place for every protocol. */
export function familyPrompt(request: GenerationRequest | EditRequest, family: ImagePromptFamily = imagePromptFamily(request.model)): string {
  const negative = request.negativePrompt.trim()
  // Grok and Gemini set the frame through a parameter; repeating it in words only adds noise.
  const frame = family === 'grok' || family === 'gemini' ? '' : `画幅比例严格保持 ${request.aspectWidth}:${request.aspectHeight}。\n`
  const avoid = negative === '' ? '' : `\n\n避免出现：${negative}`
  const base = `${frame}${request.prompt}${avoid}`
  const requirement = family === 'seedream' && request.count > 1
    ? `请生成一组共 ${request.count} 张内容关联、主体与风格一致的图片。\n${base}`
    : base
  if (!isEdit(request) || family !== 'seedream') return requirement
  return [
    '这是一次视觉引导式局部编辑。图一是必须保留的原图；图二是带红色半透明标记的编辑指示图。',
    '只修改红色标记覆盖的区域，未标记区域、构图、主体身份、文字与光影关系尽量保持不变。',
    `编辑要求：${requirement}`
  ].join('\n')
}
