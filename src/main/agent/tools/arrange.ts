import { z } from 'zod'
import type { NormalizedTransform, SceneElement } from '../../../domain'
import { boundsOf } from './geometry'
import { sceneWrite } from './scene-write'
import { defineTool, rejected, resolveTargets } from './types'

const SAFE_MARGIN = 0.05

const HOW = [
  'left', 'center', 'right', 'top', 'middle', 'bottom',
  'distribute-horizontal', 'distribute-vertical',
  'center-on-canvas', 'lower-third', 'safe-margin'
] as const

type How = typeof HOW[number]

const HOW_LABELS: Readonly<Record<How, string>> = {
  left: '左对齐', center: '水平居中对齐', right: '右对齐', top: '顶对齐', middle: '垂直居中对齐', bottom: '底对齐',
  'distribute-horizontal': '水平等距分布', 'distribute-vertical': '垂直等距分布',
  'center-on-canvas': '在画布居中', 'lower-third': '移到下三分之一', 'safe-margin': '收进安全边距'
}

type Moves = Map<string, NormalizedTransform>

function shifted(element: SceneElement, dx: number, dy: number): NormalizedTransform {
  return { ...element.transform, x: element.transform.x + dx, y: element.transform.y + dy }
}

/** Pure layout math in normalized canvas units; returns new transforms by element id. */
export function arrangeTransforms(elements: readonly SceneElement[], how: How, relativeTo: 'canvas' | 'targets'): Moves | string {
  const moves: Moves = new Map()
  const frame = relativeTo === 'canvas' || elements.length === 1 ? { x: 0, y: 0, width: 1, height: 1, rotation: 0 } : boundsOf(elements)
  const bounds = boundsOf(elements)
  const each = (move: (element: SceneElement) => NormalizedTransform): Moves => {
    for (const element of elements) moves.set(element.id, move(element))
    return moves
  }
  switch (how) {
    case 'left': return each((element) => ({ ...element.transform, x: frame.x }))
    case 'right': return each((element) => ({ ...element.transform, x: frame.x + frame.width - element.transform.width }))
    case 'center': return each((element) => ({ ...element.transform, x: frame.x + (frame.width - element.transform.width) / 2 }))
    case 'top': return each((element) => ({ ...element.transform, y: frame.y }))
    case 'bottom': return each((element) => ({ ...element.transform, y: frame.y + frame.height - element.transform.height }))
    case 'middle': return each((element) => ({ ...element.transform, y: frame.y + (frame.height - element.transform.height) / 2 }))
    case 'center-on-canvas':
      return each((element) => shifted(element, (1 - bounds.width) / 2 - bounds.x, (1 - bounds.height) / 2 - bounds.y))
    case 'lower-third': {
      const top = Math.min(2 / 3, 1 - SAFE_MARGIN - bounds.height)
      return each((element) => shifted(element, 0, top - bounds.y))
    }
    case 'safe-margin': {
      const limit = 1 - 2 * SAFE_MARGIN
      return each((element) => {
        const scale = Math.min(1, limit / element.transform.width, limit / element.transform.height)
        const width = element.transform.width * scale
        const height = element.transform.height * scale
        const x = Math.min(Math.max(element.transform.x, SAFE_MARGIN), 1 - SAFE_MARGIN - width)
        const y = Math.min(Math.max(element.transform.y, SAFE_MARGIN), 1 - SAFE_MARGIN - height)
        return { ...element.transform, x, y, width, height }
      })
    }
    case 'distribute-horizontal':
    case 'distribute-vertical': {
      if (elements.length < 3) return '等距分布至少需要 3 个对象。'
      const horizontal = how === 'distribute-horizontal'
      const sorted = [...elements].sort((left, right) => horizontal ? left.transform.x - right.transform.x : left.transform.y - right.transform.y)
      const total = sorted.reduce((sum, element) => sum + (horizontal ? element.transform.width : element.transform.height), 0)
      const span = horizontal ? bounds.width : bounds.height
      const gap = (span - total) / (sorted.length - 1)
      let cursor = horizontal ? bounds.x : bounds.y
      for (const element of sorted) {
        moves.set(element.id, horizontal ? { ...element.transform, x: cursor } : { ...element.transform, y: cursor })
        cursor += (horizontal ? element.transform.width : element.transform.height) + gap
      }
      return moves
    }
  }
}

export const arrangeTool = defineTool({
  name: 'arrange',
  title: '排列对象',
  description: '对齐、等距分布、在画布居中、移到下三分之一、收进安全边距（四周留 5%）。一个对象时相对画布，多个对象默认相对它们整体的范围。',
  parameters: z.object({
    targets: z.array(z.string().min(1).max(120)).min(1).max(50),
    how: z.enum(HOW),
    relativeTo: z.enum(['canvas', 'targets']).optional().describe('对齐参照：canvas 画布，targets 这些对象的整体范围')
  }).strict(),
  registryName: 'scene.update_elements',
  describe: (args) => `${args.targets.join('、')} ${HOW_LABELS[args.how]}`,
  prepare(args, context) {
    const targets = resolveTargets(args.targets, context)
    if (typeof targets === 'string') return rejected(targets)
    const moves = arrangeTransforms(targets, args.how, args.relativeTo ?? (targets.length === 1 ? 'canvas' : 'targets'))
    if (typeof moves === 'string') return rejected(moves)
    const updates = targets.flatMap((element) => {
      const transform = moves.get(element.id)
      return transform === undefined ? [] : [{ elementId: element.id, changes: { transform } }]
    })
    return sceneWrite({
      kind: 'scene.update_elements',
      expectedSceneRevision: context.scene.revision,
      summary: HOW_LABELS[args.how],
      updates
    }, context, `${HOW_LABELS[args.how]}完成`, targets.map((element) => element.id))
  }
})
