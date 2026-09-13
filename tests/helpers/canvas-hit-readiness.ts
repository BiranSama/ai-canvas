import { expect, type Page } from '@playwright/test'

interface ShapeHitState {
  x: number; y: number; shapeId: string; mainRevision: number; renderedRevision: number
  pixel: number[]; expectedPixel: number[]; painted: boolean; unobscured: boolean
}

export async function readShapeHitState(page: Page) {
  return page.evaluate(`(async () => {
    const scene = (await globalThis.desktop.getWorkspaceBootstrap()).scene
    const root = document.querySelector('[data-testid="canvas-stage"]')
    const surface = root?.querySelector('.konvajs-content')
    const shape = scene.elements.find((element) => element.type === 'shape')
    if (!root || !surface || shape?.type !== 'shape') return null
    const rect = surface.getBoundingClientRect()
    const x = rect.left + Number(root.dataset.artboardX) + (shape.transform.x + shape.transform.width / 2) * Number(root.dataset.artboardWidth)
    const y = rect.top + Number(root.dataset.artboardY) + (shape.transform.y + shape.transform.height / 2) * Number(root.dataset.artboardHeight)
    const layer = surface.querySelectorAll('canvas')[1]
    if (!layer) return null
    const bounds = layer.getBoundingClientRect()
    const pixel = Array.from(layer.getContext('2d').getImageData(Math.round((x - bounds.left) * layer.width / bounds.width), Math.round((y - bounds.top) * layer.height / bounds.height), 1, 1).data)
    const fill = shape.fill.replace('#', '')
    const expectedPixel = [parseInt(fill.slice(0, 2), 16), parseInt(fill.slice(2, 4), 16), parseInt(fill.slice(4, 6), 16), 255]
    return { x, y, shapeId: shape.id, mainRevision: scene.revision, renderedRevision: Number(root.dataset.sceneRevision), pixel, expectedPixel,
      painted: pixel.every((value, index) => value === expectedPixel[index]), unobscured: document.elementFromPoint(x, y)?.tagName === 'CANVAS' }
  })()`) as Promise<ShapeHitState | null>
}

export async function waitForPaintedShape(page: Page) {
  await expect.poll(async () => {
    const state = await readShapeHitState(page)
    return state !== null && state.mainRevision === state.renderedRevision && state.painted && state.unobscured
  }, { message: 'Main shape, rendered Scene, painted content and reachable pointer target must agree.' }).toBe(true)
  return (await readShapeHitState(page))!
}
