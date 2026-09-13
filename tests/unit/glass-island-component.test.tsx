import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
import { MousePointer2 } from 'lucide-react'
import { createRef } from 'react'
import { GlassIsland } from '../../src/renderer/src/islands/GlassIsland'
import { GLASS_ISLAND_STORAGE_KEY } from '../../src/renderer/src/islands/island-events'

const LEGACY_KEY = 'ai-canvas.r2.glass-islands.v1'

const captureSpy = vi.fn<(pointerId: number) => void>()
const releaseSpy = vi.fn<(pointerId: number) => void>()

beforeAll(() => {
  Element.prototype.setPointerCapture = captureSpy
  Element.prototype.releasePointerCapture = releaseSpy
  Element.prototype.hasPointerCapture = () => true
})

beforeEach(() => {
  localStorage.clear()
  captureSpy.mockClear()
  releaseSpy.mockClear()
})

function renderToolsIsland(): ReturnType<typeof render> {
  const containerRef = createRef<HTMLElement>()
  return render(
    <main ref={containerRef}>
      <GlassIsland id="tools" label="画布工具" icon={MousePointer2} containerRef={containerRef}>
        <div>工具</div>
      </GlassIsland>
    </main>
  )
}

function islandStyle(container: HTMLElement): CSSStyleDeclaration {
  const island = container.querySelector('.glass-island')
  expect(island).not.toBeNull()
  return (island as HTMLElement).style
}

describe('GlassIsland pointer session resilience', () => {
  it('releases an in-flight drag on window blur and restores the pre-drag layout', () => {
    const { container, getByRole } = renderToolsIsland()
    const grip = getByRole('toolbar')
    expect(islandStyle(container).getPropertyValue('--island-x')).toBe('18px')

    fireEvent.pointerDown(grip, { pointerId: 1, button: 0, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(grip, { pointerId: 1, clientX: 320, clientY: 260 })
    expect(islandStyle(container).getPropertyValue('--island-x')).toBe('238px')
    expect(container.querySelector('.glass-island')?.getAttribute('data-island-interacting')).toBe('true')

    fireEvent(window, new Event('blur'))
    expect(islandStyle(container).getPropertyValue('--island-x')).toBe('18px')
    expect(container.querySelector('.glass-island')?.getAttribute('data-island-interacting')).toBe('false')
    expect(localStorage.getItem(GLASS_ISLAND_STORAGE_KEY)).toBeNull()
  })

  it('cancels an in-flight resize with Escape and keeps the committed geometry', () => {
    const { container, getByRole } = renderToolsIsland()
    const handle = getByRole('separator')
    const before = islandStyle(container).getPropertyValue('--island-width')

    fireEvent.pointerDown(handle, { pointerId: 2, button: 0, clientX: 60, clientY: 60 })
    fireEvent.pointerMove(handle, { pointerId: 2, clientX: 140, clientY: 140 })
    expect(islandStyle(container).getPropertyValue('--island-width')).not.toBe(before)

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(islandStyle(container).getPropertyValue('--island-width')).toBe(before)
    expect(localStorage.getItem(GLASS_ISLAND_STORAGE_KEY)).toBeNull()
  })

  it('resizes from the keyboard and persists only the committed geometry', () => {
    const { container, getByRole } = renderToolsIsland()
    const handle = getByRole('separator')
    const before = Number.parseInt(islandStyle(container).getPropertyValue('--island-width'), 10)

    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    const widened = Number.parseInt(islandStyle(container).getPropertyValue('--island-width'), 10)
    expect(widened).toBe(before + 10)

    fireEvent.keyDown(handle, { key: 'ArrowLeft', shiftKey: true })
    expect(Number.parseInt(islandStyle(container).getPropertyValue('--island-width'), 10)).toBe(widened - 1)

    const stored = localStorage.getItem(GLASS_ISLAND_STORAGE_KEY)
    expect(stored).not.toBeNull()
    expect(JSON.parse(stored ?? '{}')).toMatchObject({ tools: { width: widened - 1 } })
  })

  it('adopts layouts stored under the legacy island storage key', () => {
    localStorage.setItem(LEGACY_KEY, JSON.stringify({ tools: { mode: 'floating', x: 222, y: 120, width: 96, height: 300, previous: null } }))
    const { container } = renderToolsIsland()
    expect(islandStyle(container).getPropertyValue('--island-x')).toBe('222px')
  })
})

describe('GlassIsland pointer capture release contract', () => {
  it('releases capture explicitly on a committed pointerup', () => {
    const { getByRole } = renderToolsIsland()
    const grip = getByRole('toolbar')

    fireEvent.pointerDown(grip, { pointerId: 1, button: 0, clientX: 100, clientY: 100 })
    expect(captureSpy).toHaveBeenCalledWith(1)
    fireEvent.pointerMove(grip, { pointerId: 1, clientX: 180, clientY: 160 })
    fireEvent.pointerUp(grip, { pointerId: 1, clientX: 180, clientY: 160 })
    expect(releaseSpy).toHaveBeenCalledWith(1)
  })

  it('releases capture on pointercancel and restores the pre-drag layout', () => {
    const { container, getByRole } = renderToolsIsland()
    const grip = getByRole('toolbar')

    fireEvent.pointerDown(grip, { pointerId: 3, button: 0, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(grip, { pointerId: 3, clientX: 300, clientY: 240 })
    expect(islandStyle(container).getPropertyValue('--island-x')).not.toBe('18px')

    fireEvent.pointerCancel(grip, { pointerId: 3 })
    expect(releaseSpy).toHaveBeenCalledWith(3)
    expect(islandStyle(container).getPropertyValue('--island-x')).toBe('18px')
    expect(container.querySelector('.glass-island')?.getAttribute('data-island-interacting')).toBe('false')
  })

  it('releases capture when Escape cancels an in-flight drag', () => {
    const { container, getByRole } = renderToolsIsland()
    const grip = getByRole('toolbar')

    fireEvent.pointerDown(grip, { pointerId: 4, button: 0, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(grip, { pointerId: 4, clientX: 260, clientY: 220 })
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(releaseSpy).toHaveBeenCalledWith(4)
    expect(islandStyle(container).getPropertyValue('--island-x')).toBe('18px')
  })

  it('releases capture when the window blurs mid-drag', () => {
    const { getByRole } = renderToolsIsland()
    const grip = getByRole('toolbar')

    fireEvent.pointerDown(grip, { pointerId: 5, button: 0, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(grip, { pointerId: 5, clientX: 240, clientY: 200 })
    fireEvent(window, new Event('blur'))
    expect(releaseSpy).toHaveBeenCalledWith(5)
  })

  it('releases capture when the island unmounts during an active session', () => {
    const { getByRole, unmount } = renderToolsIsland()
    const grip = getByRole('toolbar')

    fireEvent.pointerDown(grip, { pointerId: 6, button: 0, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(grip, { pointerId: 6, clientX: 220, clientY: 190 })
    unmount()
    expect(releaseSpy).toHaveBeenCalledWith(6)
  })

  it('a throwing releasePointerCapture never breaks cancellation', () => {
    const { container, getByRole } = renderToolsIsland()
    const grip = getByRole('toolbar')

    fireEvent.pointerDown(grip, { pointerId: 7, button: 0, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(grip, { pointerId: 7, clientX: 260, clientY: 220 })
    releaseSpy.mockImplementationOnce(() => { throw new Error('stale pointer') })
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(releaseSpy).toHaveBeenCalledWith(7)
    expect(islandStyle(container).getPropertyValue('--island-x')).toBe('18px')
    expect(container.querySelector('.glass-island')?.getAttribute('data-island-interacting')).toBe('false')
  })
})
