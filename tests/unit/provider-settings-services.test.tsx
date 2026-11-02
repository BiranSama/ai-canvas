import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { ProviderSettingsSheet } from '../../src/renderer/src/components/ProviderSettingsSheet'
import { DEFAULT_PROVIDER_CONFIG, newTextHelperConfig, type ProviderCheck, type ProviderSettingsSnapshot } from '../../src/shared/provider-settings'

function snapshot(changes: Partial<ProviderSettingsSnapshot> = {}): ProviderSettingsSnapshot {
  const [llm, image] = DEFAULT_PROVIDER_CONFIG.providers
  return {
    providers: [{ ...llm, configured: true }, { ...image, configured: true }],
    defaultImageProviderId: 'image-provider',
    realCallsAuthorized: true,
    executionPolicy: DEFAULT_PROVIDER_CONFIG.executionPolicy,
    textHelpers: { vision: null, backup: null },
    checks: {},
    ...changes
  }
}

const failed: ProviderCheck = { ok: false, checkedAt: new Date().toISOString(), latencyMs: 1_200, summary: 'Key 没有被接受（HTTP 401）。到厂商控制台确认 Key 是否有效。' }

function desktop(initial: ProviderSettingsSnapshot) {
  const api = {
    getProviderSettings: vi.fn(async () => initial),
    getRuntimeInfo: vi.fn(async () => { throw new Error('not needed') }),
    listGenerationProfiles: vi.fn(async () => ({ realCallsAuthorized: true, profiles: [] })),
    getAgentEngine: vi.fn(async () => ({ active: 'multi-step', forcedByEnvironment: false })),
    checkProvider: vi.fn(async (id: string) => snapshot({ checks: { [id]: failed } })),
    addTextHelper: vi.fn(async () => snapshot({ textHelpers: { vision: { ...newTextHelperConfig('vision'), configured: false }, backup: null } })),
    removeTextHelper: vi.fn(async () => snapshot()),
    setProviderConfig: vi.fn(async () => initial)
  }
  Object.defineProperty(window, 'desktop', { configurable: true, value: api })
  return api
}

it('tests a service from its card and keeps the outcome there', async () => {
  const api = desktop(snapshot())
  render(<ProviderSettingsSheet onClose={() => undefined} />)
  await act(async () => undefined)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^测试 火山方舟 · Seedream/ })) })
  expect(api.checkProvider).toHaveBeenCalledWith('image-provider')
  expect(screen.getByTestId('image-provider-check')).toHaveTextContent('测试没通过 · 1.2 秒')
  expect(screen.getAllByText(failed.summary).length).toBeGreaterThan(0)
})

it('adds a vision model as its own card under the main one, and removes it', async () => {
  const api = desktop(snapshot())
  render(<ProviderSettingsSheet onClose={() => undefined} />)
  await act(async () => undefined)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /加一个看图模型/ })) })
  expect(api.addTextHelper).toHaveBeenCalledWith('vision')
  const cards = document.querySelectorAll('.provider-setting-row')
  expect(cards[1]).toHaveAttribute('data-provider-slot', 'vision')
  expect(within(cards[1] as HTMLElement).getByText('看图模型', { selector: '.provider-slot-label' })).toBeInTheDocument()
  // The new card opens for editing, with a vendor to pick and its own delete.
  expect(screen.getByLabelText('看图模型 厂商')).toBeInTheDocument()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '删除看图模型' })) })
  expect(api.removeTextHelper).toHaveBeenCalledWith('vision')
})

it('fills the text model from a vendor, with the interface type under 高级', async () => {
  const api = desktop(snapshot())
  render(<ProviderSettingsSheet onClose={() => undefined} initialProviderId="openai-compatible-llm" />)
  await act(async () => undefined)
  const vendor = screen.getByLabelText('LLM Provider 厂商') as HTMLSelectElement
  expect(vendor.value).toBe('ark')
  fireEvent.change(vendor, { target: { value: 'deepseek' } })
  expect(screen.getByLabelText('LLM Provider API 地址')).toHaveValue('https://api.deepseek.com')
  expect(screen.getByLabelText('LLM Provider 默认模型')).toHaveValue('deepseek-chat')
  const protocol = screen.getByLabelText('LLM Provider 调用协议') as HTMLSelectElement
  expect(protocol.closest('details')).toHaveAttribute('data-testid', 'openai-compatible-llm-advanced')
  expect(protocol.value).toBe('openai-chat-completions')
  await act(async () => { fireEvent.click(within(protocol.closest('.provider-editor') as HTMLElement).getByRole('button', { name: '保存' })) })
  expect(api.setProviderConfig).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: 'https://api.deepseek.com', protocol: 'openai-chat-completions', defaultModel: 'deepseek-chat', capabilities: expect.objectContaining({ vision: false }) }))
})

it('shows what each image service can do', async () => {
  desktop(snapshot())
  render(<ProviderSettingsSheet onClose={() => undefined} />)
  await act(async () => undefined)
  expect(screen.getByLabelText('火山方舟 · Seedream 5.0 能做什么')).toHaveTextContent('文生图参考图局部修改多张参考')
})
