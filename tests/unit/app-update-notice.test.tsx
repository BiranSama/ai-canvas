import { act, fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { AppUpdateNotice } from '../../src/renderer/src/components/AppUpdateNotice'
import { AppUpdateSettings } from '../../src/renderer/src/components/AppUpdateSettings'
import type { AppUpdateSnapshot } from '../../src/shared/app-update'

function desktop(initial: AppUpdateSnapshot) {
  let push: (snapshot: AppUpdateSnapshot) => void = () => undefined
  const api = {
    getAppUpdate: vi.fn(async () => initial),
    checkForAppUpdate: vi.fn(async () => initial),
    installAppUpdate: vi.fn(async () => true),
    onAppUpdate: vi.fn((listener: (snapshot: AppUpdateSnapshot) => void) => { push = listener; return () => undefined })
  }
  Object.defineProperty(window, 'desktop', { configurable: true, value: api })
  return { api, push: (snapshot: AppUpdateSnapshot) => act(() => push(snapshot)) }
}

it('offers a downloaded version with 重启更新 and 稍后', async () => {
  const { api, push } = desktop({ currentVersion: '0.3.0', status: { kind: 'downloading', version: '0.4.0', percent: 10 } })
  render(<AppUpdateNotice />)
  await act(async () => undefined)
  expect(screen.queryByRole('status', { name: '新版本' })).not.toBeInTheDocument()

  push({ currentVersion: '0.3.0', status: { kind: 'ready', version: '0.4.0' } })
  expect(screen.getByRole('status', { name: '新版本' })).toHaveTextContent('新版本 0.4.0 已准备好')
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '重启更新' })) })
  expect(api.installAppUpdate).toHaveBeenCalledOnce()
})

it('puts a version off for this run with 稍后', async () => {
  desktop({ currentVersion: '0.3.0', status: { kind: 'ready', version: '0.4.1' } })
  const first = render(<AppUpdateNotice />)
  await act(async () => undefined)
  fireEvent.click(screen.getByRole('button', { name: '稍后' }))
  expect(screen.queryByRole('status', { name: '新版本' })).not.toBeInTheDocument()
  first.unmount()
  render(<AppUpdateNotice />)
  await act(async () => undefined)
  expect(screen.queryByRole('status', { name: '新版本' })).not.toBeInTheDocument()
})

it('says so when the restart did not happen', async () => {
  const { api } = desktop({ currentVersion: '0.3.0', status: { kind: 'ready', version: '0.4.2' } })
  api.installAppUpdate.mockResolvedValue(false)
  render(<AppUpdateNotice />)
  await act(async () => undefined)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '重启更新' })) })
  expect(screen.getByRole('alert')).toHaveTextContent('没有找到下载好的新版本。')
  expect(screen.getByRole('button', { name: '重启更新' })).toBeEnabled()
})

it('shows the version and checks for updates from 高级', async () => {
  const { api } = desktop({ currentVersion: '0.3.0', status: { kind: 'idle', checkedAt: null } })
  render(<AppUpdateSettings />)
  await act(async () => undefined)
  expect(screen.getByText('版本 0.3.0')).toBeInTheDocument()
  expect(screen.getByRole('status')).toHaveTextContent('启动后会自动检查更新。')
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '检查更新' })) })
  expect(api.checkForAppUpdate).toHaveBeenCalledOnce()
})

it('has no 检查更新 where the build does not update itself', async () => {
  desktop({ currentVersion: '0.3.0', status: { kind: 'unsupported', reason: 'portable' } })
  render(<AppUpdateSettings />)
  await act(async () => undefined)
  expect(screen.getByRole('status')).toHaveTextContent('便携版不会自动更新')
  expect(screen.queryByRole('button', { name: '检查更新' })).not.toBeInTheDocument()
})
