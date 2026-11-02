import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { ServiceConnectCard } from '../../src/renderer/src/components/ServiceConnectCard'
import { useFirstRunStore } from '../../src/renderer/src/store/first-run-store'
import { DEFAULT_PROVIDER_CONFIG, type ProviderSettingsSnapshot } from '../../src/shared/provider-settings'

function settings(llmConfigured: boolean): ProviderSettingsSnapshot {
  const [llm, image] = DEFAULT_PROVIDER_CONFIG.providers
  return {
    providers: [{ ...llm, configured: llmConfigured }, { ...image, configured: false }],
    defaultImageProviderId: 'image-provider',
    realCallsAuthorized: false,
    executionPolicy: DEFAULT_PROVIDER_CONFIG.executionPolicy,
    textHelpers: { vision: null, backup: null },
    checks: {}
  }
}

const passed = {
  ok: true, toolCallingVerified: true, failure: null, providerId: 'openai-compatible-llm', providerLabel: 'DeepSeek', protocol: 'openai-chat-completions',
  model: 'deepseek-chat', endpoint: 'https://api.deepseek.com/chat/completions', checkedAt: '2026-11-01T00:00:00.000Z', requestsUsed: 2, generatedImages: 0, costCeilingCny: 0.05
}

function desktop(result: unknown) {
  let configured = false
  const value = {
    getProviderSettings: vi.fn(async () => settings(configured)),
    setProviderConfig: vi.fn(async () => settings(configured)),
    setProviderSecret: vi.fn(async () => { configured = true; return settings(true) }),
    validateProviderConnection: vi.fn(async () => result)
  }
  Object.defineProperty(window, 'desktop', { configurable: true, value })
  return value
}

beforeEach(() => {
  localStorage.clear()
  useFirstRunStore.setState({ guideDismissed: false, serviceCardDismissed: false })
})

it('connects Ark with one key for text and pictures, then offers the next step', async () => {
  const api = desktop(passed)
  const onCreateBlank = vi.fn()
  render(<ServiceConnectCard onCreateBlank={onCreateBlank} onShowExamples={() => undefined} />)
  await act(async () => undefined)
  expect(screen.getByRole('button', { name: /火山方舟/ })).toHaveAttribute('aria-pressed', 'true')
  // Ark has a known model, so only the key is asked for.
  expect(screen.queryByRole('textbox', { name: '模型名' })).not.toBeInTheDocument()
  const test = screen.getByRole('button', { name: '保存并测试连接' })
  expect(test).toBeDisabled()
  fireEvent.change(screen.getByLabelText('Key'), { target: { value: ' ark-key-123456 ' } })
  await act(async () => { fireEvent.click(test) })

  expect(api.setProviderConfig).toHaveBeenCalledWith(expect.objectContaining({ id: 'openai-compatible-llm', protocol: 'ark-responses', defaultModel: 'doubao-seed-2-1-turbo-260628' }))
  expect(api.setProviderSecret).toHaveBeenCalledWith({ providerId: 'openai-compatible-llm', apiKey: 'ark-key-123456' })
  expect(api.setProviderSecret).toHaveBeenCalledWith({ providerId: 'image-provider', apiKey: 'ark-key-123456' })
  expect(api.validateProviderConnection).toHaveBeenCalledWith({ providerId: 'openai-compatible-llm', confirmed: true, scope: 'tool_call' })
  expect(screen.getByText('连好了')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '新建空白作品' }))
  expect(onCreateBlank).toHaveBeenCalledOnce()
})

it('asks for a model name where the vendor has none, and keeps the key off the image service', async () => {
  const api = desktop(passed)
  render(<ServiceConnectCard onCreateBlank={() => undefined} onShowExamples={() => undefined} />)
  await act(async () => undefined)
  fireEvent.click(screen.getByRole('button', { name: /Kimi/ }))
  fireEvent.change(screen.getByLabelText('Key'), { target: { value: 'sk-kimi-123456' } })
  expect(screen.getByRole('button', { name: '保存并测试连接' })).toBeDisabled()
  fireEvent.change(screen.getByRole('textbox', { name: '模型名' }), { target: { value: 'kimi-k2' } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存并测试连接' })) })
  expect(api.setProviderConfig).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: 'https://api.moonshot.cn/v1', protocol: 'openai-chat-completions', defaultModel: 'kimi-k2', label: 'Kimi · kimi-k2' }))
  expect(api.setProviderSecret).toHaveBeenCalledTimes(1)
})

it('stays up with the reason when the test fails, though the key was saved', async () => {
  desktop({ ...passed, ok: false, toolCallingVerified: false, failure: { code: 'auth', title: 'Key 不对', detail: '服务说这个 Key 无效。', nextAction: '到控制台复制一个新的 Key。', httpStatus: 401, contentType: null } })
  render(<ServiceConnectCard onCreateBlank={() => undefined} onShowExamples={() => undefined} />)
  await act(async () => undefined)
  fireEvent.change(screen.getByLabelText('Key'), { target: { value: 'ark-key-wrong-1' } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存并测试连接' })) })
  expect(screen.getByRole('alert')).toHaveTextContent('Key 不对')
  expect(screen.getByRole('alert')).toHaveTextContent('到控制台复制一个新的 Key。')
})

it('is not shown once a text model has a key, and 「先用示例看看」 puts it away for good', async () => {
  desktop(passed)
  const onShowExamples = vi.fn()
  const first = render(<ServiceConnectCard onCreateBlank={() => undefined} onShowExamples={onShowExamples} />)
  await act(async () => undefined)
  fireEvent.click(screen.getByRole('button', { name: '先用示例看看' }))
  expect(onShowExamples).toHaveBeenCalledOnce()
  expect(screen.queryByRole('region', { name: '连上服务' })).not.toBeInTheDocument()
  expect(localStorage.getItem('ai-canvas.service-connect.dismissed')).toBe('true')
  first.unmount()

  useFirstRunStore.getState().showAgain()
  const api = desktop(passed)
  api.getProviderSettings.mockResolvedValue(settings(true))
  render(<ServiceConnectCard onCreateBlank={() => undefined} onShowExamples={() => undefined} />)
  await act(async () => undefined)
  expect(screen.queryByRole('region', { name: '连上服务' })).not.toBeInTheDocument()
})
