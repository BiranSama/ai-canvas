import { z } from 'zod'
import { cornersAreAffine, cornersAreDrawable, layerCanvasBounds, refitGroupsAround, transformableLayers, transformLayers, type Corners, type Point, type SceneCommand } from '../../../domain'
import { batchPlan, sceneWrite } from './scene-write'
import { defineTool, rejected, resolveTargets } from './types'

/*
 * Photoshop's 编辑 > 变换 for the Agent: flip, turn or skew layers as a
 * whole (about the middle of the box around them), set one layer's four
 * corners for a perspective or distort, or put them back. One step each.
 */

export const transformTool = defineTool({
  name: 'transform',
  title: '变换',
  description: 'PS 变换，每次一种：flip；rotate 度数；skew [水平,垂直] 度数；corners 一个图层四角 8 个数（左上、右上、右下、左下的 x,y，框的百分比）做透视或扭曲，文字只能平行四边形；reset 还原。多层绕整体中心。',
  parameters: z.object({
    targets: z.array(z.string()).min(1),
    flip: z.enum(['horizontal', 'vertical']).optional(),
    rotate: z.number().optional(),
    skew: z.array(z.number()).length(2).optional(),
    corners: z.array(z.number()).length(8).optional(),
    reset: z.boolean().optional()
  }).strict(),
  registryName: 'scene.update_elements',
  describe: (args) => `变换 ${args.targets.join('、')}：${args.flip === 'horizontal' ? '水平翻转' : args.flip === 'vertical' ? '垂直翻转' : args.rotate !== undefined ? `旋转 ${args.rotate}°` : args.skew !== undefined ? '斜切' : args.corners !== undefined ? '四角' : '还原'}`,
  prepare(args, context) {
    const given = [args.flip, args.rotate, args.skew, args.corners, args.reset === true ? true : undefined].filter((value) => value !== undefined)
    if (given.length !== 1) return rejected('flip、rotate、skew、corners、reset 每次只给一种。')
    if (args.rotate !== undefined && Math.abs(args.rotate) > 360) return rejected('rotate 在 -360~360 度之间。')
    if (args.skew !== undefined && args.skew.some((degrees) => Math.abs(degrees) > 80)) return rejected('skew 每个方向在 -80~80 度之间。')
    if (args.corners !== undefined && args.corners.some((value) => value < -500 || value > 600)) return rejected('corners 每个数在 -500~600 之间（框的百分比）。')
    const targets = resolveTargets(args.targets, context)
    if (typeof targets === 'string') return rejected(targets)
    const scene = context.scene
    const layers = transformableLayers(scene, targets.map((element) => element.id))
    if (layers.length === 0) return rejected('这些对象不能变换（调整图层、修改区）。')
    const refs = targets.map((element) => context.refs.ref(element.id)).join('、')

    if (args.corners !== undefined || args.reset === true) {
      const commands: SceneCommand[] = []
      if (args.corners !== undefined) {
        if (layers.length !== 1) return rejected('corners 一次只给一个图层。')
        const layer = layers[0]!
        if (layer.type !== 'image' && layer.type !== 'shape' && layer.type !== 'text') return rejected(`${context.refs.ref(layer.id)} 不能设四角。`, '四角用于图片、形状和文字。')
        const values = args.corners
        const corners = [0, 2, 4, 6].map((at) => [values[at]! / 100, values[at + 1]! / 100] as Point) as unknown as Corners
        if (!cornersAreDrawable(corners)) return rejected('四角要按左上、右上、右下、左下的顺序围成凸四边形。')
        if (layer.type === 'text' && !cornersAreAffine(corners)) return rejected('文字只能翻转和斜切（平行四边形）；透视、扭曲要先栅格化。')
        commands.push({ kind: 'element.update', elementId: layer.id, changes: { corners } })
      } else {
        for (const layer of layers) {
          if ((layer.type === 'image' || layer.type === 'shape' || layer.type === 'text') && layer.corners !== undefined && layer.corners !== null) {
            commands.push({ kind: 'element.update', elementId: layer.id, changes: { corners: null } })
          }
        }
        if (commands.length === 0) return rejected(`${refs} 没有做过翻转、斜切或透视。`)
      }
      // The groups around them fitted again to what the layers now cover.
      const changed = new Map(commands.flatMap((command) => command.kind === 'element.update' ? [[command.elementId, command.changes] as const] : []))
      commands.push(...refitGroupsAround(scene, [...changed.keys()], changed))
      const summary = args.reset === true ? `已还原 ${refs} 的四角` : `已给 ${refs} 设四角`
      return sceneWrite(batchPlan(summary, commands), context, summary, layers.map((layer) => layer.id))
    }

    // About the middle of the box around them, square to the canvas.
    const canvas = { width: scene.canvas.outputWidth, height: scene.canvas.outputHeight }
    const bounds = layers.map((layer) => layerCanvasBounds(layer.transform, 'corners' in layer ? layer.corners : null, canvas))
    const cx = (Math.min(...bounds.map((box) => box.x)) + Math.max(...bounds.map((box) => box.x + box.width))) / 2
    const cy = (Math.min(...bounds.map((box) => box.y)) + Math.max(...bounds.map((box) => box.y + box.height))) / 2
    let map: (point: Point) => Point
    let summary: string
    if (args.flip !== undefined) {
      map = args.flip === 'horizontal' ? ([x, y]) => [2 * cx - x, y] : ([x, y]) => [x, 2 * cy - y]
      summary = `已${args.flip === 'horizontal' ? '水平' : '垂直'}翻转 ${refs}`
    } else if (args.rotate !== undefined) {
      const angle = args.rotate * Math.PI / 180
      map = ([x, y]) => [cx + (x - cx) * Math.cos(angle) - (y - cy) * Math.sin(angle), cy + (x - cx) * Math.sin(angle) + (y - cy) * Math.cos(angle)]
      summary = `已把 ${refs} 旋转 ${args.rotate}°`
    } else {
      const [h = 0, v = 0] = args.skew!.map((degrees) => Math.tan(degrees * Math.PI / 180))
      map = ([x, y]) => [x + h * (y - cy), y + v * (x - cx)]
      summary = `已斜切 ${refs}`
    }
    const outcome = transformLayers(scene, layers, map)
    if (!outcome.ok) return rejected(outcome.reason)
    return sceneWrite(batchPlan(summary, outcome.commands), context, summary, layers.map((layer) => layer.id))
  }
})
