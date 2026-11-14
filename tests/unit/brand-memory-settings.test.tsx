import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrandMemorySettings } from '../../src/renderer/src/components/BrandMemorySettings'
import { brandInputOf } from '../../src/renderer/src/components/brand-draft'
import { PendingPreferencesNotice } from '../../src/renderer/src/components/PendingPreferencesNotice'
import { FontPicker } from '../../src/renderer/src/components/FontPicker'
import { useBrandStore } from '../../src/renderer/src/store/brand-store'
import type { UserMemorySnapshot } from '../../src/shared/user-memory'

const NOW = '2026-11-14T00:00:00.000Z'

function snapshot(changes: Partial<UserMemorySnapshot> = {}): UserMemorySnapshot {
  return {
    brand: { name: '', logo: null, colors: [], titleFont: '', bodyFont: '', copy: [], bannedWords: [] },
    logoPreview: null,
    memories: [],
    candidates: [],
    learning: { enabled: true, signals: 0, newSignals: 0, lastSummaryAt: null },
    backgroundUsage: { calls: 0, inputTokens: 0, outputTokens: 0, estimatedCostCny: 0 },
    projectUsesBrand: true,
    ...changes
  }
}

function desktop(initial: UserMemorySnapshot) {
  const api = {
    getUserMemory: vi.fn(async () => initial),
    onUserMemoryChanged: vi.fn(() => () => undefined),
    saveBrandKit: vi.fn(async (input: UserMemorySnapshot['brand']) => snapshot({ brand: { ...input, logo: null } })),
    setBrandLogo: vi.fn(async () => initial),
    clearBrandLogo: vi.fn(async () => initial),
    changeUserMemory: vi.fn(async () => snapshot()),
    listLocalFonts: vi.fn(async () => [])
  }
  Object.defineProperty(window, 'desktop', { configurable: true, value: api })
  return api
}

afterEach(() => {
  useBrandStore.getState().set({ colors: [], fonts: [], hasLogo: false, pendingPreferences: 0 })
})

describe('品牌与记忆', () => {
  it('saves the brand with copy one line each and banned words split by commas', async () => {
    const api = desktop(snapshot())
    render(<BrandMemorySettings onStatus={() => undefined} />)
    await act(async () => undefined)
    fireEvent.change(screen.getByLabelText('品牌名'), { target: { value: '晨雾咖啡' } })
    fireEvent.change(screen.getByLabelText('常用文案'), { target: { value: '每天新鲜烘焙\n\n营业时间 8:00–20:00' } })
    fireEvent.change(screen.getByLabelText('禁用词'), { target: { value: '最，第一、 最' } })
    fireEvent.click(screen.getByRole('button', { name: /加一个颜色/ }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /保存品牌/ })) })
    expect(api.saveBrandKit).toHaveBeenCalledWith({ name: '晨雾咖啡', colors: ['#3b6fb6'], titleFont: '', bodyFont: '', copy: ['每天新鲜烘焙', '营业时间 8:00–20:00'], bannedWords: ['最', '第一'] })
  })

  it('confirms or ignores a learned preference, and turns learning off', async () => {
    const candidate = { id: '00000000-0000-4000-8000-000000000001', kind: 'preference' as const, content: '标题喜欢用衬线体', source: 'learned' as const, status: 'pending' as const, createdAt: NOW }
    const api = desktop(snapshot({ candidates: [candidate], learning: { enabled: true, signals: 14, newSignals: 2, lastSummaryAt: NOW } }))
    render(<BrandMemorySettings onStatus={() => undefined} />)
    await act(async () => undefined)
    expect(screen.getByText('有 1 条偏好等你确认')).toBeInTheDocument()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '确认 标题喜欢用衬线体' })) })
    expect(api.changeUserMemory).toHaveBeenCalledWith({ action: 'confirm', id: candidate.id })
    await act(async () => { fireEvent.click(screen.getByLabelText('从使用中学偏好')) })
    expect(api.changeUserMemory).toHaveBeenCalledWith({ action: 'learning', enabled: false })
  })

  it('refuses too many lines of copy before anything is sent', () => {
    expect(brandInputOf({ name: '', colors: [], titleFont: '', bodyFont: '', copy: Array.from({ length: 11 }, (_, index) => `第 ${index} 条`).join('\n'), bannedWords: '' })).toBe('常用文案最多 10 条。')
  })
})

describe('the brand in the editor', () => {
  it('lists the brand fonts first, installed or not', async () => {
    desktop(snapshot())
    useBrandStore.getState().set({ fonts: [{ family: 'Brand Serif', note: '品牌标题字体' }] })
    render(<FontPicker value="" onChange={() => undefined} />)
    await act(async () => undefined)
    fireEvent.click(screen.getByRole('button', { name: /字体|Brand|选择/ }))
    expect(screen.getByText('品牌字体')).toBeInTheDocument()
    expect(screen.getByText('品牌标题字体 · 这台电脑上没有装')).toBeInTheDocument()
  })

  it('reminds about pending preferences and opens 品牌与记忆', () => {
    const opened = vi.fn()
    window.addEventListener('ai-canvas:open-provider-settings', opened)
    const { rerender } = render(<PendingPreferencesNotice />)
    expect(screen.queryByTestId('pending-preferences')).toBeNull()
    act(() => { useBrandStore.getState().set({ pendingPreferences: 2 }) })
    rerender(<PendingPreferencesNotice />)
    fireEvent.click(screen.getByText('有 2 条偏好等你确认'))
    expect((opened.mock.calls[0]![0] as CustomEvent).detail).toEqual({ section: 'brand' })
    window.removeEventListener('ai-canvas:open-provider-settings', opened)
  })
})
