import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../../src/renderer/src/App'
import { createHundredElementScene } from '../../src/renderer/src/fixtures/hundred-elements'
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

describe('100 element workspace fixture', () => {
  beforeEach(() => {
    const scene = createHundredElementScene()
    setWorkspaceSceneClientForTests(createLocalWorkspaceSceneClient(scene))
    resetWorkspace(scene)
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

  afterEach(() => {
    setWorkspaceSceneClientForTests(null)
    resetWorkspace()
  })

  it('renders and edits a 100 element layer projection within the local projection smoke budget', async () => {
    const startedAt = performance.now()
    render(<App />)
    const layerList = await screen.findByRole('listbox', { name: '图层' })
    expect(within(layerList).getAllByRole('option')).toHaveLength(100)
    const renderedAt = performance.now()

    fireEvent.click(within(layerList).getByText('基准元素 100'))
    await useWorkspaceStore.getState().updateElement(useWorkspaceStore.getState().scene.elements[99]!.id, { name: '已调整元素' })
    const editedAt = performance.now()

    expect(useWorkspaceStore.getState().scene.elements[99]?.name).toBe('已调整元素')
    expect(renderedAt - startedAt).toBeLessThan(1_500)
    // JSDOM renders the whole application and is only a coarse regression guard;
    // the Electron E2E performance scenario owns the 500 ms interaction SLO.
    expect(editedAt - renderedAt).toBeLessThan(1_500)
  })
})
