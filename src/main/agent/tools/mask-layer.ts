import { z } from 'zod'
import type { SceneCommand, SceneElement } from '../../../domain'
import type { LayerMaskShape } from '../../paint/layer-mask-build'
import { percentBoxSchema } from './geometry'
import { batchPlan, sceneWrite } from './scene-write'
import { defineTool, rejected, type AgentToolContext } from './types'

type PictureLayer = Extract<SceneElement, { type: 'image' | 'text' | 'shape' }>

const SOURCES = { subject: '主体', box: '方框', ellipse: '椭圆', selection: '用户的选区', current: '现有蒙版' } as const
const COMBINE = { replace: '', add: '加进', subtract: '从中减去', intersect: '只留与之重叠的' } as const

/** The person's marked outlines for this turn, and the parts within them they marked to keep as they are, such as a selection's holes. */
function markedOutlines(context: AgentToolContext): Extract<LayerMaskShape, { kind: 'polygons' }> {
  const marked = context.marked
  const regions = marked === null || marked === undefined ? [] : (marked.regions ?? [marked]).filter((region) => region.closed)
  return {
    kind: 'polygons',
    polygons: regions.filter((region) => region.mode !== 'protect').map((region) => region.points),
    holes: regions.filter((region) => region.mode === 'protect').map((region) => region.points)
  }
}

export const maskLayerTool = defineTool({
  name: 'mask_layer',
  title: '图层蒙版',
  description: '像 Photoshop 的图层蒙版：遮住图层的一部分而不删像素，随时能改回；用于图片、文字和形状图层，不花钱、可撤销。source 定蒙版显示哪里：subject 图片里的主体（本机模型，常用来去背景）、box 或 ellipse 一个框（region 给位置）、selection 用户本轮的选区、current 现有蒙版（配合 invert 反相或 feather 羽化）。invert 为 true 时反过来，遮住这块、露出其余。combine 和已有蒙版合起来：add 多露出、subtract 多遮住、intersect 只留重叠处，默认 replace 整个换掉。action：delete 删掉蒙版，apply 把蒙版应用进像素（遮住的像素真的删掉，文字和形状会栅格化），disable、enable 停用和启用。给生图用的修改区、保护区是 add_mask，不是这个。',
  parameters: z.object({
    target: z.string().min(1).max(120).describe('图层编号'),
    action: z.enum(['set', 'delete', 'apply', 'disable', 'enable']).optional().describe('默认 set：加上或改蒙版'),
    source: z.enum(['subject', 'box', 'ellipse', 'selection', 'current']).optional().describe('set 时必填：蒙版露出哪里'),
    region: percentBoxSchema.optional().describe('box、ellipse 的 [x, y, 宽, 高]，画布百分比'),
    invert: z.boolean().optional().describe('反过来：遮住这块，露出其余'),
    feather: z.number().min(0).max(250).optional().describe('边缘羽化，画布像素'),
    combine: z.enum(['replace', 'add', 'subtract', 'intersect']).optional().describe('和已有蒙版怎么合，默认 replace')
  }).strict(),
  registryName: 'scene.update_elements',
  available: (context) => context.layerMask !== null && context.layerMask !== undefined
    && context.scene.elements.some((element) => element.type === 'image' || element.type === 'text' || element.type === 'shape'),
  describe: (args) => {
    const action = args.action ?? 'set'
    if (action === 'delete') return `删掉 ${args.target} 的蒙版`
    if (action === 'apply') return `把 ${args.target} 的蒙版应用进像素`
    if (action === 'disable' || action === 'enable') return `${action === 'disable' ? '停用' : '启用'} ${args.target} 的蒙版`
    return `按${SOURCES[args.source ?? 'current']}给 ${args.target} 加蒙版${args.invert === true ? '（反相）' : ''}`
  },
  async prepare(args, context) {
    const resolved = context.refs.resolve(args.target, context.scene)
    if (typeof resolved === 'string') return rejected(resolved)
    if (resolved.type !== 'image' && resolved.type !== 'text' && resolved.type !== 'shape') {
      return rejected(`${args.target} 不是图片、文字或形状图层，没有图层蒙版。`)
    }
    if (resolved.locked) return rejected(`${args.target} 已锁定。`)
    const target: PictureLayer = resolved
    const ref = context.refs.ref(target.id)
    const mask = target.mask ?? null
    const action = args.action ?? 'set'

    if (action !== 'set') {
      if (args.source !== undefined || args.region !== undefined || args.invert !== undefined || args.feather !== undefined || args.combine !== undefined) {
        return rejected(`${action} 不带 source、region、invert、feather 或 combine。`, '要改蒙版的形状用 action=set。')
      }
      if (mask === null) return rejected(`${ref} 没有蒙版。`, '先用 action=set 加一个。')
      if (action === 'delete') {
        return sceneWrite(batchPlan(`删除 ${target.name} 的蒙版`, [{ kind: 'element.update', elementId: target.id, changes: { mask: null } }]), context, `已删掉 ${ref} 的蒙版，整个图层重新露出`, [target.id])
      }
      if (action === 'disable' || action === 'enable') {
        const enabled = action === 'enable'
        if (mask.enabled === enabled) return rejected(`${ref} 的蒙版已经${enabled ? '启用' : '停用'}了。`)
        return sceneWrite(batchPlan(`${enabled ? '启用' : '停用'} ${target.name} 的蒙版`, [{ kind: 'element.update', elementId: target.id, changes: { mask: { ...mask, enabled } } }]),
          context, `已${enabled ? '启用' : '停用'} ${ref} 的蒙版`, [target.id])
      }
      if (!mask.enabled) return rejected(`${ref} 的蒙版停用着。`, '先 enable 再 apply，或者直接 delete。')
      let commands: SceneCommand[]
      if (target.type === 'image') {
        const assetId = await context.bakeImage?.(target.id) ?? null
        if (assetId === null) return rejected('现在合不进这张图的像素。', '稍后再试。')
        commands = [{ kind: 'element.update', elementId: target.id, changes: { assetId, paint: [], mask: null } }]
      } else {
        const drawn = await context.drawLayers?.([target.id], target.id) ?? null
        if (drawn === null) return rejected('现在画不出这个图层。', '稍后再试。')
        commands = [{ kind: 'element.rasterize', elementId: target.id, assetId: drawn.assetId, transform: drawn.transform }]
      }
      return sceneWrite(batchPlan(`应用 ${target.name} 的蒙版`, commands), context,
        `已把 ${ref} 的蒙版应用进像素：遮住的部分删掉了${target.type === 'image' ? '' : '，图层已栅格化'}`, [target.id])
    }

    if (args.source === undefined) return rejected('action=set 要给 source。', 'subject 主体、box/ellipse 加 region、selection 用户选区、current 现有蒙版。')
    if ((args.source === 'box' || args.source === 'ellipse') !== (args.region !== undefined)) {
      return rejected(args.region === undefined ? `source=${args.source} 要给 region。` : 'region 只用于 box 和 ellipse。')
    }
    if (args.source === 'subject' && target.type !== 'image') return rejected(`${ref} 不是图片，没有主体可找。`, '文字和形状用 box、ellipse 或 selection。')
    if (args.source === 'current' && mask === null) return rejected(`${ref} 还没有蒙版。`, '先用别的 source 加一个。')
    if (args.source === 'current' && args.invert !== true && (args.feather ?? 0) === 0) return rejected('source=current 要配合 invert 或 feather。')
    if (args.source === 'current' && args.combine !== undefined) return rejected('source=current 不带 combine。')

    let shape: LayerMaskShape
    if (args.source === 'box' || args.source === 'ellipse') {
      const [x, y, width, height] = args.region!
      shape = { kind: args.source, box: { x: x / 100, y: y / 100, width: width / 100, height: height / 100 } }
    } else if (args.source === 'selection') {
      const outlines = markedOutlines(context)
      if (outlines.polygons.length === 0) return rejected('用户这一轮没有选区。', '用 box 或 ellipse 给出区域，或请用户先在画布上选出来。')
      shape = outlines
    } else {
      shape = { kind: args.source }
    }
    const combine = args.combine ?? 'replace'
    const built = await context.layerMask!({ elementId: target.id, shape, combine, invert: args.invert === true, feather: args.feather ?? 0 })
    if (typeof built === 'string') {
      return rejected(built, args.source === 'subject' && built.includes('模型') ? '请用户在画布上点一次「选择主体」下载模型，或改用 box、selection。' : undefined)
    }
    const changes = { mask: { assetId: built.assetId, enabled: true } }
    const what = args.source === 'current'
      ? [args.invert === true ? '反相' : '', (args.feather ?? 0) > 0 ? `羽化 ${args.feather} 像素` : ''].filter(Boolean).join('并')
      : `${COMBINE[combine]}${SOURCES[args.source]}${args.invert === true ? '（反相：遮住这块）' : ''}${(args.feather ?? 0) > 0 ? `，边缘羽化 ${args.feather} 像素` : ''}`
    return sceneWrite(batchPlan(`给 ${target.name} 加蒙版`, [{ kind: 'element.update', elementId: target.id, changes }]), context,
      args.source === 'current' ? `已把 ${ref} 的蒙版${what}` : `已给 ${ref} ${mask === null ? '加上' : '改了'}蒙版：${what}`, [target.id])
  }
})
