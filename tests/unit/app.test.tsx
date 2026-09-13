import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CommandBus, ELEMENT_SCHEMA_VERSION } from '../../src/domain'
import { App } from '../../src/renderer/src/App'
import { createNightVeilScene, NIGHT_VEIL_IDS } from '../../src/renderer/src/fixtures/night-veil'
import { resetWorkspace, setWorkspaceSceneClientForTests, useWorkspaceStore } from '../../src/renderer/src/store/workspace-store'
import { createLocalWorkspaceSceneClient } from '../helpers/local-workspace-scene-client'

vi.mock('../../src/renderer/src/canvas/CanvasStage', async () => {
  const React = await import('react')
  return {
    CanvasStage: React.forwardRef(function MockCanvasStage() {
      return <div data-testid="canvas-stage" />
    })
  }
})

describe('canvas workspace shell', () => {
  beforeEach(() => {
    resetWorkspace()
    setWorkspaceSceneClientForTests(createLocalWorkspaceSceneClient(useWorkspaceStore.getState().scene))
    Object.defineProperty(window, 'desktop', {
      configurable: true,
      value: {
        getRuntimeInfo: vi.fn().mockResolvedValue({
          appVersion: '0.1.0',
          electronVersion: '43.3.0',
          platform: 'win32',
          systemTheme: 'light',
          backgroundMaterial: 'mica',
          startupRoute: 'workspace',
          projectLibraryPath: 'C:\\Users\\Example\\Documents\\AI Canvas',
          nativeModules: {
            betterSqlite3: true,
            sharp: true,
            sqliteVersion: '3.51.2',
            sharpVersion: '0.35.3'
          }
        })
      }
    })
  })

  afterEach(() => setWorkspaceSceneClientForTests(null))

  it('shows the structured canvas and local-only creation controls', async () => {
    render(<App />)

    expect(await screen.findByRole('img', { name: 'AI Canvas' })).toHaveAttribute('src', expect.stringContaining('icon.png'))
    expect(screen.getByRole('navigation', { name: '工作视图' })).toBeVisible()
    expect(screen.getByRole('button', { name: '画布' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByTestId('canvas-stage')).toBeVisible()
    expect(screen.getByRole('listbox', { name: '图层' })).toBeVisible()
    expect(screen.getByRole('textbox', { name: '创作输入' })).toBeVisible()
    expect(await screen.findByTitle(/SQLite 3.51.2.*Sharp 0.35.3/)).toBeVisible()
    expect(screen.queryByText(/API Key/i)).not.toBeInTheDocument()
  })

  it('shows a safe recovery surface when startup IPC fails and can retry without reloading', async () => {
    const runtime = {
      appVersion: '0.1.0',
      electronVersion: '43.3.0',
      platform: 'win32' as const,
      systemTheme: 'light' as const,
      backgroundMaterial: 'mica' as const,
      startupRoute: 'workspace' as const,
      projectLibraryPath: 'C:\\Users\\Example\\Documents\\AI Canvas',
      nativeModules: {
        betterSqlite3: true,
        sharp: true,
        sqliteVersion: '3.51.2',
        sharpVersion: '0.35.3'
      }
    }
    const getRuntimeInfo = vi.fn()
      .mockRejectedValueOnce(new Error('synthetic startup failure'))
      .mockResolvedValue(runtime)
    Object.defineProperty(window, 'desktop', {
      configurable: true,
      value: { getRuntimeInfo }
    })

    render(<App />)

    const recovery = await screen.findByRole('alert')
    expect(recovery).toHaveTextContent('工作区暂时没有准备好')
    expect(recovery).toHaveTextContent('不会自动生成图片、重试模型请求或增加费用')

    fireEvent.click(screen.getByRole('button', { name: '重新检查工作区' }))

    expect(await screen.findByRole('navigation', { name: '工作视图' })).toBeVisible()
    expect(getRuntimeInfo.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('adds an element through CommandBus and undoes the whole action', async () => {
    render(<App />)
    const layerList = await screen.findByRole('listbox', { name: '图层' })
    expect(within(layerList).queryAllByRole('option')).toHaveLength(0)

    fireEvent.click(screen.getByRole('button', { name: '形状' }))
    await waitFor(() => expect(within(layerList).getAllByRole('option')).toHaveLength(1))
    await waitFor(() => expect(screen.getByRole('button', { name: '撤销' })).toBeEnabled())

    fireEvent.click(screen.getByRole('button', { name: '撤销' }))
    await waitFor(() => expect(within(layerList).queryAllByRole('option')).toHaveLength(0))
  })

  it('applies a canvas ratio and matching output pixels as one command', async () => {
    render(<App />)
    await screen.findByRole('listbox', { name: '图层' })
    fireEvent.click(screen.getByRole('tab', { name: /属性/ }))
    fireEvent.click(screen.getByRole('button', { name: '1:1' }))
    fireEvent.click(screen.getByRole('button', { name: '应用画布尺寸' }))

    await waitFor(() => {
      expect(useWorkspaceStore.getState().scene.canvas).toMatchObject({
        aspectWidth: 1,
        aspectHeight: 1,
        outputWidth: 1280,
        outputHeight: 1280
      })
    })
  })

  it('enters and exits a shallow semantic Group with a quiet hierarchy path', async () => {
    const source = createNightVeilScene()
    const groupId = '22000000-0000-4000-8000-000000000001'
    const childIds = [NIGHT_VEIL_IDS.bottle, NIGHT_VEIL_IDS.title]
    const result = new CommandBus(source).execute({
      id: '22000000-0000-4000-8000-000000000002',
      origin: 'agent',
      summary: '建立主体组件',
      commands: [{
        kind: 'element.group',
        elementIds: childIds,
        group: {
          id: groupId,
          version: ELEMENT_SCHEMA_VERSION,
          type: 'group',
          name: '香水主体组',
          description: '可整体控制并进入组内编辑',
          transform: { x: 0, y: 0, width: 1, height: 1, rotation: 0 },
          zIndex: 0,
          opacity: 1,
          visible: true,
          locked: false,
          groupId: null,
          semanticRole: 'subject-assembly',
          referencePolicy: 'include',
          childIds
        }
      }]
    })
    if (!result.ok) throw result.error
    setWorkspaceSceneClientForTests(createLocalWorkspaceSceneClient(result.scene))
    resetWorkspace(result.scene)
    useWorkspaceStore.getState().setSelection([groupId])
    render(<App />)
    await screen.findByTestId('canvas-stage')

    fireEvent.keyDown(window, { key: 'Enter' })
    expect(screen.getByRole('status', { name: '组内编辑' })).toHaveTextContent('正在编辑：香水主体组')
    expect(useWorkspaceStore.getState().editingGroupId).toBe(groupId)

    fireEvent.click(screen.getByRole('button', { name: '退出组内编辑' }))
    expect(screen.queryByRole('status', { name: '组内编辑' })).not.toBeInTheDocument()
    expect(useWorkspaceStore.getState().editingGroupId).toBeNull()
    expect(useWorkspaceStore.getState().selectedIds).toEqual([groupId])
  })
})
