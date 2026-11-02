import type { LlmProtocol, ProviderPublicConfig } from './provider-settings'

type LlmConfig = Extract<ProviderPublicConfig, { kind: 'llm' }>

/**
 * A text-model vendor as a person picks it: the address and the kind of
 * interface are filled in, the model where a stable name is known. Batch F
 * brings these into the settings with prices and capability labels.
 */
export interface LlmVendorPreset {
  readonly id: string
  readonly label: string
  /** One line under the name, in the person's words. */
  readonly note: string
  readonly baseUrl: string
  readonly protocol: LlmProtocol
  /** A model name to start from; empty when the vendor's console is the place to look it up. */
  readonly model: string
  readonly vision: boolean
  /** Where to find a key, said plainly. */
  readonly keyHint: string
  /** The same key also works for the vendor's image service, already set up by default. */
  readonly sharesKeyWithImage?: boolean
}

export const LLM_VENDOR_PRESETS: readonly LlmVendorPreset[] = [
  {
    id: 'ark',
    label: '火山方舟',
    note: '推荐：一个 Key 同时用于文字和生图',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    protocol: 'ark-responses',
    model: 'doubao-seed-2-1-turbo-260628',
    vision: true,
    keyHint: '在火山方舟控制台的「API Key 管理」里创建',
    sharesKeyWithImage: true
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    note: '只有文字，生图要另外连一个服务',
    baseUrl: 'https://api.deepseek.com',
    protocol: 'openai-chat-completions',
    model: 'deepseek-chat',
    vision: false,
    keyHint: '在 DeepSeek 开放平台的「API keys」里创建'
  },
  {
    id: 'qwen',
    label: '通义千问',
    note: '阿里云百炼',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    protocol: 'openai-chat-completions',
    model: '',
    vision: false,
    keyHint: '在阿里云百炼控制台的「API-KEY」里创建'
  },
  {
    id: 'kimi',
    label: 'Kimi',
    note: '月之暗面',
    baseUrl: 'https://api.moonshot.cn/v1',
    protocol: 'openai-chat-completions',
    model: '',
    vision: false,
    keyHint: '在 Kimi 开放平台的「API Key 管理」里创建'
  },
  {
    id: 'glm',
    label: '智谱',
    note: 'GLM 系列',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    protocol: 'openai-chat-completions',
    model: '',
    vision: false,
    keyHint: '在智谱开放平台的「API Keys」里创建'
  },
  {
    id: 'openai',
    label: 'OpenAI',
    note: '需要能访问 OpenAI 的网络',
    baseUrl: 'https://api.openai.com/v1',
    protocol: 'openai-responses',
    model: '',
    vision: true,
    keyHint: '在 OpenAI 平台的「API keys」里创建'
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    note: 'Claude 系列，需要能访问 Anthropic 的网络',
    baseUrl: 'https://api.anthropic.com',
    protocol: 'anthropic-messages',
    model: '',
    vision: true,
    keyHint: '在 Anthropic Console 的「API keys」里创建'
  },
  {
    id: 'custom',
    label: '其他（OpenAI 兼容）',
    note: '填服务商给的地址和模型名',
    baseUrl: '',
    protocol: 'openai-chat-completions',
    model: '',
    vision: false,
    keyHint: '用服务商给你的 Key'
  }
]

export function llmVendorPreset(id: string): LlmVendorPreset {
  return LLM_VENDOR_PRESETS.find((preset) => preset.id === id) ?? LLM_VENDOR_PRESETS[0]!
}

/** The vendor a saved text model reads as, by its address; null when none of the presets matches. */
export function matchLlmVendor(config: Pick<LlmConfig, 'baseUrl'>): LlmVendorPreset | null {
  let host = ''
  try {
    host = new URL(config.baseUrl).hostname.toLowerCase()
  } catch {
    return null
  }
  return LLM_VENDOR_PRESETS.find((preset) => preset.baseUrl !== '' && new URL(preset.baseUrl).hostname === host) ?? null
}

/** The saved text model with a vendor's address, interface, model and capabilities; the rest of its settings stay. */
export function applyLlmVendor(config: LlmConfig, preset: LlmVendorPreset, model: string, baseUrl = preset.baseUrl): LlmConfig {
  return {
    ...config,
    label: model.trim() === '' ? preset.label : `${preset.label} · ${model.trim()}`,
    baseUrl: baseUrl.trim(),
    protocol: preset.protocol,
    defaultModel: model.trim(),
    capabilities: { ...config.capabilities, streaming: true, toolCalling: true, vision: preset.vision }
  }
}

type ImageConfig = Extract<ProviderPublicConfig, { kind: 'image' }>

/** An image service as a person picks it; the capabilities are what this app can use of it. */
export interface ImageVendorPreset {
  readonly id: string
  readonly label: string
  readonly baseUrl: string
  readonly protocol: ImageConfig['protocol']
  readonly model: string
  readonly capabilities: ImageConfig['capabilities']
}

export const IMAGE_VENDOR_PRESETS: readonly ImageVendorPreset[] = [
  {
    id: 'ark-seedream',
    label: '火山方舟 Seedream',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    protocol: 'ark-seedream',
    model: 'doubao-seedream-5-0-260128',
    capabilities: { textToImage: true, imageReferences: true, maskEditing: true, multipleReferences: true, transparentOutput: false }
  },
  {
    id: 'openai-images',
    label: 'OpenAI 图片',
    baseUrl: 'https://api.openai.com/v1',
    protocol: 'openai-images',
    model: 'gpt-image-1',
    capabilities: { textToImage: true, imageReferences: true, maskEditing: true, multipleReferences: true, transparentOutput: true }
  },
  {
    id: 'grok-imagine',
    label: 'Grok Imagine',
    baseUrl: 'https://api.x.ai/v1',
    protocol: 'openai-images',
    model: 'grok-imagine-image',
    capabilities: { textToImage: true, imageReferences: false, maskEditing: false, multipleReferences: false, transparentOutput: false }
  },
  {
    id: 'custom-openai-images',
    label: '其他（OpenAI 图片兼容）',
    baseUrl: '',
    protocol: 'openai-images',
    model: '',
    capabilities: { textToImage: true, imageReferences: false, maskEditing: false, multipleReferences: false, transparentOutput: false }
  },
  {
    id: 'custom-task-images',
    label: '其他（异步任务接口）',
    baseUrl: '',
    protocol: 'task-images',
    model: '',
    capabilities: { textToImage: true, imageReferences: false, maskEditing: false, multipleReferences: false, transparentOutput: false }
  }
]

/** The preset a saved image service reads as: by address and interface; the custom ones by interface alone; null when it is not set up. */
export function matchImageVendor(config: Pick<ImageConfig, 'baseUrl' | 'protocol'>): ImageVendorPreset | null {
  if (config.protocol === 'unconfigured') return null
  let host = ''
  try { host = new URL(config.baseUrl).hostname.toLowerCase() } catch { /* not filled in yet */ }
  const known = IMAGE_VENDOR_PRESETS.find((preset) => preset.baseUrl !== '' && preset.protocol === config.protocol && new URL(preset.baseUrl).hostname === host)
  return known ?? IMAGE_VENDOR_PRESETS.find((preset) => preset.baseUrl === '' && preset.protocol === config.protocol) ?? null
}

/** The saved image service with a vendor's address, interface, model and capabilities; a custom vendor keeps what was typed. */
export function applyImageVendor(config: ImageConfig, preset: ImageVendorPreset): ImageConfig {
  const custom = preset.baseUrl === ''
  return {
    ...config,
    label: custom ? config.label : preset.label,
    baseUrl: custom ? config.baseUrl : preset.baseUrl,
    protocol: preset.protocol,
    defaultModel: custom ? config.defaultModel : preset.model,
    capabilities: preset.capabilities
  }
}
