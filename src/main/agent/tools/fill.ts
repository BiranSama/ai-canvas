import { z } from 'zod'
import { MAX_PAINT_OPS, type PaintOp, type SceneElement } from '../../../domain'
import { colorSchema } from './geometry'
import { batchPlan, createPlan, elementBase, sceneWrite } from './scene-write'
import { defineTool, rejected } from './types'

const DIRECTIONS = {
  top_to_bottom: '从上到下',
  bottom_to_top: '从下到上',
  left_to_right: '从左到右',
  right_to_left: '从右到左',
  radial: '从中心向外'
} as const

/** #RGB, #RRGGBB or #RRGGBBAA as the #RRGGBB paint takes, with the alpha as a share of opacity. */
function paintColor(value: string): { readonly color: string; readonly alpha: number } {
  const hex = value.slice(1)
  const full = hex.length === 3 ? [...hex].map((digit) => digit + digit).join('') : hex
  return { color: `#${full.slice(0, 6).toUpperCase()}`, alpha: full.length === 8 ? parseInt(full.slice(6), 16) / 255 : 1 }
}

type ImageElement = Extract<SceneElement, { type: 'image' }>

export const fillTool = defineTool({
  name: 'fill',
  title: '填充',
  description: '在图片图层上铺颜色，像 Photoshop 的填充和渐变工具；不花钱、可撤销。只给 color 是整层纯色；再给 to_color 是渐变，direction 定方向（radial 从中心向外）。keep_transparency 为 true 时只给已有像素上色、透明处不变（锁定透明像素），适合给抠图主体或栅格化的文字换色。不给 target 时新建一个画布大小的图层来填，放在最上面，常用来做纯色或渐变背景（再用 reorder 放到底下）。文字和形状改颜色用 update；要在它们的像素上填色先用 merge_layers 栅格化。',
  parameters: z.object({
    target: z.string().min(1).max(120).optional().describe('图片图层编号；不给则新建图层'),
    color: colorSchema.describe('颜色 #RRGGBB；渐变时是起点颜色'),
    to_color: colorSchema.optional().describe('渐变终点颜色'),
    direction: z.enum(['top_to_bottom', 'bottom_to_top', 'left_to_right', 'right_to_left', 'radial']).optional().describe('渐变方向，默认 top_to_bottom'),
    opacity: z.number().min(0.01).max(1).optional().describe('不透明度 0–1，默认 1'),
    keep_transparency: z.boolean().optional().describe('只染已有像素，透明处不变'),
    name: z.string().min(1).max(60).optional().describe('新建图层时的名字')
  }).strict(),
  registryName: 'scene.update_elements',
  describe: (args) => `${args.target === undefined ? '新建图层并' : `给 ${args.target} `}${args.to_color === undefined ? `填充 ${args.color}` : `铺 ${args.color} → ${args.to_color} 渐变`}`,
  async prepare(args, context) {
    if (args.direction !== undefined && args.to_color === undefined) return rejected('direction 只用于渐变。', '渐变要同时给 to_color；纯色只给 color。')
    let target: ImageElement | null = null
    if (args.target !== undefined) {
      const resolved = context.refs.resolve(args.target, context.scene)
      if (typeof resolved === 'string') return rejected(resolved)
      if (resolved.type === 'text' || resolved.type === 'shape') {
        return rejected(`${args.target} 是${resolved.type === 'text' ? '文字' : '形状'}，不是像素图层。`, '改它的颜色用 update 的 color；要在它的像素上铺色，先用 merge_layers 把它栅格化。')
      }
      if (resolved.type !== 'image') return rejected(`${args.target} 不是图片图层。`, '不给 target 可以新建一个图层来填。')
      if (resolved.locked) return rejected(`${args.target} 已锁定。`)
      if ((resolved.paint?.length ?? 0) >= MAX_PAINT_OPS) return rejected(`${args.target} 的绘制记录已满。`, '先用 merge_layers 栅格化它，再填充。')
      target = resolved
    }

    // Gradients run across the part of the picture the layer shows, in the layer's own pixels.
    let size: { readonly width: number; readonly height: number } | null
    if (target === null) {
      size = { width: context.scene.canvas.outputWidth, height: context.scene.canvas.outputHeight }
    } else {
      size = await context.assetSize?.(target.assetId) ?? null
      if (size === null && args.to_color !== undefined) return rejected('现在读不到这张图的尺寸。', '稍后再试，或改用纯色。')
    }
    const crop = target?.crop ?? { x: 0, y: 0, width: 1, height: 1 }
    const from = paintColor(args.color)
    const lockAlpha = args.keep_transparency === true
    let op: PaintOp
    if (args.to_color === undefined) {
      op = { id: context.newId(), kind: 'fill-all', color: from.color, opacity: (args.opacity ?? 1) * from.alpha, lockAlpha }
    } else {
      const to = paintColor(args.to_color)
      const box = { x: crop.x * size!.width, y: crop.y * size!.height, width: crop.width * size!.width, height: crop.height * size!.height }
      const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
      const direction = args.direction ?? 'top_to_bottom'
      const ends: Record<typeof direction, readonly [readonly [number, number], readonly [number, number]]> = {
        top_to_bottom: [[centre.x, box.y], [centre.x, box.y + box.height]],
        bottom_to_top: [[centre.x, box.y + box.height], [centre.x, box.y]],
        left_to_right: [[box.x, centre.y], [box.x + box.width, centre.y]],
        right_to_left: [[box.x + box.width, centre.y], [box.x, centre.y]],
        radial: [[centre.x, centre.y], [centre.x + Math.hypot(box.width, box.height) / 2, centre.y]]
      }
      const round = (value: number): number => Math.round(value * 100) / 100
      const [start, end] = ends[direction]
      op = {
        id: context.newId(), kind: 'gradient', shape: direction === 'radial' ? 'radial' : 'linear',
        from: [round(start[0]), round(start[1])], to: [round(end[0]), round(end[1])],
        colors: [from.color, to.color], opacity: (args.opacity ?? 1) * Math.min(from.alpha, to.alpha), lockAlpha
      }
    }
    const what = args.to_color === undefined ? `纯色 ${from.color}` : `${DIRECTIONS[args.direction ?? 'top_to_bottom']}的 ${from.color} → ${paintColor(args.to_color).color} 渐变`

    if (target !== null) {
      const ref = context.refs.ref(target.id)
      return sceneWrite(batchPlan(`给 ${target.name} 填充`, [{ kind: 'element.update', elementId: target.id, changes: { paint: [...target.paint ?? [], op] } }]),
        context, `已给 ${ref} 铺上${what}${lockAlpha ? '（只染已有像素）' : ''}`, [target.id])
    }

    const assetId = await context.blankLayer?.() ?? null
    if (assetId === null) return rejected('现在建不了新图层。', '先选一个已有的图片图层来填。')
    const layer: SceneElement = {
      ...elementBase(context, { name: args.name ?? (args.to_color === undefined ? '纯色填充' : '渐变填充'), transform: { x: 0, y: 0, width: 1, height: 1, rotation: 0 }, role: 'background' }),
      type: 'image',
      assetId,
      crop: { x: 0, y: 0, width: 1, height: 1 },
      fit: 'fill',
      referenceRole: 'general',
      paint: [op]
    }
    return sceneWrite(createPlan(context, `新建${layer.name}图层`, [layer]), context, `已新建图层并铺上${what}，在最上面`, [layer.id])
  }
})
