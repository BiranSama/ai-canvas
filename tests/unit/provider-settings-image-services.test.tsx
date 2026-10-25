import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ProviderSettingsSheet } from '../../src/renderer/src/components/ProviderSettingsSheet'
import { DEFAULT_PROVIDER_CONFIG, type ProviderSettingsSnapshot } from '../../src/shared/provider-settings'

const ADDED = 'image-provider-b7c1d2e3'

function snapshot(defaultImageProviderId: string, withAdded: boolean): ProviderSettingsSnapshot {
  const [llm, primary] = DEFAULT_PROVIDER_CONFIG.providers
  return {
    providers: [
      { ...llm, configured: true },
      { ...primary, configured: true },
      ...(withAdded ? [{ ...primary, id: ADDED, label: 'Grok Imagine', baseUrl: 'https://api.x.ai/v1', defaultModel: 'grok-imagine-image', protocol: 'openai-images' as const, configured: false }] : [])
    ],
    defaultImageProviderId,
    realCallsAuthorized: true,
    executionPolicy: DEFAULT_PROVIDER_CONFIG.executionPolicy
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

it('adds an image service, makes it the default and removes it after a second click', async () => {
  const desktop = {
    getProviderSettings: vi.fn(async () => snapshot('image-provider', false)),
    getRuntimeInfo: vi.fn(async () => { throw new Error('not needed') }),
    listGenerationProfiles: vi.fn(async () => ({ realCallsAuthorized: true, profiles: [] })),
    addImageProvider: vi.fn(async () => snapshot('image-provider', true)),
    setDefaultImageProvider: vi.fn(async (id: string) => snapshot(id, true)),
    removeImageProvider: vi.fn(async () => snapshot('image-provider', false))
  }
  Object.defineProperty(window, 'desktop', { configurable: true, value: desktop })
  render(<ProviderSettingsSheet onClose={() => undefined} />)
  await act(async () => undefined)

  // One image service: no default mark, no set-default button, nothing to delete.
  expect(screen.queryByText('默认')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /设为默认生图服务/ })).not.toBeInTheDocument()

  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /添加生图服务/ })) })
  expect(desktop.addImageProvider).toHaveBeenCalledOnce()
  expect(screen.getByText('默认')).toBeInTheDocument()
  // The new service opens for editing and offers deletion; the primary never does.
  const added = screen.getByRole('button', { name: '删除生图服务 Grok Imagine' })
  expect(screen.queryByRole('button', { name: /删除生图服务 火山方舟/ })).not.toBeInTheDocument()

  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '把 Grok Imagine 设为默认生图服务' })) })
  expect(desktop.setDefaultImageProvider).toHaveBeenCalledWith(ADDED)
  expect(screen.getByRole('button', { name: '把 火山方舟 · Seedream 5.0 设为默认生图服务' })).toBeInTheDocument()

  const removeRow = added.closest('.provider-service-remove') as HTMLElement
  fireEvent.click(added)
  expect(desktop.removeImageProvider).not.toHaveBeenCalled()
  const confirm = within(removeRow).getByRole('button', { name: '确认删除' })
  await act(async () => { fireEvent.click(confirm) })
  expect(desktop.removeImageProvider).toHaveBeenCalledWith(ADDED)
  expect(screen.queryByText('Grok Imagine')).not.toBeInTheDocument()
})

it('saves how many steps the Agent may take each turn, apart from the image-task request limit', async () => {
  const desktop = {
    getProviderSettings: vi.fn(async () => snapshot('image-provider', false)),
    getRuntimeInfo: vi.fn(async () => { throw new Error('not needed') }),
    listGenerationProfiles: vi.fn(async () => ({ realCallsAuthorized: true, profiles: [] })),
    setProviderExecutionPolicy: vi.fn(async (policy: ProviderSettingsSnapshot['executionPolicy']) => ({ ...snapshot('image-provider', false), executionPolicy: policy }))
  }
  Object.defineProperty(window, 'desktop', { configurable: true, value: desktop })
  render(<ProviderSettingsSheet onClose={() => undefined} />)
  await act(async () => undefined)

  const steps = screen.getByRole('combobox', { name: 'Agent 每轮步数' })
  expect(steps).toHaveValue('1')
  expect(screen.getAllByText(/与图片任务的请求数无关/).length).toBeGreaterThan(0)
  fireEvent.change(steps, { target: { value: '4' } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存执行边界' })) })
  expect(desktop.setProviderExecutionPolicy).toHaveBeenCalledWith(expect.objectContaining({ agentStepScale: 4, maxRequestsPerJob: DEFAULT_PROVIDER_CONFIG.executionPolicy.maxRequestsPerJob }))
  expect(screen.getAllByText(/标准的 4 倍/).length).toBeGreaterThan(0)
})
