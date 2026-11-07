import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Scene, SceneCommand, SceneElement } from '../../src/domain'
import { createMerchantExampleScene } from '../../src/renderer/src/fixtures/merchant-examples'
import type * as AppNotice from '../../src/renderer/src/components/app-notice'
import type * as LayerRender from '../../src/renderer/src/canvas/layer-render'

const notices = vi.hoisted(() => [] as string[])
vi.mock('../../src/renderer/src/components/app-notice', async (importOriginal) => ({
  ...await importOriginal<typeof AppNotice>(),
  showAppNotice: (message: string) => { notices.push(message) }
}))

// What a merge draws, instead of drawing it.
const rendered = vi.hoisted(() => [] as string[][])
vi.mock('../../src/renderer/src/canvas/layer-render', async (importOriginal) => ({
  ...await importOriginal<typeof LayerRender>(),
  renderLayersAsDrawn: async (ids: readonly string[]) => {
    rendered.push([...ids])
    return { width: 4, height: 4, getContext: () => ({ getImageData: () => ({ data: new Uint8ClampedArray(64) }) }) }
  },
  opaqueBounds: () => ({ x: 0, y: 0, width: 4, height: 4 })
}))

const { mergeDown, mergeVisible, toggleClippingMask } = await import('../../src/renderer/src/canvas/layer-actions')
const { resetWorkspace, useWorkspaceStore } = await import('../../src/renderer/src/store/workspace-store')

beforeEach(() => { (globalThis as unknown as { window: unknown }).window = { desktop: { importPixels: async () => ({ id: '0f0f0f0f-0000-4000-8000-0000000000e1' }) } } })
afterEach(() => { notices.length = 0; rendered.length = 0; resetWorkspace() })

/** The coffee poster: 奶油色背景, 底部色块, 一杯拿铁 (an AI placeholder), 标题, 副标题, 价格圆标, 价格, 店名, bottom first. */
function poster(changes: Record<string, Partial<SceneElement>> = {}): { scene: Scene; id: (name: string) => string } {
  const base = createMerchantExampleScene('coffee-poster')
  const scene = { ...base, elements: base.elements.map((element) => ({ ...element, ...changes[element.name] }) as SceneElement) }
  return { scene, id: (name) => scene.elements.find((element) => element.name === name)!.id }
}

/** Records what each step would do to the scene, instead of sending it to Main. */
function recording(scene: Scene, selected: readonly string[]): SceneCommand[][] {
  const steps: SceneCommand[][] = []
  resetWorkspace(scene)
  useWorkspaceStore.getState().setSelection([...selected])
  useWorkspaceStore.setState({
    execute: (async (_summary: string, commands: SceneCommand[] | ((scene: Scene) => SceneCommand[] | null)) => {
      const list = typeof commands === 'function' ? commands(useWorkspaceStore.getState().scene) : commands
      if (list === null) return false
      steps.push(list)
      return true
    }) as never
  })
  return steps
}

it('clips a layer to the one below it, and several selected to the lowest of them', async () => {
  const { scene, id } = poster()
  const one = recording(scene, [id('副标题')])
  expect(await toggleClippingMask()).toBe(true)
  expect(one).toEqual([[{ kind: 'element.update', elementId: id('副标题'), changes: { clipped: true } }]])

  const several = recording(scene, [id('标题'), id('副标题'), id('价格圆标')])
  expect(await toggleClippingMask()).toBe(true)
  expect(several[0]!.map((command) => command.kind === 'element.update' ? command.elementId : null)).toEqual([id('副标题'), id('价格圆标')])
})

it('releases a clipped layer with the ones clipped above it, as Photoshop does', async () => {
  const { scene, id } = poster({ 副标题: { clipped: true }, 价格圆标: { clipped: true } })
  const steps = recording(scene, [id('副标题')])
  expect(await toggleClippingMask()).toBe(true)
  expect(steps[0]!.map((command) => command.kind === 'element.update' ? [command.elementId, command.changes] : null))
    .toEqual([[id('副标题'), { clipped: false }], [id('价格圆标'), { clipped: false }]])
})

it('says why a layer cannot be clipped, and changes nothing', async () => {
  // Right above an AI placeholder there is nothing to clip to.
  const { scene, id } = poster()
  const steps = recording(scene, [id('标题')])
  expect(await toggleClippingMask()).toBe(false)
  expect(steps).toEqual([])
  expect(notices.at(-1)).toContain('「标题」下面没有可以剪贴到的图层')
  const locked = poster({ 副标题: { locked: true } })
  recording(locked.scene, [locked.id('副标题')])
  expect(await toggleClippingMask()).toBe(false)
  expect(notices.at(-1)).toContain('已锁定')
  recording(scene, [id('一杯拿铁')])
  expect(await toggleClippingMask()).toBe(false)
})

it('merges the layers clipped to a base into it with Ctrl+E on the base', async () => {
  const { scene, id } = poster({ 副标题: { clipped: true }, 价格圆标: { clipped: true } })
  const steps = recording(scene, [id('标题')])
  expect(await mergeDown()).toBe(true)
  expect(rendered).toEqual([[id('标题'), id('副标题'), id('价格圆标')]])
  expect(steps[0]!.map((command) => command.kind)).toEqual(['element.rasterize', 'element.remove', 'element.remove'])
})

it('keeps a merge clipped only when what it drew was drawn without its base', async () => {
  const { scene, id } = poster({ 副标题: { clipped: true }, 价格圆标: { clipped: true } })
  // Two clipped layers without their base: the result, in the top one's place, stays clipped.
  const members = recording(scene, [id('副标题'), id('价格圆标')])
  expect(await mergeDown()).toBe(true)
  expect(members[0]!.find((command) => command.kind === 'element.update' && 'clipped' in command.changes)).toBeUndefined()
  // A base and a layer clipped to it: the clipping is in the result, which is no longer clipped.
  const withBase = recording(scene, [id('标题'), id('副标题')])
  expect(await mergeDown()).toBe(true)
  expect(withBase[0]).toContainEqual({ kind: 'element.update', elementId: id('副标题'), changes: { clipped: false } })
})

it('leaves out of merge visible a layer clipped to a hidden base, as it is hidden with it', async () => {
  const { scene, id } = poster({ 标题: { visible: false }, 副标题: { clipped: true } })
  recording(scene, [])
  expect(await mergeVisible()).toBe(true)
  expect(rendered[0]).not.toContain(id('副标题'))
  expect(rendered[0]).toContain(id('价格'))
})
