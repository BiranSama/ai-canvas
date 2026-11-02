import { expect, it } from 'vitest'
import { DEFAULT_PROVIDER_CONFIG, llmProviderConfigSchema } from '../../src/shared/provider-settings'
import { applyLlmVendor, LLM_VENDOR_PRESETS, llmVendorPreset, matchLlmVendor } from '../../src/shared/vendor-presets'

const llm = DEFAULT_PROVIDER_CONFIG.providers[0]
if (llm.kind !== 'llm') throw new Error('fixture: the first provider is the text model')

it('fills a vendor in and keeps the rest of the saved text model', () => {
  const tuned = { ...llm, timeoutMs: 123_000, pricing: { inputPerMillionCny: 1, cachedInputPerMillionCny: null, outputPerMillionCny: 2 } }
  const next = applyLlmVendor(tuned, llmVendorPreset('deepseek'), 'deepseek-chat')
  expect(next).toMatchObject({
    id: 'openai-compatible-llm',
    label: 'DeepSeek · deepseek-chat',
    baseUrl: 'https://api.deepseek.com',
    protocol: 'openai-chat-completions',
    defaultModel: 'deepseek-chat',
    timeoutMs: 123_000,
    capabilities: { streaming: true, toolCalling: true, vision: false }
  })
  expect(next.pricing).toEqual(tuned.pricing)
  // Each preset, with a model filled in, is a text model the settings accept.
  for (const preset of LLM_VENDOR_PRESETS) {
    const filled = applyLlmVendor(llm, preset, preset.model || 'some-model', preset.baseUrl || 'https://llm.example.com/v1')
    expect(llmProviderConfigSchema.safeParse(filled).success, preset.id).toBe(true)
  }
})

it('takes the address a person typed for an OpenAI-compatible service', () => {
  const next = applyLlmVendor(llm, llmVendorPreset('custom'), ' my-model ', ' https://llm.example.com/v1 ')
  expect(next).toMatchObject({ baseUrl: 'https://llm.example.com/v1', defaultModel: 'my-model', label: '其他（OpenAI 兼容） · my-model' })
})

it('reads a saved text model back as its vendor by address', () => {
  expect(matchLlmVendor({ baseUrl: 'https://ark.cn-beijing.volces.com/api/v3' })?.id).toBe('ark')
  expect(matchLlmVendor({ baseUrl: 'https://API.deepseek.com/v1' })?.id).toBe('deepseek')
  expect(matchLlmVendor({ baseUrl: 'https://llm.example.com/v1' })).toBeNull()
  expect(matchLlmVendor({ baseUrl: '' })).toBeNull()
  expect(llmVendorPreset('missing').id).toBe('ark')
})

it('fills an image service from a vendor and reads it back', async () => {
  const { applyImageVendor, IMAGE_VENDOR_PRESETS, matchImageVendor } = await import('../../src/shared/vendor-presets')
  const { imageProviderConfigSchema, newImageProviderConfig } = await import('../../src/shared/provider-settings')
  const blank = newImageProviderConfig('image-provider-a1b2')
  expect(matchImageVendor(blank)).toBeNull()
  for (const preset of IMAGE_VENDOR_PRESETS) {
    const filled = applyImageVendor(blank, preset)
    expect(imageProviderConfigSchema.safeParse(filled).success, preset.id).toBe(true)
    if (preset.baseUrl !== '') expect(matchImageVendor(filled)?.id).toBe(preset.id)
  }
  const openai = applyImageVendor(blank, IMAGE_VENDOR_PRESETS.find((preset) => preset.id === 'openai-images')!)
  expect(openai).toMatchObject({ label: 'OpenAI 图片', baseUrl: 'https://api.openai.com/v1', protocol: 'openai-images', defaultModel: 'gpt-image-1', capabilities: { transparentOutput: true } })
  // A custom vendor keeps what was typed and is read back by its interface.
  const typed = { ...openai, baseUrl: 'https://images.example.test/v1', defaultModel: 'house-image' }
  expect(matchImageVendor(typed)?.id).toBe('custom-openai-images')
  expect(applyImageVendor(typed, IMAGE_VENDOR_PRESETS.find((preset) => preset.id === 'custom-task-images')!)).toMatchObject({ baseUrl: 'https://images.example.test/v1', defaultModel: 'house-image', protocol: 'task-images' })
})
