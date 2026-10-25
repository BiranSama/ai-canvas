import { z } from 'zod'
import type { SceneElement } from '../../../domain'
import { boxToTransform, percentBoxSchema } from './geometry'
import { createPlan, elementBase, sceneWrite } from './scene-write'
import { defineTool } from './types'

export const addSubjectTool = defineTool({
  name: 'add_subject',
  title: '添加主体占位',
  description: '放一个主体占位框（产品、人物、建筑等），说明主体是什么、怎么摆。生图时它告诉生图模型主体放在哪里。',
  parameters: z.object({
    subject: z.string().min(1).max(500).describe('主体是什么，如「磨砂玻璃香水瓶」'),
    box: percentBoxSchema.optional().describe('位置；不填放在画面中部偏下'),
    kind: z.enum(['product', 'portrait', 'architecture', 'botanical', 'abstract', 'album', 'coffee', 'landscape', 'generic']).optional(),
    pose: z.string().max(300).optional().describe('姿态或摆放'),
    facing: z.string().max(120).optional().describe('朝向'),
    notes: z.string().max(1_000).optional().describe('给生图的补充说明'),
    cutout: z.boolean().optional().describe('默认 true：生成后抠出主体，融进下面的画面；要保留整张带背景的图（相框里的照片、卡片）时填 false')
  }).strict(),
  registryName: 'scene.create_elements',
  describe: (args) => `添加主体「${args.subject.slice(0, 20)}」`,
  prepare(args, context) {
    const element: SceneElement = {
      ...elementBase(context, { name: `主体·${args.subject.slice(0, 16)}`, transform: boxToTransform(args.box ?? [20, 30, 60, 55]), role: 'subject' }),
      type: 'placeholder',
      subject: args.subject,
      pose: args.pose ?? '',
      facing: args.facing ?? '',
      allowOverflow: false,
      transparentBackground: args.cutout ?? true,
      frameShape: 'rectangle',
      visualKind: args.kind ?? 'generic',
      generationNotes: args.notes ?? ''
    }
    return sceneWrite(createPlan(context, '添加主体占位', [element]), context, `已添加主体占位「${args.subject.slice(0, 20)}」`, [element.id])
  }
})
