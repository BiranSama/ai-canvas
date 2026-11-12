import { z } from 'zod'
import { calculateOutputSize, createCanvasResizeCommands, MAX_NORMALIZED_SIZE, parseAspectRatio, reframeScene, type Canvas } from '../../../domain'
import { colorSchema } from './geometry'
import { batchPlan, sceneWrite } from './scene-write'
import { defineTool, rejected } from './types'

export const setCanvasTool = defineTool({
  name: 'set_canvas',
  title: '调整画布',
  description: '只改传入的画布属性：比例、背景色、透明背景、整体风格说明。改比例时已有对象按比例缩放并居中，不会变形。extend [左,上,右,下] 像素：四边加出（负数裁掉），各层原地不动，新区域是背景色。',
  parameters: z.object({
    ratio: z.string().max(20).optional().describe('宽:高，如 "4:5"、"16:9"'),
    background: colorSchema.optional().describe('背景色 #RRGGBB'),
    transparent: z.boolean().optional().describe('透明背景'),
    style: z.string().max(1_000).optional().describe('整体风格说明，生图时使用'),
    extend: z.array(z.number().int()).length(4).optional()
  }).strict(),
  registryName: 'scene.set_canvas',
  describe: (args) => [
    ...(args.ratio === undefined ? [] : [`比例改为 ${args.ratio}`]),
    ...(args.background === undefined ? [] : [`背景改为 ${args.background}`]),
    ...(args.transparent === undefined ? [] : [args.transparent ? '透明背景' : '不透明背景']),
    ...(args.style === undefined ? [] : ['更新整体风格']),
    ...(args.extend === undefined ? [] : [`画布四边 ${args.extend.join('、')} 像素`])
  ].join('，') || '调整画布',
  prepare(args, context) {
    const current = context.scene.canvas
    if (args.ratio === undefined && args.background === undefined && args.transparent === undefined && args.style === undefined && args.extend === undefined) {
      return rejected('没有要修改的画布属性。', '至少传入 ratio、background、transparent、style、extend 之一。')
    }
    if (args.extend !== undefined) {
      if (args.ratio !== undefined) return rejected('ratio 和 extend 只用一个。')
      const [left = 0, top = 0, right = 0, bottom = 0] = args.extend
      const frame = { left: -left, top: -top, width: current.outputWidth + left + right, height: current.outputHeight + top + bottom }
      if (frame.width < 64 || frame.height < 64 || frame.width > 16384 || frame.height > 16384) return rejected(`画布会变成 ${frame.width}×${frame.height}，要在 64~16384 像素之间。`)
      const plan = reframeScene(context.scene, frame)
      if (plan.outOfRange.length > 0) return rejected(`${plan.outOfRange.slice(0, 3).map((name) => `「${name}」`).join('')} 在新画布上会比画布大或远出 ${MAX_NORMALIZED_SIZE} 倍，存不下。`, '先缩小、移近或删掉这些图层，或者少裁一些。')
      // An adjustment layer's mask is in the canvas's pixels and has to be cut to the new frame, which only the canvas can do.
      if (plan.maskRemaps.length > 0) return rejected('画布上有带蒙版的调整图层，它们的蒙版要跟着裁切，请用户在画布上用裁剪工具（C）或画布大小（Ctrl+Alt+C）调整。')
      const extras = {
        ...(args.background === undefined ? {} : { backgroundColor: args.background }),
        ...(args.transparent === undefined ? {} : { transparent: args.transparent }),
        ...(args.style === undefined ? {} : { globalStyle: args.style })
      }
      const commands = plan.commands.map((command) => command.kind === 'scene.set-canvas' ? { ...command, canvas: { ...command.canvas, ...extras } } : command)
      const summary = `画布由 ${current.outputWidth}×${current.outputHeight} 改为 ${plan.canvas.outputWidth}×${plan.canvas.outputHeight}，每层原地不动`
      return sceneWrite(batchPlan(summary, commands), context, summary, context.scene.elements.map((element) => element.id))
    }
    let next: Canvas = {
      ...current,
      ...(args.background === undefined ? {} : { backgroundColor: args.background }),
      ...(args.transparent === undefined ? {} : { transparent: args.transparent }),
      ...(args.style === undefined ? {} : { globalStyle: args.style })
    }
    let ratioChanged = false
    if (args.ratio !== undefined) {
      const parsed = parseAspectRatio(args.ratio)
      if (parsed.value === null) return rejected(`比例「${args.ratio}」无效：${parsed.error ?? ''}`, '用「宽:高」，如 "4:5"。')
      const size = calculateOutputSize(parsed.value, Math.max(current.outputWidth, current.outputHeight))
      ratioChanged = parsed.value.width !== current.aspectWidth || parsed.value.height !== current.aspectHeight
      next = { ...next, aspectWidth: parsed.value.width, aspectHeight: parsed.value.height, outputWidth: size.width, outputHeight: size.height }
    }
    const summary = ratioChanged ? `画布改为 ${next.aspectWidth}:${next.aspectHeight}，已有对象按比例缩放居中` : '画布已更新'
    const plan = ratioChanged && context.scene.elements.length > 0
      ? batchPlan(summary, createCanvasResizeCommands(context.scene, next, 'fit-content'))
      : { kind: 'scene.set_canvas' as const, expectedSceneRevision: context.scene.revision, summary, canvas: next }
    const step = sceneWrite(plan, context, summary, context.scene.elements.map((element) => element.id))
    if (step.kind !== 'execute') return step
    return {
      ...step,
      report: (executed) => {
        const result = step.report(executed)
        if (!result.ok) return result
        const after = executed.sceneAfter.canvas
        const canvasLine = `画布：${current.aspectWidth}:${current.aspectHeight} ${current.outputWidth}×${current.outputHeight} → ${after.aspectWidth}:${after.aspectHeight} ${after.outputWidth}×${after.outputHeight}，背景 ${current.backgroundColor} → ${after.backgroundColor}`
        return { ...result, details: [canvasLine, ...(result.details ?? [])] }
      }
    }
  }
})
