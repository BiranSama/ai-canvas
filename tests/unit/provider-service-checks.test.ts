import { expect, it, vi } from 'vitest'
import { ProviderConnectionValidator } from '../../src/main/security/provider-connection-validator'
import { DEFAULT_PROVIDER_CONFIG, newTextHelperConfig, type ProviderConfigFile } from '../../src/shared/provider-settings'

function config(changes: Partial<ProviderConfigFile> = {}): ProviderConfigFile {
  return { ...structuredClone(DEFAULT_PROVIDER_CONFIG), ...changes }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

function validator(file: ProviderConfigFile, fetcher: typeof fetch, secrets: Record<string, string> = { 'image-provider': 'image-key-1234', 'text-model-vision': 'vision-key-1234', 'text-model-backup': 'backup-key-1234' }) {
  const authorization = { reserve: vi.fn(async () => undefined) }
  return {
    authorization,
    validator: new ProviderConnectionValidator({ config: { read: async () => structuredClone(file) }, secrets: { get: async (id) => secrets[id] ?? null }, authorization, fetcher })
  }
}

it('checks an image service with a request that cannot draw anything, and reads 400 as a key that was accepted', async () => {
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    expect(String(url)).toBe('https://ark.cn-beijing.volces.com/api/v3/images/generations')
    expect(JSON.parse(String(init?.body))).toEqual({ model: 'doubao-seedream-5-0-260128' })
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer image-key-1234')
    return json({ error: { code: 'MissingParameter', message: 'prompt is required' } }, 400)
  })
  const { validator: check, authorization } = validator(config(), fetcher)
  const result = await check.check('image-provider')
  expect(result).toMatchObject({ ok: true, summary: expect.stringContaining('没有生成图片') })
  expect(result.latencyMs).toBeGreaterThanOrEqual(0)
  expect(authorization.reserve).toHaveBeenCalledWith(expect.objectContaining({ images: 0, costCeilingCny: 0 }))
})

it('says what is wrong with an image service: the key, the address, or a missing setup', async () => {
  for (const [status, words] of [[401, 'Key 没有被接受'], [404, '地址不对'], [503, '服务暂时出错']] as const) {
    const { validator: check } = validator(config(), async () => json({ error: { message: 'nope' } }, status))
    await expect(check.check('image-provider')).resolves.toMatchObject({ ok: false, summary: expect.stringContaining(words) })
  }
  const empty = config()
  empty.providers[1] = { ...empty.providers[1], protocol: 'unconfigured' }
  const fetcher = vi.fn<typeof fetch>()
  const { validator: check } = validator(empty, fetcher)
  await expect(check.check('image-provider')).resolves.toMatchObject({ ok: false, summary: expect.stringContaining('先选接口类型') })
  expect(fetcher).not.toHaveBeenCalled()
})

it('checks the vision model by asking for the colour of a small square', async () => {
  const vision = { ...newTextHelperConfig('vision'), baseUrl: 'https://llm.example.test/v1', defaultModel: 'see-1' }
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: unknown }> }
    expect(JSON.stringify(body.messages)).toContain('data:image/png;base64,')
    return json({ id: 'c1', choices: [{ finish_reason: 'stop', message: { content: '红色' } }] })
  })
  const { validator: check } = validator(config({ textHelpers: { vision, backup: null } }), fetcher)
  await expect(check.check('text-model-vision')).resolves.toMatchObject({ ok: true, summary: '连上了，能看图。' })

  const blind = validator(config({ textHelpers: { vision, backup: null } }), async () => json({ id: 'c2', choices: [{ finish_reason: 'stop', message: { content: '我看不到图片' } }] }))
  await expect(blind.validator.check('text-model-vision')).resolves.toMatchObject({ ok: false, summary: expect.stringContaining('没有认出') })
})

it('checks the backup model with its own key, the same way as the main one', async () => {
  const helper = newTextHelperConfig('backup')
  const backup = { ...helper, baseUrl: 'https://backup.example.test/v1', defaultModel: 'backup-1', transport: { ...helper.transport, mode: 'buffered' as const } }
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    expect(String(url)).toBe('https://backup.example.test/v1/chat/completions')
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer backup-key-1234')
    return json({ id: 'c3', choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'verifyAiCanvasConnection', arguments: '{"ok":true}' } }] } }] })
  })
  const { validator: check } = validator(config({ textHelpers: { vision: null, backup } }), fetcher)
  await expect(check.check('text-model-backup')).resolves.toMatchObject({ ok: true, summary: '连上了，能调用工具。' })
  await expect(validator(config(), fetcher).validator.check('text-model-backup')).resolves.toMatchObject({ ok: false, summary: '还没有设置备用模型。' })
})

it.each(['buffered', 'stream'] as const)('checks a thinking OpenAI model through the service card with %s transport', async (mode) => {
  const file = config()
  file.providers[0] = { ...file.providers[0], baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-6.1-terra',
    protocol: 'openai-responses', reasoningEffort: 'medium', transport: { ...file.providers[0].transport, mode } }
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    if ('temperature' in body) return json({ error: { code: null, type: 'invalid_request_error', param: 'temperature', message: "Unsupported parameter: 'temperature' is not supported with this model." } }, 400)
    expect(body.reasoning).toEqual({ effort: 'medium' })
    expect(body.stream).toBe(mode === 'stream')
    const call = { type: 'function_call', call_id: 'call-openai-check', name: 'verifyAiCanvasConnection', arguments: '{"ok":true}' }
    const response = { id: 'resp-openai-check', status: 'completed', output: [call] }
    return mode === 'buffered' ? json(response) : new Response([
      `data: ${JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: call })}\n\n`,
      `data: ${JSON.stringify({ type: 'response.completed', response })}\n\n`
    ].join(''), { headers: { 'content-type': 'text/event-stream' } })
  })
  const { validator: check } = validator(file, fetcher, { 'openai-compatible-llm': 'fixture-main-key' })
  await expect(check.check('openai-compatible-llm')).resolves.toMatchObject({ ok: true, summary: '连上了，能调用工具。' })
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it('keeps an OpenAI error with a null code useful while redacting the credential and never retrying', async () => {
  const file = config()
  file.providers[0] = { ...file.providers[0], baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-6.1-terra',
    protocol: 'openai-responses', reasoningEffort: 'medium' }
  const secret = 'fixture-main-error-key'
  const fetcher = vi.fn<typeof fetch>(async () => json({ error: { code: null, type: 'invalid_request_error', param: 'temperature',
    message: `Unsupported parameter: 'temperature'. Credential ${secret}` } }, 400))
  const { validator: check } = validator(file, fetcher, { 'openai-compatible-llm': secret })
  const result = await check.check('openai-compatible-llm')
  expect(result.ok).toBe(false)
  expect(result.summary).toContain("Unsupported parameter: 'temperature'")
  expect(result.summary).not.toContain(secret)
  expect(fetcher).toHaveBeenCalledTimes(1)
})
