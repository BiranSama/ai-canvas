import { Ellipse, Group, Line, Rect } from 'react-konva'
import type { SceneElement } from '../../../domain'
import {
  createSemanticSketchRecipe,
  type NormalizedSketchPath,
  type SketchPatchTone,
  type SketchStrokeRole
} from './semantic-sketch'

const STROKE: Record<SketchStrokeRole, string> = {
  primary: 'rgba(67, 88, 111, 0.82)',
  secondary: 'rgba(91, 119, 148, 0.62)',
  construction: 'rgba(89, 112, 138, 0.32)',
  hatch: 'rgba(82, 103, 128, 0.28)',
  light: 'rgba(224, 197, 147, 0.72)'
}

const PATCH: Record<SketchPatchTone, string> = {
  cobalt: 'rgba(55, 107, 255, 0.105)',
  iris: 'rgba(146, 118, 255, 0.09)',
  champagne: 'rgba(234, 217, 184, 0.18)',
  graphite: 'rgba(69, 84, 102, 0.08)'
}

function scalePoints(points: readonly number[], width: number, height: number): number[] {
  return points.map((value, index) => value * (index % 2 === 0 ? width : height))
}

function strokeWidth(role: SketchStrokeRole, unit: number): number {
  if (role === 'primary') return Math.max(1.25, unit * 0.52)
  if (role === 'secondary' || role === 'light') return Math.max(1, unit * 0.34)
  return Math.max(0.75, unit * 0.22)
}

function SketchPath({ item, width, height, unit, index }: {
  readonly item: NormalizedSketchPath
  readonly width: number
  readonly height: number
  readonly unit: number
  readonly index: number
}): React.JSX.Element {
  const points = scalePoints(item.points, width, height)
  const lineWidth = strokeWidth(item.role, unit)
  const dash = item.dashed ? [Math.max(3, unit * 1.3), Math.max(3, unit)] : undefined
  return (
    <Group>
      <Line
        points={points}
        closed={item.closed ?? false}
        tension={item.tension ?? 0}
        stroke={STROKE[item.role]}
        strokeWidth={lineWidth}
        dash={dash ?? []}
        lineCap="round"
        lineJoin="round"
      />
      {item.role === 'primary' && (
        <Line
          x={(index % 2 === 0 ? 1 : -1) * Math.max(.45, unit * .1)}
          y={(index % 3 === 0 ? -1 : 1) * Math.max(.35, unit * .08)}
          points={points}
          closed={item.closed ?? false}
          tension={item.tension ?? 0}
          stroke="rgba(129, 153, 178, 0.2)"
          strokeWidth={Math.max(.7, lineWidth * .64)}
          lineCap="round"
          lineJoin="round"
        />
      )}
    </Group>
  )
}

export function SemanticSketchVisual({ element, width, height }: {
  readonly element: Extract<SceneElement, { type: 'placeholder' }>
  readonly width: number
  readonly height: number
}): React.JSX.Element | null {
  const recipe = createSemanticSketchRecipe(element)
  if (recipe === null) return null
  const unit = Math.max(3, Math.min(width, height) * 0.035)
  return (
    <Group listening={false}>
      {recipe.patches.map((item, index) => (
        <Line key={`patch-${index}`} points={scalePoints(item.points, width, height)} closed fill={PATCH[item.tone]} stroke="rgba(255,255,255,.18)" strokeWidth={Math.max(.6, unit * .12)} lineJoin="round" />
      ))}
      {recipe.rects.map((item, index) => (
        <Rect
          key={`rect-${index}`}
          x={item.x * width}
          y={item.y * height}
          width={item.width * width}
          height={item.height * height}
          rotation={item.rotation ?? 0}
          fill={item.filled ? 'rgba(121, 151, 181, 0.07)' : 'rgba(0,0,0,0)'}
          stroke={STROKE[item.role]}
          strokeWidth={strokeWidth(item.role, unit)}
          dash={item.role === 'construction' ? [unit, unit] : []}
        />
      ))}
      {recipe.ellipses.map((item, index) => (
        <Ellipse
          key={`ellipse-${index}`}
          x={item.x * width}
          y={item.y * height}
          radiusX={item.radiusX * width}
          radiusY={item.radiusY * height}
          rotation={item.rotation ?? 0}
          fill={item.filled ? 'rgba(137, 163, 188, 0.055)' : 'rgba(0,0,0,0)'}
          stroke={STROKE[item.role]}
          strokeWidth={strokeWidth(item.role, unit)}
          dash={item.role === 'construction' ? [unit, unit] : []}
        />
      ))}
      {recipe.paths.map((item, index) => <SketchPath key={`path-${index}`} item={item} width={width} height={height} unit={unit} index={index} />)}
    </Group>
  )
}
