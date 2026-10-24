import { z } from 'zod'
import type { SceneCommand, SceneElement } from '../../../domain'
import { batchPlan, sceneWrite } from './scene-write'
import { defineTool, rejected, resolveTargets } from './types'

type PictureLayer = Extract<SceneElement, { type: 'image' | 'text' | 'shape' }>

/** Pixels, text and shapes are picture; sketches, placeholders, lights and masks are notes for the AI. */
function isPictureLayer(element: SceneElement): element is PictureLayer {
  return element.type === 'image' || element.type === 'text' || (element.type === 'shape' && element.role === 'final')
}

export const mergeLayersTool = defineTool({
  name: 'merge_layers',
  title: '合并图层',
  description: '像 Photoshop 的合并图层：把几个图层按现在的样子合成一张图，放在其中最下面那层的位置、沿用它的名字，其余删掉。只给一个文字或形状图层时把它栅格化成图片（样子不变，之后才能 fill 或画笔改像素；文字不能再改字）。不花钱、可撤销。AI 标注（草图、主体占位、光影、蒙版）和隐藏的图层不能合并。',
  parameters: z.object({
    targets: z.array(z.string().min(1).max(120)).min(1).max(50).describe('图层编号；一个是栅格化，多个是合并')
  }).strict(),
  registryName: 'scene.remove_elements',
  available: (context) => context.drawLayers !== null && context.drawLayers !== undefined,
  describe: (args) => args.targets.length === 1 ? `栅格化 ${args.targets[0]}` : `合并 ${args.targets.join('、')}`,
  async prepare(args, context) {
    const resolved = resolveTargets(args.targets, context)
    if (typeof resolved === 'string') return rejected(resolved)
    const ids = new Set(resolved.flatMap((element) => element.type === 'group' ? element.childIds : [element.id]))
    // The stack order decides what covers what and which layer receives the rest.
    const layers = context.scene.elements.filter((element) => ids.has(element.id))
    const note = layers.find((element) => !isPictureLayer(element))
    if (note !== undefined) return rejected(`${context.refs.ref(note.id)}「${note.name}」是 AI 标注，不能合并。`, '只合并图片、文字和形状。')
    const locked = layers.find((element) => element.locked)
    if (locked !== undefined) return rejected(`${context.refs.ref(locked.id)}「${locked.name}」已锁定。`)
    const pictures = layers.filter(isPictureLayer)

    if (pictures.length === 1) {
      const only = pictures[0]!
      if (only.type === 'image') return rejected(`${context.refs.ref(only.id)} 已经是图片图层。`, '要合并就再给至少一个图层。')
      const drawn = await context.drawLayers?.([only.id], only.id) ?? null
      if (drawn === null) return rejected('现在画不出这个图层。', '稍后再试。')
      const ref = context.refs.ref(only.id)
      return sceneWrite(batchPlan(`栅格化 ${only.name}`, [{ kind: 'element.rasterize', elementId: only.id, assetId: drawn.assetId, transform: drawn.transform }]), context,
        `已把 ${ref}「${only.name}」栅格化成图片，样子不变`, [only.id])
    }

    const hidden = pictures.find((element) => !element.visible)
    if (hidden !== undefined) return rejected(`${context.refs.ref(hidden.id)}「${hidden.name}」是隐藏的。`, '先显示它，或不要合并它。')
    const drawn = await context.drawLayers?.(pictures.map((element) => element.id)) ?? null
    if (drawn === null) return rejected('现在画不出这些图层。', '稍后再试。')
    const bottom = pictures[0]!
    const commands: SceneCommand[] = [
      { kind: 'element.rasterize', elementId: bottom.id, assetId: drawn.assetId, transform: drawn.transform },
      // Each layer was drawn with its own opacity and blend, so the result shows them at full strength.
      { kind: 'element.update', elementId: bottom.id, changes: { opacity: 1, blendMode: 'normal' } },
      ...pictures.slice(1).map((element) => ({ kind: 'element.remove' as const, elementId: element.id }))
    ]
    const ref = context.refs.ref(bottom.id)
    return sceneWrite(batchPlan(`合并 ${pictures.length} 个图层`, commands), context,
      `已把 ${pictures.length} 个图层合并进 ${ref}「${bottom.name}」`, [bottom.id])
  }
})
