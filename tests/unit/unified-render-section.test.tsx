import { act, fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { UnifiedRenderSection } from '../../src/renderer/src/components/UnifiedRenderSection'

it('names the service and price and sends only after a second click', async () => {
  const startUnifiedRender = vi.fn(async () => ({ jobId: 'job', jobStatus: 'queued', sourceAssetId: 'a', coveredElementIds: [] }))
  Object.defineProperty(window, 'desktop', { configurable: true, value: {
    getProviderSettings: vi.fn(async () => ({
      defaultImageProviderId: 'image-provider',
      providers: [{ id: 'image-provider', kind: 'image', label: '火山方舟', defaultModel: 'seedream', protocol: 'ark-seedream', configured: true, pricePerImageCny: 0.25 }]
    })),
    startUnifiedRender
  } })
  render(<UnifiedRenderSection />)
  await act(async () => undefined)
  fireEvent.change(screen.getByRole('textbox', { name: '统一重绘的要求' }), { target: { value: ' 胶片质感 ' } })
  fireEvent.click(screen.getByRole('button', { name: '统一重绘…' }))
  expect(startUnifiedRender).not.toHaveBeenCalled()
  expect(screen.getByRole('group', { name: '确认统一重绘' })).toHaveTextContent('会向 火山方舟（seedream）发 1 个真实请求，约 ¥0.25。')
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '确认重绘' })) })
  expect(startUnifiedRender).toHaveBeenCalledWith({ requirement: '胶片质感', count: 1 })
  expect(screen.getByRole('status')).toHaveTextContent('已提交')
})

it('cannot start without a configured image service', async () => {
  Object.defineProperty(window, 'desktop', { configurable: true, value: { getProviderSettings: vi.fn(async () => ({ defaultImageProviderId: 'image-provider', providers: [] })) } })
  render(<UnifiedRenderSection />)
  await act(async () => undefined)
  expect(screen.getByText('还没有配置生图服务，先在设置里配置。')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '统一重绘…' })).toBeDisabled()
})
