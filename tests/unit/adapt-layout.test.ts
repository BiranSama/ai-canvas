import { produce } from 'immer'
import { describe, expect, it } from 'vitest'
import { applySceneCommand } from '../../src/domain/commands/apply-command'
import { adaptedScene, adaptLayout, adaptLayoutCommands, ELEMENT_SCHEMA_VERSION, hiddenByGroups, sceneSchema, storedAspect, type Scene, type SceneElement } from '../../src/domain'
import { createMerchantExampleScene, MERCHANT_EXAMPLE_KEYS } from '../../src/renderer/src/fixtures/merchant-examples'
import { SIZE_PRESETS } from '../../src/shared/export-presets'

function byName(scene: Scene, name: string): SceneElement {
  const found = scene.elements.find((element) => element.name === name)
  if (found === undefined) throw new Error(`No layer named ${name}`)
  return found
}

function pixels(scene: Scene, element: SceneElement): { x: number; y: number; width: number; height: number } {
  return {
    x: element.transform.x * scene.canvas.outputWidth,
    y: element.transform.y * scene.canvas.outputHeight,
    width: element.transform.width * scene.canvas.outputWidth,
    height: element.transform.height * scene.canvas.outputHeight
  }
}

function overlaps(a: ReturnType<typeof pixels>, b: ReturnType<typeof pixels>): boolean {
  return a.x < b.x + b.width - 0.5 && b.x < a.x + a.width - 0.5 && a.y < b.y + b.height - 0.5 && b.y < a.y + a.height - 0.5
}

describe('laying an artwork out at another size', () => {
  const coffee = createMerchantExampleScene('coffee-poster')

  it('keeps the ratio the canvas can store, the closest one when it is too fine', () => {
    expect(storedAspect(1080, 1440)).toEqual({ aspectWidth: 3, aspectHeight: 4 })
    expect(storedAspect(1920, 1080)).toEqual({ aspectWidth: 16, aspectHeight: 9 })
    // 900 × 383 has no ratio with terms up to 100; 47:20 is the nearest.
    expect(storedAspect(900, 383)).toEqual({ aspectWidth: 47, aspectHeight: 20 })
    // Past 100:1 the nearest storable ratio is at the edge, never a square.
    expect(storedAspect(16_384, 64)).toEqual({ aspectWidth: 100, aspectHeight: 1 })
    expect(storedAspect(64, 16_384)).toEqual({ aspectWidth: 1, aspectHeight: 100 })
  })

  it('only scales an artwork of the same proportions: places stay, text sizes follow', () => {
    const doubled = adaptedScene(coffee, { width: 2048, height: 2560 })
    expect(doubled.canvas).toMatchObject({ outputWidth: 2048, outputHeight: 2560, aspectWidth: 4, aspectHeight: 5 })
    for (const element of coffee.elements) expect(byName(doubled, element.name).transform).toEqual(element.transform)
    const title = byName(coffee, '标题')
    expect(title.type === 'text' && byName(doubled, '标题').type === 'text').toBe(true)
    if (title.type === 'text') expect((byName(doubled, '标题') as typeof title).fontSize).toBeCloseTo(title.fontSize * 2)
  })

  it('fills the new canvas with the background and keeps everything inside it, undistorted', () => {
    for (const preset of SIZE_PRESETS) {
      const adapted = sceneSchema.parse(adaptedScene(coffee, preset))
      expect(adapted.canvas.outputWidth).toBe(preset.width)
      expect(adapted.canvas.outputHeight).toBe(preset.height)
      expect(byName(adapted, '奶油色背景').transform).toEqual({ x: 0, y: 0, width: 1, height: 1, rotation: 0 })
      for (const element of adapted.elements) {
        const box = pixels(adapted, element)
        expect(box.x).toBeGreaterThanOrEqual(-0.5)
        expect(box.y).toBeGreaterThanOrEqual(-0.5)
        expect(box.x + box.width).toBeLessThanOrEqual(preset.width + 0.5)
        expect(box.y + box.height).toBeLessThanOrEqual(preset.height + 0.5)
      }
      // The badge keeps its shape: scaled evenly, never stretched.
      const before = pixels(coffee, byName(coffee, '价格圆标'))
      const after = pixels(adapted, byName(adapted, '价格圆标'))
      expect(after.width / after.height).toBeCloseTo(before.width / before.height, 3)
    }
  })

  it('makes a fitted or stretched background photo fill the new shape by cropping', () => {
    const photo = { ...byName(coffee, '奶油色背景') }
    const scene = sceneSchema.parse({ ...coffee, elements: coffee.elements.map((element) => element.id === photo.id ? {
      id: element.id, version: element.version, type: 'image', name: '背景照片', description: '', transform: element.transform, zIndex: element.zIndex, opacity: 1,
      visible: true, locked: false, groupId: null, semanticRole: 'background', referencePolicy: 'include', assetId: '0f0f0f0f-0000-4000-8000-0000000000bb',
      crop: { x: 0, y: 0, width: 1, height: 1 }, fit: 'contain', referenceRole: 'general'
    } : element) })
    const wide = byName(adaptedScene(scene, { width: 1920, height: 1080 }), '背景照片')
    expect(wide.type === 'image' && wide.fit).toBe('cover')
    expect(wide.transform).toEqual({ x: 0, y: 0, width: 1, height: 1, rotation: 0 })
  })

  it('keeps the top together, the bottom at the bottom and the full-width bar full width', () => {
    const tall = adaptedScene(coffee, { width: 1080, height: 1920 })
    const scale = Math.min(1080 / 1024, 1920 / 1280)
    const titleBefore = pixels(coffee, byName(coffee, '标题'))
    const subtitleBefore = pixels(coffee, byName(coffee, '副标题'))
    const titleAfter = pixels(tall, byName(tall, '标题'))
    const subtitleAfter = pixels(tall, byName(tall, '副标题'))
    // Both sit in the top third: the gap between them only scales.
    expect(subtitleAfter.y - (titleAfter.y + titleAfter.height)).toBeCloseTo((subtitleBefore.y - (titleBefore.y + titleBefore.height)) * scale, 3)
    const bar = pixels(tall, byName(tall, '底部色块'))
    expect(bar.x).toBeCloseTo(0, 3)
    expect(bar.width).toBeCloseTo(1080, 3)
    expect(bar.y + bar.height).toBeCloseTo(1920, 3)
  })

  it('never makes layers overlap that did not', () => {
    for (const key of MERCHANT_EXAMPLE_KEYS) {
      const scene = createMerchantExampleScene(key)
      const content = scene.elements.filter((element) => !['background', 'backdrop'].includes(element.semanticRole) && element.transform.width < 0.97)
      for (const preset of SIZE_PRESETS) {
        const adapted = adaptedScene(scene, preset)
        for (const [index, a] of content.entries()) {
          for (const b of content.slice(index + 1)) {
            if (overlaps(pixels(scene, a), pixels(scene, b))) continue
            expect(overlaps(pixels(adapted, byName(adapted, a.name)), pixels(adapted, byName(adapted, b.name))), `${key} ${preset.id}: ${a.name} / ${b.name}`).toBe(false)
          }
        }
      }
    }
  })

  it('moves a group as one, its own box included', () => {
    const title = byName(coffee, '标题')
    const subtitle = byName(coffee, '副标题')
    const group: SceneElement = {
      id: '0f0f0f0f-0000-4000-8000-000000000001', version: ELEMENT_SCHEMA_VERSION, type: 'group', name: '标题组', description: '',
      transform: { x: Math.min(title.transform.x, subtitle.transform.x), y: title.transform.y, width: Math.max(title.transform.width, subtitle.transform.width), height: subtitle.transform.y + subtitle.transform.height - title.transform.y, rotation: 0 },
      zIndex: coffee.elements.length, opacity: 1, visible: true, locked: false, groupId: null, semanticRole: 'composition', referencePolicy: 'include', childIds: [title.id, subtitle.id]
    }
    const grouped = sceneSchema.parse({ ...coffee, elements: [...coffee.elements.map((element) => element.id === title.id || element.id === subtitle.id ? { ...element, groupId: group.id } : element), group] })
    const wide = adaptedScene(grouped, { width: 1920, height: 1080 })
    const offset = (scene: Scene, element: SceneElement): number => pixels(scene, element).x - pixels(scene, byName(scene, '标题组')).x
    const scale = Math.min(1920 / 1024, 1080 / 1280)
    expect(offset(wide, byName(wide, '副标题'))).toBeCloseTo(offset(grouped, subtitle) * scale, 3)
    expect(pixels(wide, byName(wide, '标题组')).width).toBeCloseTo(pixels(grouped, group).width * scale, 3)
  })

  it('moves a locked layer by unlocking and locking it again within the same step', () => {
    const background = byName(coffee, '奶油色背景')
    const locked = sceneSchema.parse({ ...coffee, elements: coffee.elements.map((element) => element.id === background.id ? { ...element, locked: true } : element) })
    const commands = adaptLayoutCommands(locked, { width: 1920, height: 1080 })
    const forBackground = commands.filter((command) => command.kind === 'element.update' && command.elementId === background.id).map((command) => command.kind === 'element.update' ? Object.keys(command.changes) : [])
    expect(forBackground[0]).toEqual(['locked'])
    expect(forBackground.at(-1)).toEqual(['locked'])
    const after = produce(locked, (draft) => { for (const command of commands) applySceneCommand(draft, command) })
    expect(byName(after, '奶油色背景').locked).toBe(true)
    expect(after.canvas).toMatchObject({ outputWidth: 1920, outputHeight: 1080 })
  })

  it('makes one command list that sets the canvas and moves the layers', () => {
    const commands = adaptLayoutCommands(coffee, { width: 1080, height: 1440 })
    expect(commands[0]).toMatchObject({ kind: 'scene.set-canvas', canvas: { outputWidth: 1080, outputHeight: 1440 } })
    expect(commands.slice(1).every((command) => command.kind === 'element.update')).toBe(true)
    expect(adaptLayout(coffee, { width: 1080, height: 1440 }).changes.size).toBe(commands.length - 1)
  })
})

describe('hidden groups', () => {
  it('hide everything in them, nested groups included', () => {
    const base = { version: ELEMENT_SCHEMA_VERSION, description: '', transform: { x: 0, y: 0, width: 0.5, height: 0.5, rotation: 0 }, opacity: 1, locked: false, semanticRole: 'content', referencePolicy: 'include' as const }
    const ids = ['a', 'b', 'c', 'd'].map((letter) => `0f0f0f0f-0000-4000-8000-00000000000${'abcd'.indexOf(letter) + 1}`)
    const outer = { ...base, id: ids[0]!, type: 'group' as const, name: '外层', zIndex: 0, visible: false, groupId: null, childIds: [ids[1]!] }
    const inner = { ...base, id: ids[1]!, type: 'group' as const, name: '内层', zIndex: 1, visible: true, groupId: ids[0]!, childIds: [ids[2]!] }
    const shape = { ...base, id: ids[2]!, type: 'shape' as const, name: '色块', zIndex: 2, visible: true, groupId: ids[1]!, shape: 'rectangle' as const, fill: '#FF0000', stroke: null, strokeWidth: 0, cornerRadius: 0, role: 'final' as const }
    const loose = { ...shape, id: ids[3]!, name: '外面的', groupId: null }
    expect([...hiddenByGroups([outer, inner, shape, loose] as SceneElement[])].sort()).toEqual([ids[1], ids[2]].sort())
  })
})
