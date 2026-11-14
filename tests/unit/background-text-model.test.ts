import { describe, expect, it, vi } from 'vitest'
import { BackgroundTextModel, type BackgroundTextReply } from '../../src/main/llm/background-text-model'
import { DEFAULT_PROVIDER_CONFIG, newTextHelperConfig, type ProviderConfigFile } from '../../src/shared/provider-settings'

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

function reply(text: string): Response {
  return json({ id: 'c1', choices: [{ finish_reason: 'stop', message: { content: text } }], usage: { prompt_tokens: 120, completion_tokens: 8 } })
}

function setup(options: { readonly fast: boolean; readonly keys: readonly string[]; readonly fetcher: typeof fetch }) {
  const base = structuredClone(DEFAULT_PROVIDER_CONFIG)
  const [main, ...rest] = base.providers
  const config: ProviderConfigFile = {
    ...base,
    providers: [{ ...main!, protocol: 'openai-chat-completions', baseUrl: 'https://main.example.test/v1', defaultModel: 'main-1', pricing: null }, ...rest] as ProviderConfigFile['providers'],
    textHelpers: {
      vision: null,
      backup: null,
      fast: options.fast ? { ...newTextHelperConfig('fast'), baseUrl: 'https://fast.example.test/v1', defaultModel: 'fast-1', pricing: { inputPerMillionCny: 1, cachedInputPerMillionCny: null, outputPerMillionCny: 2 } } : null
    }
  }
  const recorded: BackgroundTextReply[] = []
  const model = new BackgroundTextModel({
    config: { read: async () => config },
    secrets: { has: async (id) => options.keys.includes(id), get: async (id) => options.keys.includes(id) ? `${id}-key` : null },
    authorization: { reserve: async () => undefined },
    fetcher: options.fetcher,
    recordUsage: async (value) => { recorded.push(value) }
  })
  return { model, recorded }
}

describe('background text model', () => {
  it('asks the fast model first and records what it used', async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      expect(String(url)).toBe('https://fast.example.test/v1/chat/completions')
      return reply('晨雾新品海报')
    })
    const { model, recorded } = setup({ fast: true, keys: ['text-model-fast', 'openai-compatible-llm'], fetcher })
    await expect(model.complete({ system: 's', prompt: 'p' })).resolves.toMatchObject({ text: '晨雾新品海报', served: 'fast', inputTokens: 120, outputTokens: 8 })
    expect(recorded).toEqual([expect.objectContaining({ served: 'fast', estimatedCostCny: expect.any(Number) })])
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('falls back to the main model when the fast one fails', async () => {
    const urls: string[] = []
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      urls.push(String(url))
      return String(url).startsWith('https://fast.') ? json({ error: { message: 'down' } }, 503) : reply('ok')
    })
    const { model } = setup({ fast: true, keys: ['text-model-fast', 'openai-compatible-llm'], fetcher })
    await expect(model.complete({ system: 's', prompt: 'p' })).resolves.toMatchObject({ text: 'ok', served: 'main', estimatedCostCny: null })
    expect(urls).toEqual(['https://fast.example.test/v1/chat/completions', 'https://main.example.test/v1/chat/completions'])
  })

  it('uses the main model when no fast model is set', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => reply('ok'))
    const { model } = setup({ fast: false, keys: ['openai-compatible-llm'], fetcher })
    await expect(model.complete({ system: 's', prompt: 'p' })).resolves.toMatchObject({ served: 'main' })
  })

  it('skips without a key for either model, and when every model fails', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => json({ error: { message: 'nope' } }, 500))
    const none = setup({ fast: true, keys: [], fetcher })
    expect(await none.model.available()).toBe(false)
    await expect(none.model.complete({ system: 's', prompt: 'p' })).resolves.toBeNull()
    expect(fetcher).not.toHaveBeenCalled()
    const failing = setup({ fast: true, keys: ['text-model-fast', 'openai-compatible-llm'], fetcher })
    await expect(failing.model.complete({ system: 's', prompt: 'p' })).resolves.toBeNull()
    expect(failing.recorded).toEqual([])
  })
})

describe('background usage', () => {
  it('counts a billed reply with no words before falling back', async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) => String(url).startsWith('https://fast.')
      ? json({ id: 'c0', choices: [{ finish_reason: 'length', message: { content: '' } }], usage: { prompt_tokens: 300, completion_tokens: 1024 } })
      : reply('ok'))
    const { model, recorded } = setup({ fast: true, keys: ['text-model-fast', 'openai-compatible-llm'], fetcher })
    await expect(model.complete({ system: 's', prompt: 'p' })).resolves.toMatchObject({ served: 'main' })
    expect(recorded.map((entry) => [entry.served, entry.outputTokens])).toEqual([['fast', 1024], ['main', 8]])
  })
})
