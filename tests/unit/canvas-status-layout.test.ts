import { expect, it } from 'vitest'
import { createDefaultIslandLayout, islandFitInsets } from '../../src/renderer/src/islands/island-layout'

it.each([{ width: 1024, height: 640 }, { width: 1440, height: 840 }])('reserves right view controls without changing fit at $width', (bounds) => {
  const inspector = createDefaultIslandLayout('inspector', bounds)
  const composer = createDefaultIslandLayout('composer', bounds)
  const tools = createDefaultIslandLayout('tools', bounds)
  const status = { x: bounds.width - 278, y: bounds.height - 114, width: 260, height: 96 }
  expect(inspector.y + inspector.height).toBeLessThanOrEqual(status.y - 12)
  expect(composer.x + composer.width).toBeLessThanOrEqual(status.x - 12)
  const previousInspector = { ...inspector, height: Math.min(bounds.width <= 1160 ? 520 : 650, bounds.height - 72) }
  expect(islandFitInsets({ inspector, composer, tools }, bounds)).toEqual(islandFitInsets({ inspector: previousInspector, composer, tools }, bounds))
})
