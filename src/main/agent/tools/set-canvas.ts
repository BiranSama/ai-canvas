import { z } from 'zod'
import { calculateOutputSize, createCanvasResizeCommands, parseAspectRatio, type Canvas } from '../../../domain'
import { colorSchema } from './geometry'
import { batchPlan, sceneWrite } from './scene-write'
import { defineTool, rejected } from './types'

export const setCanvasTool = defineTool({
  name: 'set_canvas',
  title: '调整画布',
  description: '只改传入的画布属性：比例、背景色、透明背景、整体风格说明。改比例时已有对象按比例缩放并居中，不会变形。',
  parameters: z.object({
    ratio: z.string().max(20).optional().describe('宽:高，如 "4:5"、"16:9"'),
    background: colorSchema.optional().describe('背景色 #RRGGBB'),
    transparent: z.boolean().optional().describe('透明背景'),
    style: z.string().max(1_000).optional().describe('整体风格说明，生图时使用')
  }).strict(),
  registryName: 'scene.set_canvas',
  describe: (args) => [
    ...(args.ratio === undefined ? [] : [`比例改为 ${args.ratio}`]),
    ...(args.background === undefined ? [] : [`背景改为 ${args.background}`]),
    ...(args.transparent === undefined ? [] : [args.transparent ? '透明背景' : '不透明背景']),
    ...(args.style === undefined ? [] : ['更新整体风格'])
  ].join('，') || '调整画布',
  prepare(args, context) {
    const current = context.scene.canvas
    if (args.ratio === undefined && args.background === undefined && args.transparent === undefined && args.style === undefined) {
      return rejected('没有要修改的画布属性。', '至少传入 ratio、background、transparent、style 之一。')
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
