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
  const { validator: check } = validator(config({ textHelpers: { vision, backup: null, fast: null } }), fetcher)
  await expect(check.check('text-model-vision')).resolves.toMatchObject({ ok: true, summary: '连上了，能看图。' })

  const blind = validator(config({ textHelpers: { vision, backup: null, fast: null } }), async () => json({ id: 'c2', choices: [{ finish_reason: 'stop', message: { content: '我看不到图片' } }] }))
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
  const { validator: check } = validator(config({ textHelpers: { vision: null, backup, fast: null } }), fetcher)
  await expect(check.check('text-model-backup')).resolves.toMatchObject({ ok: true, summary: '连上了，能调用工具。' })
  await expect(validator(config(), fetcher).validator.check('text-model-backup')).resolves.toMatchObject({ ok: false, summary: '还没有设置备用模型。' })
})
