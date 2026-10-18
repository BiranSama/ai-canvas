import type { ProviderCapabilities } from './generation'
import type { ImageProtocol } from './provider-settings'
import type { FreeSizeRule, ImageSize } from './image-size-rules'

/*
 * What each image model accepts, shared by the request builders in Main and
 * the settings sheet, so the hints people read are the rules requests follow.
 */

export const ARK_SEEDREAM_CAPABILITIES: ProviderCapabilities = {
  textToImage: true,
  imageReferences: true,
  // Seedream has no native mask field. AI Canvas supports this through an
  // annotated visual-control reference, as recommended by the prompt guide.
  maskEditing: true,
  multipleReferences: true,
  transparentOutput: false,
  maxImages: 4,
  supportedRatios: ['custom'],
  supportedFormats: ['png', 'jpeg', 'webp']
}

/**
 * What a Seedream model accepts. Model families differ in their size range,
 * in whether they can return a related image set, and in whether seed and
 * guidance scale exist at all; sending a field a model does not support fails
 * the request.
 */
export interface SeedreamModelProfile {
  readonly presets: readonly string[]
  /** Free width x height range, or null when the model takes presets only. */
  readonly freeSize: FreeSizeRule | null
  /** `adaptive` lets the model keep the input image size (SeedEdit). */
  readonly adaptiveSize: boolean
  readonly sequentialImages: boolean
  readonly seedAndGuidance: boolean
  readonly maxImages: number
}

const SEEDREAM_ASPECT_LIMIT = 16

export function seedreamModelProfile(model: string): SeedreamModelProfile {
  if (/seedream-5-0-(?:pro|flash)/i.test(model)) {
    return {
      presets: ['1K', '1.5K', '2K'],
      freeSize: { multipleOf: 16, minPixels: 921_600, maxPixels: 4_624_220, maxAspect: SEEDREAM_ASPECT_LIMIT },
      adaptiveSize: false,
      sequentialImages: false,
      seedAndGuidance: false,
      maxImages: 1
    }
  }
  if (/seedream-5-0|seedream-4-5/i.test(model)) {
    return {
      presets: ['2K', '4K'],
      freeSize: { multipleOf: 16, minPixels: 3_686_400, maxPixels: 16_777_216, maxAspect: SEEDREAM_ASPECT_LIMIT },
      adaptiveSize: false,
      sequentialImages: true,
      seedAndGuidance: false,
      maxImages: 4
    }
  }
  if (/seedream-4-0/i.test(model)) {
    return {
      presets: ['1K', '2K', '4K'],
      freeSize: { multipleOf: 16, minPixels: 921_600, maxPixels: 16_777_216, maxAspect: SEEDREAM_ASPECT_LIMIT },
      adaptiveSize: false,
      sequentialImages: true,
      seedAndGuidance: false,
      maxImages: 4
    }
  }
  if (/seededit-3-0/i.test(model)) {
    return { presets: [], freeSize: null, adaptiveSize: true, sequentialImages: false, seedAndGuidance: true, maxImages: 1 }
  }
  if (/seedream-3-0/i.test(model)) {
    return {
      presets: [],
      freeSize: { multipleOf: 16, minPixels: 512 * 512, maxPixels: 2_048 * 2_048, minEdge: 512, maxEdge: 2_048, maxAspect: 4 },
      adaptiveSize: false,
      sequentialImages: false,
      seedAndGuidance: true,
      maxImages: 1
    }
  }
  // An unrecognised model gets only the request shape every current Seedream
  // model accepts: the 2K preset, one image, no optional controls.
  return { presets: ['2K'], freeSize: null, adaptiveSize: false, sequentialImages: false, seedAndGuidance: false, maxImages: 1 }
}

export function seedreamCapabilitiesFor(model: string): ProviderCapabilities {
  return { ...ARK_SEEDREAM_CAPABILITIES, maxImages: seedreamModelProfile(model).maxImages }
}

export const OPENAI_IMAGES_CAPABILITIES: ProviderCapabilities = {
  textToImage: true,
  imageReferences: true,
  maskEditing: true,
  multipleReferences: true,
  transparentOutput: true,
  maxImages: 4,
  supportedRatios: ['custom'],
  supportedFormats: ['png', 'jpeg', 'webp']
}

export const GPT_IMAGE_1_PRESETS: readonly ImageSize[] = [
  { width: 1024, height: 1024 },
  { width: 1536, height: 1024 },
  { width: 1024, height: 1536 }
]

// gpt-image-2 and later accept any size on a 16 px grid within these bounds.
export const GPT_IMAGE_FREE_SIZE: FreeSizeRule = {
  multipleOf: 16,
  minPixels: 655_360,
  maxPixels: 8_294_400,
  maxEdge: 3_840,
  maxAspect: 3
}

/** OpenAI's own image models: they always return Base64 and reject `response_format`. */
export function isGptImageModel(model: string): boolean {
  return /^(?:gpt-image-|chatgpt-image)/i.test(model)
}

export function hasPresetSizesOnly(model: string): boolean {
  return /^gpt-image-1(?:$|[.-])/i.test(model) || /^chatgpt-image/i.test(model)
}

/** Grok Imagine takes an aspect ratio and a 1k/2k resolution instead of pixel sizes. */
export function isGrokImageModel(model: string): boolean {
  return /^grok-/i.test(model)
}

export const GROK_ASPECT_RATIOS: readonly ImageSize[] = [
  { width: 1, height: 1 }, { width: 3, height: 4 }, { width: 4, height: 3 }, { width: 2, height: 3 },
  { width: 3, height: 2 }, { width: 9, height: 16 }, { width: 16, height: 9 }
]

export function openAiImagesCapabilitiesFor(model: string): ProviderCapabilities {
  if (!isGrokImageModel(model)) return OPENAI_IMAGES_CAPABILITIES
  // Reference inputs and edits are not mapped for Grok yet; only text-to-image is sent.
  return {
    ...OPENAI_IMAGES_CAPABILITIES,
    imageReferences: false,
    maskEditing: false,
    multipleReferences: false,
    transparentOutput: false,
    supportedFormats: ['jpeg', 'png']
  }
}

export const TASK_IMAGES_CAPABILITIES: ProviderCapabilities = {
  textToImage: true,
  imageReferences: false,
  maskEditing: false,
  multipleReferences: false,
  transparentOutput: false,
  maxImages: 1,
  supportedRatios: ['custom'],
  supportedFormats: ['png', 'jpeg', 'webp']
}

function tenThousands(pixels: number): string {
  return `${Math.round(pixels / 10_000)} 万`
}

function freeSizeText(rule: FreeSizeRule): string {
  return [
    `${tenThousands(rule.minPixels)}–${tenThousands(rule.maxPixels)}像素`,
    `边长取 ${rule.multipleOf} 的倍数`,
    ...(rule.maxEdge === undefined ? [] : [`长边不超过 ${rule.maxEdge}`]),
    `长宽比不超过 ${rule.maxAspect}:1`
  ].join('，')
}

function sizeList(sizes: readonly ImageSize[], separator: string): string {
  return sizes.map((size) => `${size.width}${separator}${size.height}`).join('、')
}

function supportText(capabilities: ProviderCapabilities): string {
  const supported = [
    capabilities.imageReferences ? '参考图' : null,
    capabilities.maskEditing ? '局部修改' : null,
    capabilities.transparentOutput ? '透明背景' : null
  ].filter((entry): entry is string => entry !== null)
  return supported.length === 0 ? '只按文字生成' : `支持${supported.join('、')}`
}

/**
 * What the configured image model accepts, in the words the settings sheet
 * shows, or null before a protocol and model are chosen.
 */
export function describeImageModel(protocol: ImageProtocol, model: string): string | null {
  const name = model.trim()
  if (protocol === 'unconfigured' || name === '') return null
  if (protocol === 'ark-seedream') {
    const profile = seedreamModelProfile(name)
    const recognized = /seedream-(?:3-0|4-0|4-5|5-0)|seededit-3-0/i.test(name)
    const sizes = [
      ...(profile.presets.length === 0 ? [] : [`预设 ${profile.presets.join('、')}`]),
      ...(profile.freeSize === null ? [] : [`自定义 ${freeSizeText(profile.freeSize)}`]),
      ...(profile.adaptiveSize ? ['沿用输入图尺寸'] : [])
    ]
    return [
      ...(recognized ? [] : ['没认出这个型号，按所有 Seedream 都接受的方式请求']),
      `尺寸：${sizes.join('；或')}`,
      `每次最多 ${profile.maxImages} 张${profile.sequentialImages ? '，可出关联组图' : ''}`,
      `${supportText(seedreamCapabilitiesFor(name))}（局部修改用标注图引导）`
    ].join('。') + '。'
  }
  if (protocol === 'openai-images') {
    const capabilities = openAiImagesCapabilitiesFor(name)
    if (!isGrokImageModel(name) && !isGptImageModel(name)) {
      return `尺寸：按画布尺寸原样发送，以服务文档为准。每次最多 ${capabilities.maxImages} 张。参考图、局部修改和透明背景按下面勾选的能力使用。`
    }
    const sizes = isGrokImageModel(name)
      ? `按画幅取最接近的比例（${sizeList(GROK_ASPECT_RATIOS, ':')}），长边超过 1536 用 2k，否则 1k`
      : hasPresetSizesOnly(name)
        ? `只有 ${sizeList(GPT_IMAGE_1_PRESETS, '×')}，按画幅取最接近的一个`
        : freeSizeText(GPT_IMAGE_FREE_SIZE)
    return [`尺寸：${sizes}`, `每次最多 ${capabilities.maxImages} 张`, supportText(capabilities)].join('。') + '。'
  }
  return `每次 ${TASK_IMAGES_CAPABILITIES.maxImages} 张。${supportText(TASK_IMAGES_CAPABILITIES)}。`
}
