import { z } from 'zod'
import type { SceneElement } from '../../../domain'
import { boxToTransform, colorSchema, percentBoxSchema, readableTextColor, type PercentBox } from './geometry'
import { createPlan, elementBase, sceneWrite } from './scene-write'
import { resolveFontName } from './fonts'
import { defineTool, rejected } from './types'

const ROLES = {
  title: { label: '标题', size: 0.075, weight: 600, box: [10, 8, 80], align: 'center', lineHeight: 1.15, letterSpacing: 0, weightLevel: 'primary' },
  subtitle: { label: '副标题', size: 0.04, weight: 400, box: [10, 23, 80], align: 'center', lineHeight: 1.3, letterSpacing: 1, weightLevel: 'secondary' },
  body: { label: '正文', size: 0.028, weight: 400, box: [10, 70, 80], align: 'start', lineHeight: 1.6, letterSpacing: 0, weightLevel: 'secondary' },
  caption: { label: '说明', size: 0.022, weight: 400, box: [10, 89, 80], align: 'center', lineHeight: 1.4, letterSpacing: 1, weightLevel: 'whisper' },
  label: { label: '标签', size: 0.02, weight: 500, box: [8, 5, 40], align: 'start', lineHeight: 1.2, letterSpacing: 4, weightLevel: 'whisper' }
} as const

/** Height that fits the text at the given size, assuming full-width CJK glyphs. */
function fittedHeight(content: string, size: number, lineHeight: number, widthPercent: number, canvasWidth: number, canvasHeight: number): number {
  const boxWidthPx = Math.max(1, widthPercent / 100 * canvasWidth)
  const lines = content.split('\n').reduce((total, line) => total + Math.max(1, Math.ceil([...line].length * size / boxWidthPx)), 0)
  return Math.min(100, Math.round((lines * size * lineHeight + size * 0.4) / canvasHeight * 1000) / 10)
}

export const addTextTool = defineTool({
  name: 'add_text',
  title: '添加文字',
  description: '按角色添加一段文字，字号、字重、位置和颜色都有合适的默认值，只传需要改的。',
  parameters: z.object({
    content: z.string().min(1).max(2_000).describe('文字内容，原样使用'),
    role: z.enum(['title', 'subtitle', 'body', 'caption', 'label']).describe('title 标题，subtitle 副标题，body 正文，caption 说明，label 标签'),
    box: percentBoxSchema.optional().describe('位置 [x, y, 宽, 高]；不填按角色放'),
    align: z.enum(['start', 'center', 'end', 'justify']).optional(),
    font: z.string().min(1).max(120).optional().describe('本机字体的中文名或英文名，不填用默认字体'),
    size: z.number().min(8).max(512).optional().describe('字号，像素'),
    weight: z.number().int().min(100).max(900).optional().describe('字重 100–900'),
    color: colorSchema.optional(),
    letterSpacing: z.number().min(-100).max(100).optional(),
    lineHeight: z.number().min(0.5).max(5).optional(),
    vertical: z.boolean().optional().describe('竖排')
  }).strict(),
  registryName: 'scene.create_elements',
  describe: (args) => `添加${ROLES[args.role].label}「${args.content.slice(0, 20)}」`,
  prepare(args, context) {
    const font = args.font === undefined ? null : resolveFontName(args.font, context)
    if (font !== null && 'problem' in font) return rejected(font.problem, font.hint)
    const canvas = context.scene.canvas
    const role = ROLES[args.role]
    const size = args.size ?? Math.max(8, Math.min(512, Math.round(canvas.outputWidth * role.size)))
    const lineHeight = args.lineHeight ?? role.lineHeight
    const [x, y, width] = args.box ?? role.box
    const box: PercentBox = args.box ?? [x, y, width, fittedHeight(args.content, size, lineHeight, width, canvas.outputWidth, canvas.outputHeight)]
    const element: SceneElement = {
      ...elementBase(context, { name: `${role.label}·${args.content.replace(/\s+/g, ' ').slice(0, 16)}`, transform: boxToTransform(box), role: args.role }),
      type: 'text',
      content: args.content,
      orientation: args.vertical === true ? 'vertical' : 'horizontal',
      align: args.align ?? role.align,
      wrapping: 'word',
      fontFamily: font?.family ?? 'Segoe UI Variable',
      fontSize: size,
      fontWeight: args.weight ?? role.weight,
      fill: args.color ?? readableTextColor(canvas.backgroundColor),
      stroke: null,
      strokeWidth: 0,
      shadowColor: null,
      shadowBlur: 0,
      letterSpacing: args.letterSpacing ?? role.letterSpacing,
      lineHeight,
      accuracy: 'strict',
      visualWeight: role.weightLevel,
      styleDescription: '',
      renderStrategy: 'standard',
      resultAssetId: null
    }
    return sceneWrite(createPlan(context, `添加${role.label}`, [element]), context, `已添加${role.label}「${args.content.slice(0, 20)}」`, [element.id])
  }
})
