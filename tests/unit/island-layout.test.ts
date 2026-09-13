import { describe, expect, it } from 'vitest'
import {
  applyIslandMode,
  avoidIslandOrbOverlap,
  clampIslandLayout,
  collapseIsland,
  createDefaultIslandLayout,
  detachIslandLayout,
  detectDockingMode,
  detectPointerDockingMode,
  islandBreakpoint,
  islandFitInsets,
  normalizeStoredIslandLayout,
  resizeIslandLayout,
  restoreIsland
} from '../../src/renderer/src/islands/island-layout'

const bounds = { width: 1200, height: 760 }

describe('Glass Island layout state machine', () => {
  it.each([{ width: 1440, height: 840 }, { width: 683, height: 367 }])('keeps a composer orb outside a newly docked inspector at $width', (viewport) => {
    const expanded = restoreIsland(createDefaultIslandLayout('composer', viewport), 'composer', viewport)
    const orb = collapseIsland(expanded, 'composer', viewport)
    for (const mode of ['docked-top', 'docked-bottom', 'docked-left', 'docked-right'] as const) {
      const inspector = applyIslandMode(createDefaultIslandLayout('inspector', viewport), 'inspector', mode, viewport)
      const overlapping = { ...orb, x: inspector.x + 20, y: inspector.y + 20 }
      const placed = avoidIslandOrbOverlap(overlapping, 'composer', viewport, { inspector })
      expect(placed.x + placed.width <= inspector.x || placed.x >= inspector.x + inspector.width || placed.y + placed.height <= inspector.y || placed.y >= inspector.y + inspector.height).toBe(true)
      expect(restoreIsland(placed, 'composer', viewport)).toEqual(restoreIsland(orb, 'composer', viewport))
    }
  })
  it('docks at the pointer edge even when a tall island also reaches the bottom', () => {
    expect(detectPointerDockingMode({ x: 1196, y: 380 }, bounds)).toBe('docked-right')
    expect(detectPointerDockingMode({ x: 4, y: 380 }, bounds)).toBe('docked-left')
    expect(detectPointerDockingMode({ x: 600, y: 4 }, bounds)).toBe('docked-top')
    expect(detectPointerDockingMode({ x: 600, y: 756 }, bounds)).toBe('docked-bottom')
    expect(detectPointerDockingMode({ x: 600, y: 380 }, bounds)).toBeNull()
  })
  it('separates two collapsed tools on the same edge while retaining their expanded geometry', () => {
    const small = { width: 683, height: 367 }
    const tools = collapseIsland(applyIslandMode(createDefaultIslandLayout('tools', small), 'tools', 'docked-right', small), 'tools', small)
    const inspector = createDefaultIslandLayout('inspector', small)
    const placed = avoidIslandOrbOverlap(tools, 'tools', small, { inspector })
    expect(placed.previous).toEqual(tools.previous)
    expect(placed.x + placed.width <= inspector.x || inspector.x + inspector.width <= placed.x
      || placed.y + placed.height <= inspector.y || inspector.y + inspector.height <= placed.y).toBe(true)
    expect(restoreIsland(placed, 'tools', small)).toEqual(restoreIsland(tools, 'tools', small))
  })
  it('docks the inspector at the top and changes it to a horizontal surface', () => {
    const initial = createDefaultIslandLayout('inspector', bounds)
    const docked = applyIslandMode(initial, 'inspector', 'docked-top', bounds)
    expect(docked).toMatchObject({ mode: 'docked-top', y: 18 })
    expect(docked.width).toBeGreaterThan(docked.height)
  })

  it('collapses to an orb and restores the exact expanded geometry', () => {
    const initial = createDefaultIslandLayout('composer', bounds)
    const collapsed = collapseIsland(initial, 'composer', bounds)
    expect(collapsed).toMatchObject({ mode: 'orb', width: 58, height: 58 })
    expect(restoreIsland(collapsed, 'composer', bounds)).toMatchObject(initial)
  })

  it('keeps every persisted orb at 58px instead of reapplying expanded island minimums', () => {
    for (const id of ['tools', 'inspector', 'composer'] as const) {
      const expanded = createDefaultIslandLayout(id, bounds)
      const persisted = collapseIsland(expanded, id, bounds)
      expect(normalizeStoredIslandLayout(persisted, id, bounds)).toMatchObject({
        mode: 'orb',
        width: 58,
        height: 58
      })
    }
  })

  it.each([1024, 1280, 1440, 1920, 2560])('keeps the default composer clear of the default inspector at %ipx', (width) => {
    const viewport = { width, height: 900 }
    const composer = createDefaultIslandLayout('composer', viewport)
    const inspector = createDefaultIslandLayout('inspector', viewport)
    expect(composer.x + composer.width).toBeLessThanOrEqual(inspector.x - 18)
  })

  it('rejects malformed persisted island state and falls back to a usable default', () => {
    expect(normalizeStoredIslandLayout({ mode: 'broken', width: 'huge' }, 'inspector', bounds))
      .toEqual(createDefaultIslandLayout('inspector', bounds))
  })

  it('keeps malformed and off-screen preferences inside the workspace safe area', () => {
    const initial = createDefaultIslandLayout('inspector', bounds)
    const clamped = clampIslandLayout({ ...initial, x: -500, y: 4000, width: 9000, height: Number.NaN }, 'inspector', bounds)
    expect(clamped.x).toBeGreaterThanOrEqual(18)
    expect(clamped.x + clamped.width).toBeLessThanOrEqual(bounds.width - 18)
    expect(clamped.y + clamped.height).toBeLessThanOrEqual(bounds.height - 18)
  })

  it('detects safe-area docking and exposes internal responsive breakpoints', () => {
    expect(detectDockingMode({ x: 400, y: 10, width: 300, height: 400 }, bounds)).toBe('docked-top')
    expect(detectDockingMode({ x: 12, y: 100, width: 300, height: 400 }, bounds)).toBe('docked-left')
    expect(detectDockingMode({ x: 400, y: 690, width: 300, height: 58 }, bounds)).toBe('docked-bottom')
    expect(islandBreakpoint(250)).toBe('compact')
    expect(islandBreakpoint(360)).toBe('standard')
    expect(islandBreakpoint(620)).toBe('wide')
  })

  it('detaches a horizontal dock into the island default floating geometry', () => {
    const initial = createDefaultIslandLayout('tools', bounds)
    const docked = applyIslandMode(initial, 'tools', 'docked-top', bounds)
    const detached = detachIslandLayout(docked, 'tools', bounds)
    expect(detached).toMatchObject({ mode: 'floating', width: initial.width, height: initial.height })
  })

  it('resizes floating and edge-docked islands while preserving their anchor', () => {
    const floating = createDefaultIslandLayout('composer', bounds)
    const enlarged = resizeIslandLayout(floating, 'composer', bounds, 80, 30)
    expect(enlarged.width).toBe(floating.width + 80)
    expect(enlarged.height).toBe(floating.height + 30)

    const right = applyIslandMode(createDefaultIslandLayout('inspector', bounds), 'inspector', 'docked-right', bounds)
    const widerRight = resizeIslandLayout(right, 'inspector', bounds, -60, 30)
    expect(widerRight.width).toBe(right.width + 60)
    expect(widerRight.x + widerRight.width).toBe(bounds.width - 18)

    const bottom = applyIslandMode(floating, 'composer', 'docked-bottom', bounds)
    const tallerBottom = resizeIslandLayout(bottom, 'composer', bounds, 20, -30)
    expect(tallerBottom.height).toBe(bottom.height + 30)
    expect(tallerBottom.y + tallerBottom.height).toBe(bounds.height - 18)
  })

  it('keeps floating tools movable while reserving an edge-safe artboard area for the default composer', () => {
    const floating = createDefaultIslandLayout('inspector', bounds)
    expect(islandFitInsets({ inspector: { ...floating, mode: 'floating' } }, bounds))
      .toEqual({ top: 30, right: 42, bottom: 116, left: 42 })

    const floatingComposer = createDefaultIslandLayout('composer', bounds)
    expect(islandFitInsets({ composer: floatingComposer }, bounds).bottom)
      .toBe(bounds.height - floatingComposer.y + 26)

    const dockedRight = applyIslandMode(createDefaultIslandLayout('inspector', bounds), 'inspector', 'docked-right', bounds)
    const withRight = islandFitInsets({ inspector: dockedRight }, bounds)
    expect(withRight.right).toBe(dockedRight.width + 14)
    expect(withRight.left).toBe(42)

    const dockedTop = applyIslandMode(createDefaultIslandLayout('inspector', bounds), 'inspector', 'docked-top', bounds)
    expect(islandFitInsets({ inspector: dockedTop }, bounds).top).toBe(dockedTop.height + 16)

    const composerBottom = applyIslandMode(createDefaultIslandLayout('composer', bounds), 'composer', 'docked-bottom', bounds)
    expect(islandFitInsets({ composer: composerBottom }, bounds).bottom).toBe(composerBottom.height + 14)

    const orb = collapseIsland(createDefaultIslandLayout('tools', bounds), 'tools', bounds)
    expect(islandFitInsets({ tools: orb }, bounds)).toEqual({ top: 30, right: 42, bottom: 116, left: 42 })
  })
})
