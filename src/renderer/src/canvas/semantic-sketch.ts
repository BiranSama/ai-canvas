import type { SceneElement } from '../../../domain'

export type SemanticPlaceholder = Extract<SceneElement, { type: 'placeholder' }>
export type SketchStrokeRole = 'primary' | 'secondary' | 'construction' | 'hatch' | 'light'
export type SketchPatchTone = 'cobalt' | 'iris' | 'champagne' | 'graphite'

export interface NormalizedSketchPath {
  readonly points: readonly number[]
  readonly role: SketchStrokeRole
  readonly closed?: boolean
  readonly tension?: number
  readonly dashed?: boolean
}

export interface NormalizedSketchEllipse {
  readonly x: number
  readonly y: number
  readonly radiusX: number
  readonly radiusY: number
  readonly rotation?: number
  readonly role: SketchStrokeRole
  readonly filled?: boolean
}

export interface NormalizedSketchRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly rotation?: number
  readonly role: SketchStrokeRole
  readonly filled?: boolean
}

export interface NormalizedSketchPatch {
  readonly points: readonly number[]
  readonly tone: SketchPatchTone
}

export interface SemanticSketchRecipe {
  readonly kind: NonNullable<SemanticPlaceholder['visualKind']>
  readonly paths: readonly NormalizedSketchPath[]
  readonly ellipses: readonly NormalizedSketchEllipse[]
  readonly rects: readonly NormalizedSketchRect[]
  readonly patches: readonly NormalizedSketchPatch[]
}

const path = (
  points: readonly number[],
  role: SketchStrokeRole = 'secondary',
  options: Pick<NormalizedSketchPath, 'closed' | 'tension' | 'dashed'> = {}
): NormalizedSketchPath => ({ points, role, ...options })

const ellipse = (
  x: number,
  y: number,
  radiusX: number,
  radiusY: number,
  role: SketchStrokeRole = 'secondary',
  rotation = 0,
  filled = false
): NormalizedSketchEllipse => ({ x, y, radiusX, radiusY, role, rotation, filled })

const rect = (
  x: number,
  y: number,
  width: number,
  height: number,
  role: SketchStrokeRole = 'secondary',
  rotation = 0,
  filled = false
): NormalizedSketchRect => ({ x, y, width, height, role, rotation, filled })

const patch = (points: readonly number[], tone: SketchPatchTone): NormalizedSketchPatch => ({ points, tone })

function botanicalRecipe(): SemanticSketchRecipe {
  const leaves = [
    [0.34, 0.72, 0.13, 0.66, 0.22, 0.6, 0.3, 0.63],
    [0.4, 0.63, 0.53, 0.58, 0.68, 0.62, 0.53, 0.68],
    [0.47, 0.54, 0.29, 0.44, 0.22, 0.38, 0.4, 0.45],
    [0.54, 0.45, 0.67, 0.38, 0.8, 0.42, 0.67, 0.49],
    [0.6, 0.36, 0.47, 0.27, 0.42, 0.2, 0.55, 0.27],
    [0.66, 0.27, 0.76, 0.2, 0.87, 0.23, 0.77, 0.3],
    [0.72, 0.18, 0.66, 0.1, 0.71, 0.05, 0.78, 0.12]
  ] as const
  return {
    kind: 'botanical',
    patches: [
      patch([0.18, 0.78, 0.42, 0.55, 0.73, 0.13, 0.82, 0.28, 0.55, 0.58, 0.31, 0.9], 'champagne'),
      patch([0.39, 0.62, 0.52, 0.44, 0.74, 0.2, 0.69, 0.52], 'cobalt')
    ],
    ellipses: [],
    rects: [],
    paths: [
      path([0.2, 0.9, 0.34, 0.72, 0.47, 0.55, 0.59, 0.38, 0.74, 0.12], 'primary', { tension: 0.36 }),
      path([0.12, 0.88, 0.45, 0.88, 0.82, 0.88], 'construction', { dashed: true }),
      path([0.17, 0.19, 0.43, 0.18, 0.78, 0.18], 'construction', { dashed: true }),
      ...leaves.map(([baseX, baseY, sideX, sideY, tipX, tipY, oppositeX, oppositeY]) => path(
        [baseX, baseY, sideX, sideY, tipX, tipY, oppositeX, oppositeY],
        'secondary',
        { closed: true, tension: 0.28 }
      )),
      ...leaves.map(([baseX, baseY, , , tipX, tipY]) => path([baseX, baseY, tipX, tipY], 'hatch')),
      path([0.78, 0.08, 0.84, 0.18, 0.85, 0.34], 'light', { tension: 0.42 })
    ]
  }
}

function architectureRecipe(): SemanticSketchRecipe {
  return {
    kind: 'architecture',
    patches: [
      patch([0.13, 0.79, 0.13, 0.38, 0.42, 0.18, 0.69, 0.33, 0.69, 0.79], 'graphite'),
      patch([0.69, 0.33, 0.9, 0.23, 0.9, 0.79, 0.69, 0.79], 'cobalt')
    ],
    paths: [
      path([0.1, 0.82, 0.1, 0.38, 0.42, 0.15, 0.7, 0.31, 0.91, 0.2, 0.91, 0.82], 'primary'),
      path([0.08, 0.82, 0.93, 0.82], 'construction'),
      path([0.06, 0.34, 0.95, 0.34], 'construction', { dashed: true }),
      path([0.5, 0.08, 0.5, 0.9], 'construction', { dashed: true }),
      ...[0.2, 0.31, 0.42, 0.53, 0.64, 0.75].map((x) => path([x, 0.37, x, 0.79], 'secondary')),
      ...[0.48, 0.59, 0.7].map((y) => path([0.14, y, 0.67, y], 'secondary')),
      ...[0.54, 0.61, 0.68, 0.75].map((y) => path([0.7, y, 0.9, y - 0.1], 'hatch')),
      path([0.08, 0.28, 0.26, 0.18, 0.45, 0.08], 'light', { tension: 0.25 })
    ],
    ellipses: [],
    rects: [rect(0.39, 0.56, 0.17, 0.26, 'primary'), rect(0.18, 0.43, 0.13, 0.1, 'secondary')]
  }
}

function abstractRecipe(): SemanticSketchRecipe {
  return {
    kind: 'abstract',
    patches: [
      patch([0.08, 0.25, 0.52, 0.1, 0.45, 0.52, 0.18, 0.7], 'iris'),
      patch([0.48, 0.34, 0.86, 0.2, 0.91, 0.62, 0.6, 0.82], 'cobalt'),
      patch([0.18, 0.66, 0.5, 0.56, 0.7, 0.9, 0.29, 0.87], 'champagne')
    ],
    paths: [
      path([0.08, 0.25, 0.52, 0.1, 0.45, 0.52, 0.18, 0.7], 'primary', { closed: true }),
      path([0.1, 0.82, 0.31, 0.6, 0.58, 0.77, 0.91, 0.3], 'primary', { tension: 0.38 }),
      path([0.16, 0.18, 0.82, 0.18], 'construction', { dashed: true }),
      path([0.52, 0.08, 0.52, 0.91], 'construction', { dashed: true }),
      ...[0.54, 0.61, 0.68, 0.75].map((offset) => path([0.14, offset, 0.44, offset - 0.26], 'hatch')),
      path([0.71, 0.08, 0.84, 0.22, 0.9, 0.39], 'light', { tension: 0.4 })
    ],
    ellipses: [ellipse(0.69, 0.56, 0.21, 0.23, 'secondary', -12, true), ellipse(0.69, 0.56, 0.11, 0.12, 'construction')],
    rects: []
  }
}

function productRecipe(element: SemanticPlaceholder): SemanticSketchRecipe {
  const vessel = /香水|瓶|flacon|bottle/i.test(`${element.subject} ${element.generationNotes}`)
  if (vessel) {
    return {
      kind: 'product',
      patches: [patch([0.25, 0.32, 0.75, 0.32, 0.7, 0.78, 0.3, 0.78], 'cobalt')],
      paths: [
        path([0.28, 0.33, 0.3, 0.78, 0.7, 0.78, 0.72, 0.33], 'primary'),
        path([0.34, 0.6, 0.48, 0.68, 0.68, 0.41], 'secondary', { tension: 0.4 }),
        path([0.14, 0.82, 0.86, 0.82], 'construction', { dashed: true }),
        ...[0.34, 0.41, 0.48, 0.55].map((x) => path([x, 0.35, x + 0.18, 0.76], 'hatch')),
        path([0.7, 0.08, 0.61, 0.23, 0.56, 0.42], 'light', { tension: 0.4 })
      ],
      ellipses: [ellipse(0.5, 0.8, 0.25, 0.045, 'secondary')],
      rects: [rect(0.39, 0.13, 0.22, 0.12, 'primary'), rect(0.43, 0.25, 0.14, 0.09, 'secondary')]
    }
  }
  return {
    kind: 'product',
    patches: [
      patch([0.18, 0.66, 0.35, 0.29, 0.61, 0.23, 0.78, 0.66], 'champagne'),
      patch([0.37, 0.58, 0.58, 0.34, 0.78, 0.47, 0.69, 0.73], 'cobalt')
    ],
    paths: [
      path([0.2, 0.66, 0.32, 0.32, 0.52, 0.23, 0.73, 0.42, 0.78, 0.66], 'primary', { tension: 0.28 }),
      path([0.16, 0.72, 0.84, 0.72], 'construction', { dashed: true }),
      path([0.5, 0.1, 0.5, 0.88], 'construction', { dashed: true }),
      ...[0.26, 0.34, 0.42, 0.5].map((y) => path([0.31, y + 0.18, 0.63, y], 'hatch')),
      path([0.78, 0.1, 0.69, 0.24, 0.62, 0.42], 'light', { tension: 0.38 })
    ],
    ellipses: [ellipse(0.31, 0.61, 0.17, 0.2, 'secondary', -14, true), ellipse(0.65, 0.57, 0.15, 0.17, 'secondary', 12, true), ellipse(0.5, 0.72, 0.34, 0.055, 'secondary')],
    rects: []
  }
}

function portraitRecipe(): SemanticSketchRecipe {
  return {
    kind: 'portrait',
    patches: [patch([0.26, 0.82, 0.31, 0.5, 0.5, 0.42, 0.69, 0.51, 0.75, 0.82], 'iris')],
    paths: [
      path([0.21, 0.84, 0.27, 0.58, 0.42, 0.48, 0.5, 0.46, 0.59, 0.49, 0.73, 0.59, 0.79, 0.84], 'primary', { tension: 0.32 }),
      path([0.5, 0.17, 0.48, 0.3, 0.51, 0.45], 'construction', { dashed: true }),
      path([0.36, 0.3, 0.5, 0.33, 0.64, 0.3], 'secondary', { tension: 0.38 }),
      path([0.42, 0.39, 0.5, 0.41, 0.59, 0.38], 'secondary', { tension: 0.34 }),
      ...[0.57, 0.63, 0.69, 0.75].map((y) => path([0.25, y, 0.47, y - 0.1], 'hatch')),
      path([0.76, 0.1, 0.66, 0.23, 0.61, 0.38], 'light', { tension: 0.4 })
    ],
    ellipses: [ellipse(0.5, 0.3, 0.18, 0.2, 'primary')],
    rects: []
  }
}

function albumRecipe(): SemanticSketchRecipe {
  return {
    kind: 'album',
    patches: [patch([0.13, 0.14, 0.72, 0.14, 0.72, 0.78, 0.13, 0.78], 'graphite'), patch([0.5, 0.32, 0.91, 0.3, 0.88, 0.74, 0.52, 0.72], 'cobalt')],
    paths: [
      path([0.13, 0.14, 0.72, 0.14, 0.72, 0.78, 0.13, 0.78], 'primary', { closed: true }),
      path([0.08, 0.84, 0.92, 0.84], 'construction', { dashed: true }),
      path([0.21, 0.24, 0.58, 0.24], 'secondary'),
      ...[0.42, 0.49, 0.56, 0.63].map((x) => path([x, 0.34, x + 0.24, 0.73], 'hatch')),
      path([0.8, 0.11, 0.73, 0.27, 0.68, 0.43], 'light', { tension: 0.4 })
    ],
    ellipses: [ellipse(0.69, 0.52, 0.24, 0.24, 'primary', 0, true), ellipse(0.69, 0.52, 0.14, 0.14, 'secondary'), ellipse(0.69, 0.52, 0.035, 0.035, 'primary')],
    rects: []
  }
}

function coffeeRecipe(): SemanticSketchRecipe {
  return {
    kind: 'coffee',
    patches: [patch([0.24, 0.37, 0.72, 0.37, 0.68, 0.72, 0.29, 0.72], 'champagne')],
    paths: [
      path([0.25, 0.38, 0.29, 0.7, 0.68, 0.7, 0.72, 0.38], 'primary'),
      path([0.73, 0.45, 0.89, 0.43, 0.89, 0.61, 0.72, 0.6], 'secondary', { tension: 0.35 }),
      path([0.14, 0.78, 0.87, 0.78], 'construction', { dashed: true }),
      path([0.42, 0.36, 0.37, 0.25, 0.5, 0.14, 0.45, 0.04], 'light', { tension: 0.48 }),
      path([0.57, 0.36, 0.53, 0.25, 0.64, 0.16, 0.61, 0.07], 'light', { tension: 0.48 }),
      ...[0.34, 0.42, 0.5, 0.58].map((x) => path([x, 0.43, x + 0.17, 0.68], 'hatch'))
    ],
    ellipses: [ellipse(0.49, 0.38, 0.24, 0.075, 'primary', 0, true), ellipse(0.49, 0.73, 0.31, 0.065, 'secondary')],
    rects: []
  }
}

function landscapeRecipe(): SemanticSketchRecipe {
  return {
    kind: 'landscape',
    patches: [patch([0, 0.72, 0.21, 0.46, 0.38, 0.6, 0.56, 0.32, 0.74, 0.57, 1, 0.4, 1, 1, 0, 1], 'cobalt')],
    paths: [
      path([0, 0.72, 0.21, 0.46, 0.38, 0.6, 0.56, 0.32, 0.74, 0.57, 1, 0.4], 'primary', { tension: 0.18 }),
      path([0.05, 0.3, 0.95, 0.3], 'construction', { dashed: true }),
      ...[0.74, 0.82, 0.9].map((y) => path([0.07, y, 0.34, y - 0.02, 0.62, y + 0.01, 0.94, y - 0.015], 'secondary', { tension: 0.35 })),
      ...[0.18, 0.27, 0.36, 0.45].map((x) => path([x, 0.7, x + 0.25, 0.94], 'hatch')),
      path([0.78, 0.05, 0.7, 0.17, 0.64, 0.31], 'light', { tension: 0.38 })
    ],
    ellipses: [ellipse(0.78, 0.18, 0.1, 0.1, 'light')],
    rects: []
  }
}

export function createSemanticSketchRecipe(element: SemanticPlaceholder): SemanticSketchRecipe | null {
  const kind = element.visualKind ?? 'generic'
  if (kind === 'botanical') return botanicalRecipe()
  if (kind === 'architecture') return architectureRecipe()
  if (kind === 'abstract') return abstractRecipe()
  if (kind === 'product') return productRecipe(element)
  if (kind === 'portrait') return portraitRecipe()
  if (kind === 'album') return albumRecipe()
  if (kind === 'coffee') return coffeeRecipe()
  if (kind === 'landscape') return landscapeRecipe()
  return null
}
