import { z } from 'zod'
import { ADJUSTMENT_KINDS, adjustmentSettingsSchema, MAX_LAYER_ADJUSTMENTS, WHOLE_CANVAS, type AdjustmentKind, type AdjustmentSettings, type LayerAdjustment, type SceneCommand, type SceneElement } from '../../../domain'
import { ADJUSTMENT_LABELS, defaultAdjustment, describeAdjustment } from '../../../shared/adjustments'
import { colorSchema } from './geometry'
import { batchPlan, elementBase, sceneWrite } from './scene-write'
import { defineTool, rejected } from './types'

/*
 * Photoshop's adjustments for the Agent: on an image layer they change that
 * layer alone (its own adjustments, as 图像 > 调整 does); without a target
 * they come as an adjustment layer over everything below it. Nothing is
 * charged and every step undoes.
 */

const triple = z.tuple([z.number().int().min(-100).max(100), z.number().int().min(-100).max(100), z.number().int().min(-100).max(100)])
const percent = z.number().int().min(-200).max(300)

/** The settings, by the names the tool description lists; checked here so the tool's own schema stays short. */
const valuesSchema = z.object({
  brightness: z.number().int().min(-150).max(150),
  contrast: z.number().int().min(-50).max(100),
  input_black: z.number().int().min(0).max(253),
  input_white: z.number().int().min(2).max(255),
  midtone: z.number().min(0.1).max(9.99),
  output_black: z.number().int().min(0).max(255),
  output_white: z.number().int().min(0).max(255),
  curve: z.array(z.tuple([z.number().int().min(0).max(255), z.number().int().min(0).max(255)])).min(2).max(16),
  exposure: z.number().min(-20).max(20),
  offset: z.number().min(-0.5).max(0.5),
  gamma: z.number().min(0.01).max(9.99),
  vibrance: z.number().int().min(-100).max(100),
  saturation: z.number().int().min(-100).max(100),
  hue: z.number().int().min(-180).max(360),
  lightness: z.number().int().min(-100).max(100),
  colorize: z.boolean(),
  shadows: triple,
  midtones: triple,
  highlights: triple,
  preserve_luminosity: z.boolean(),
  reds: percent, yellows: percent, greens: percent, cyans: percent, blues: percent, magentas: percent,
  tint: colorSchema
}).partial().strict()

const parameters = z.object({
  kind: z.enum(ADJUSTMENT_KINDS),
  target: z.string().min(1).max(120).optional().describe('图片图层：只调这一层；调整图层：改它；不给：新建调整图层'),
  values: z.record(z.string(), z.unknown()).optional().describe('参数，见说明；只给要改的'),
  remove: z.boolean().optional().describe('去掉 target 图片上这种调整'),
  above: z.string().min(1).max(120).optional().describe('新建调整图层放在这个图层正上方，默认最上面'),
  opacity: z.number().min(0).max(1).optional(),
  name: z.string().min(1).max(60).optional()
}).strict()

type Values = z.infer<typeof valuesSchema>


/** The settings the arguments describe, from Photoshop's defaults for the kind, or why they make none. */
function settingsFrom(kind: AdjustmentKind, args: Values, base: AdjustmentSettings = defaultAdjustment(kind)): AdjustmentSettings | string {
  const from = base.kind === kind ? base : defaultAdjustment(kind)
  let draft: unknown
  switch (from.kind) {
    case 'brightness-contrast':
      draft = { ...from, brightness: args.brightness ?? from.brightness, contrast: args.contrast ?? from.contrast }
      break
    case 'levels': {
      const rgb = from.channels.rgb
      draft = { ...from, channels: { ...from.channels, rgb: {
        inputBlack: args.input_black ?? rgb.inputBlack, inputWhite: args.input_white ?? rgb.inputWhite, gamma: args.midtone ?? rgb.gamma,
        outputBlack: args.output_black ?? rgb.outputBlack, outputWhite: args.output_white ?? rgb.outputWhite
      } } }
      break
    }
    case 'curves':
      draft = { ...from, channels: { ...from.channels, rgb: args.curve ?? from.channels.rgb } }
      break
    case 'exposure':
      draft = { ...from, exposure: args.exposure ?? from.exposure, offset: args.offset ?? from.offset, gamma: args.gamma ?? from.gamma }
      break
    case 'vibrance':
      draft = { ...from, vibrance: args.vibrance ?? from.vibrance, saturation: args.saturation ?? from.saturation }
      break
    case 'hue-saturation': {
      const colorize = args.colorize ?? from.colorize !== null
      draft = colorize
        ? { ...from, colorize: { hue: args.hue ?? from.colorize?.hue ?? 30, saturation: args.saturation ?? from.colorize?.saturation ?? 25, lightness: args.lightness ?? from.colorize?.lightness ?? 0 } }
        : { ...from, colorize: null, hue: args.hue ?? from.hue, saturation: args.saturation ?? from.saturation, lightness: args.lightness ?? from.lightness }
      break
    }
    case 'color-balance':
      draft = { ...from, shadows: args.shadows ?? from.shadows, midtones: args.midtones ?? from.midtones, highlights: args.highlights ?? from.highlights, preserveLuminosity: args.preserve_luminosity ?? from.preserveLuminosity }
      break
    case 'black-white':
      draft = {
        ...from, reds: args.reds ?? from.reds, yellows: args.yellows ?? from.yellows, greens: args.greens ?? from.greens, cyans: args.cyans ?? from.cyans,
        blues: args.blues ?? from.blues, magentas: args.magentas ?? from.magentas, tint: args.tint === undefined ? from.tint : args.tint.slice(0, 7).toUpperCase()
      }
      break
    default:
      draft = from
  }
  const parsed = adjustmentSettingsSchema.safeParse(draft)
  return parsed.success ? parsed.data : `参数不成立：${parsed.error.issues.map((issue) => issue.message).join('；')}`
}

export const adjustTool = defineTool({
  name: 'adjust',
  title: '调整',
  description: '像 Photoshop 的调整，不花钱、可撤销。target 是图片图层时只改这一层（原图不变）；不给 target 新建调整图层，改它下面所有图层，适合整体调色，只调一部分再用 mask_layer 给它加蒙版；target 是调整图层时改它。同一图层上已有同种调整时改那一个。文字和形状不能直接调：用调整图层或先 merge_layers。values 按 kind：brightness-contrast：brightness -150~150、contrast -50~100；levels：input_black、input_white、midtone（0.1~9.99，大于 1 变亮）、output_black、output_white；curves：curve [[输入,输出],…]；exposure：exposure（档）、offset、gamma；vibrance：vibrance、saturation；hue-saturation：hue、saturation、lightness，colorize 为 true 时整体染成 hue（0~360）；color-balance：shadows、midtones、highlights 各 [青红,洋绿,黄蓝] -100~100，preserve_luminosity；black-white：reds、yellows、greens、cyans、blues、magentas（%），tint #RRGGBB。invert、desaturate 不用参数。偏暗用 exposure 或 levels 的 midtone；发灰拉近 input_black、input_white；更鲜艳用 vibrance。',
  parameters,
  registryName: 'scene.update_elements',
  describe: (args) => `${args.target === undefined ? '新建调整图层：' : `调整 ${args.target}：`}${ADJUSTMENT_LABELS[args.kind]}${args.remove === true ? '（去掉）' : ''}`,
  async prepare(args, context) {
    const parsedValues = valuesSchema.safeParse(args.values ?? {})
    if (!parsedValues.success) return rejected(`values 不成立：${parsedValues.error.issues.map((issue) => `${issue.path.join('.') || '参数'} ${issue.message}`).join('；')}`, '名字和范围见 adjust 的说明。')
    const values = parsedValues.data
    if (args.target === undefined) {
      if (args.remove === true) return rejected('remove 要给 target。', '去掉调整图层用 remove 工具。')
      const settings = settingsFrom(args.kind, values)
      if (typeof settings === 'string') return rejected(settings)
      let above: SceneElement | null = null
      if (args.above !== undefined) {
        const resolved = context.refs.resolve(args.above, context.scene)
        if (typeof resolved === 'string') return rejected(resolved)
        above = resolved
      }
      const base = elementBase(context, { name: args.name ?? `${ADJUSTMENT_LABELS[args.kind]} 调整`, transform: { ...WHOLE_CANVAS }, role: 'adjustment' })
      const layer: SceneElement = { ...base, type: 'adjustment', opacity: args.opacity ?? 1, settings, mask: null }
      const commands: SceneCommand[] = [{ kind: 'element.add', element: layer }]
      // A group's marker sits at its lowest child, so above a group means above its topmost child.
      const aboveId = above?.id
      const top = above === null ? -1 : Math.max(above.zIndex, ...context.scene.elements.filter((element) => element.groupId === aboveId).map((element) => element.zIndex))
      if (above !== null && top + 1 < context.scene.elements.length) commands.push({ kind: 'element.reorder', elementId: layer.id, toIndex: top + 1 })
      return sceneWrite(batchPlan(`新建调整图层「${layer.name}」`, commands), context,
        `已新建调整图层「${layer.name}」：${describeAdjustment(settings)}，作用于${above === null ? '它下面的所有图层（在最上面）' : `${context.refs.ref(above.id)} 及以下的所有图层`}`, [layer.id])
    }

    const resolved = context.refs.resolve(args.target, context.scene)
    if (typeof resolved === 'string') return rejected(resolved)
    const ref = context.refs.ref(resolved.id)
    if (resolved.locked) return rejected(`${ref} 已锁定。`)

    if (resolved.type === 'adjustment') {
      if (args.remove === true) return rejected('remove 用于图片图层自身的调整。', `去掉调整图层 ${ref} 用 remove 工具。`)
      const settings = settingsFrom(args.kind, values, resolved.settings)
      if (typeof settings === 'string') return rejected(settings)
      const changes: Record<string, unknown> = { settings, ...(args.opacity === undefined ? {} : { opacity: args.opacity }) }
      return sceneWrite(batchPlan(`修改调整图层「${resolved.name}」`, [{ kind: 'element.update', elementId: resolved.id, changes }]), context,
        `已把调整图层 ${ref} 改为 ${describeAdjustment(settings)}`, [resolved.id])
    }

    if (resolved.type === 'text' || resolved.type === 'shape') {
      return rejected(`${ref} 是${resolved.type === 'text' ? '文字' : '形状'}，不能直接调整。`, '不给 target 新建调整图层（可再用 mask_layer 限定范围），或先用 merge_layers 把它栅格化。')
    }
    if (resolved.type !== 'image') return rejected(`${ref} 不是图片图层。`, '不给 target 可以新建调整图层。')
    const list = resolved.adjustments ?? []
    if (args.remove === true) {
      const kept = list.filter((adjustment) => adjustment.settings.kind !== args.kind)
      if (kept.length === list.length) return rejected(`${ref} 上没有${ADJUSTMENT_LABELS[args.kind]}。`)
      return sceneWrite(batchPlan(`去掉 ${resolved.name} 的${ADJUSTMENT_LABELS[args.kind]}`, [{ kind: 'element.update', elementId: resolved.id, changes: { adjustments: kept } }]), context,
        `已去掉 ${ref} 上的${ADJUSTMENT_LABELS[args.kind]}`, [resolved.id])
    }
    // The latest of the same kind made on the whole layer is changed rather than another one stacked on it.
    const index = list.map((adjustment) => adjustment.settings.kind === args.kind && adjustment.clip === undefined).lastIndexOf(true)
    const settings = settingsFrom(args.kind, values, index < 0 ? undefined : list[index]!.settings)
    if (typeof settings === 'string') return rejected(settings)
    if (index < 0 && list.length >= MAX_LAYER_ADJUSTMENTS) return rejected(`${ref} 上的调整已经有 ${MAX_LAYER_ADJUSTMENTS} 个。`, '先去掉一些，或用调整图层。')
    const next: LayerAdjustment[] = index < 0
      ? [...list, { id: context.newId(), enabled: true, settings }]
      : list.map((adjustment, at) => at === index ? { ...adjustment, enabled: true, settings } : adjustment)
    return sceneWrite(batchPlan(`调整 ${resolved.name}：${ADJUSTMENT_LABELS[args.kind]}`, [{ kind: 'element.update', elementId: resolved.id, changes: { adjustments: next } }]), context,
      `已${index < 0 ? '给' : '改'} ${ref} 的${describeAdjustment(settings)}，只改这一层`, [resolved.id])
  }
})
