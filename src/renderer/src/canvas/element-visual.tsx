import { Circle, Ellipse, Group, Label, Line, Path, Rect, Tag, Text } from 'react-konva'
import { pathInBox, type SceneElement } from '../../../domain'
import { SemanticSketchVisual } from './SemanticSketchVisual'
import { TEXT_SHADOW_OPACITY, textMetrics, textWrap } from './layer-drawing'

/*
 * How each kind of layer is drawn, shared by the canvas and by exports, so
 * what is exported is what the canvas shows. Sizes come in the box's own
 * units; outputScale turns the scene's output pixels (font size, stroke,
 * shadow, letter spacing) into them.
 */

function PlaceholderVisual({ element, width, height }: { element: Extract<SceneElement, { type: 'placeholder' }>; width: number; height: number }): React.JSX.Element {
  const inset = Math.max(3, Math.min(width, height) * 0.035)
  const corner = Math.max(10, Math.min(width, height) * 0.12)
  const outline = { fill: 'rgba(229, 236, 243, 0.16)', stroke: 'rgba(139, 166, 197, 0.78)', strokeWidth: Math.max(1.5, inset * 0.52), dash: [inset * 2.2, inset * 1.65] }
  const visualKind = element.visualKind ?? 'generic'
  const usesGenericFrame = visualKind === 'generic' || visualKind === 'portrait'
  return (
    <Group>
      {usesGenericFrame && element.frameShape === 'rectangle' && <Rect width={width} height={height} cornerRadius={Math.min(width, height) * 0.055} {...outline} />}
      {usesGenericFrame && element.frameShape === 'ellipse' && <Ellipse x={width / 2} y={height / 2} radiusX={width / 2} radiusY={height / 2} {...outline} />}
      {usesGenericFrame && element.frameShape === 'free' && <Line closed tension={0.16} points={[width * 0.08, height * 0.18, width * 0.54, height * 0.04, width * 0.92, height * 0.28, width * 0.78, height * 0.88, width * 0.22, height * 0.94, width * 0.03, height * 0.58]} {...outline} />}
      {usesGenericFrame && element.frameShape === 'portrait' && <Group><Circle x={width * 0.5} y={height * 0.3} radius={Math.min(width, height) * 0.17} {...outline} /><Line closed tension={0.35} points={[width * 0.18, height * 0.82, width * 0.25, height * 0.57, width * 0.5, height * 0.5, width * 0.75, height * 0.57, width * 0.82, height * 0.82]} {...outline} /></Group>}
      {usesGenericFrame && element.frameShape === 'rectangle' && [
        [inset * 2 + corner, inset * 2, inset * 2, inset * 2, inset * 2, inset * 2 + corner],
        [width - inset * 2 - corner, inset * 2, width - inset * 2, inset * 2, width - inset * 2, inset * 2 + corner],
        [inset * 2 + corner, height - inset * 2, inset * 2, height - inset * 2, inset * 2, height - inset * 2 - corner],
        [width - inset * 2 - corner, height - inset * 2, width - inset * 2, height - inset * 2, width - inset * 2, height - inset * 2 - corner]
      ].map((points, index) => (
        <Line
          key={index}
          points={points}
          stroke="rgba(205, 221, 237, 0.92)"
          strokeWidth={Math.max(1.5, inset * 0.5)}
          lineCap="round"
          lineJoin="round"
        />
      ))}
      {usesGenericFrame && element.frameShape === 'rectangle' && <Group>
        <Circle
          x={width / 2}
          y={height * 0.44}
          radius={Math.max(4, Math.min(width, height) * 0.035)}
          fill="rgba(216, 228, 240, 0.72)"
          stroke="rgba(112, 143, 179, 0.78)"
          strokeWidth={Math.max(1, inset * 0.36)}
        />
        <Line points={[width * 0.35, height * 0.44, width * 0.65, height * 0.44]} stroke="rgba(180, 202, 224, 0.58)" strokeWidth={Math.max(1, inset * 0.32)} dash={[inset * 1.2, inset]} />
        <Line points={[width * 0.5, height * 0.28, width * 0.5, height * 0.6]} stroke="rgba(180, 202, 224, 0.58)" strokeWidth={Math.max(1, inset * 0.32)} dash={[inset * 1.2, inset]} />
      </Group>}
      {usesGenericFrame && element.frameShape === 'ellipse' && <Group>
        {[0.39, 0.3, 0.2].map((scale) => (
          <Ellipse key={scale} x={width / 2} y={height * 0.46} radiusX={width * scale} radiusY={height * scale} stroke="rgba(188, 210, 231, 0.58)" strokeWidth={Math.max(1, inset * 0.28)} />
        ))}
        <Circle x={width / 2} y={height * 0.46} radius={Math.max(5, Math.min(width, height) * 0.075)} fill="rgba(218, 229, 240, 0.42)" stroke="rgba(133, 163, 197, 0.82)" strokeWidth={Math.max(1, inset * 0.34)} />
        <Line points={[width * 0.28, height * 0.25, width * 0.7, height * 0.66]} stroke="rgba(229, 239, 248, 0.46)" strokeWidth={Math.max(1, inset * 0.24)} lineCap="round" />
      </Group>}
      {usesGenericFrame && element.frameShape === 'portrait' && <Group>
        <Line points={[width * 0.38, height * 0.29, width * 0.47, height * 0.34, width * 0.57, height * 0.3]} stroke="rgba(210, 225, 239, 0.62)" strokeWidth={Math.max(1, inset * 0.28)} tension={0.4} lineCap="round" />
        <Line points={[width * 0.3, height * 0.7, width * 0.5, height * 0.61, width * 0.7, height * 0.7]} stroke="rgba(184, 207, 229, 0.58)" strokeWidth={Math.max(1, inset * 0.3)} tension={0.45} dash={[inset * 1.5, inset]} />
      </Group>}
      {usesGenericFrame && element.frameShape === 'free' && <Line points={[width * 0.15, height * 0.55, width * 0.3, height * 0.36, width * 0.46, height * 0.5, width * 0.61, height * 0.29, width * 0.82, height * 0.48]} stroke="rgba(198, 218, 236, 0.64)" strokeWidth={Math.max(1, inset * 0.3)} tension={0.46} dash={[inset * 1.4, inset * 0.9]} lineCap="round" />}
      {!usesGenericFrame && <SemanticSketchVisual element={element} width={width} height={height} />}
      <Label x={inset} y={inset} opacity={0.92}>
        <Tag fill="rgba(252, 253, 255, 0.82)" stroke="rgba(23, 32, 51, 0.09)" strokeWidth={1} cornerRadius={6} />
        <Text
          text={element.subject}
          fill="#3A4656"
          fontFamily="Segoe UI Variable"
          fontSize={Math.max(9, Math.min(13, width * 0.045))}
          padding={5}
        />
      </Label>
    </Group>
  )
}

export function ElementVisual({ element, width, height, outputScale, renderImage, textEffects = true }: {
  element: SceneElement
  width: number
  height: number
  outputScale: number
  /** Images are drawn by whoever shows them: the canvas from its live pixel layers, an export from its own copy. */
  renderImage(element: Extract<SceneElement, { type: 'image' }>, width: number, height: number): React.JSX.Element
  /** False draws text without its stroke and shadow, for a PSD that adds them back as layer styles. */
  textEffects?: boolean
}): React.JSX.Element | null {
  switch (element.type) {
    case 'image':
      return renderImage(element, width, height)
    case 'text': {
      const metrics = textMetrics(element, width, height, outputScale)
      return (
        <Text
          width={width}
          height={height}
          text={element.orientation === 'vertical' ? [...element.content].join('\n') : element.content}
          align={element.align === 'start' ? 'left' : element.align === 'end' ? 'right' : element.align}
          verticalAlign="middle"
          fill={element.fill}
          {...(element.stroke === null || !textEffects ? {} : { stroke: element.stroke })}
          strokeWidth={metrics.strokeWidth}
          {...(element.shadowColor === null || !textEffects ? {} : {
            shadowColor: element.shadowColor,
            shadowBlur: metrics.shadowBlur,
            shadowOpacity: TEXT_SHADOW_OPACITY
          })}
          fontFamily={element.fontFamily}
          fontSize={metrics.fontSize}
          fontStyle={String(element.fontWeight)}
          letterSpacing={metrics.letterSpacing}
          lineHeight={element.lineHeight}
          wrap={textWrap(element)}
          ellipsis={element.orientation !== 'vertical'}
        />
      )
    }
    case 'sketch':
      return (
        <Group>
          {element.strokes.map((stroke) => (
            <Line
              key={stroke.id}
              points={stroke.points.flatMap((point) => [point.x * width, point.y * height])}
              stroke={stroke.color}
              strokeWidth={Math.max(1, stroke.width * Math.min(width, height))}
              opacity={stroke.opacity}
              lineCap="round"
              lineJoin="round"
              tension={0.18}
            />
          ))}
        </Group>
      )
    case 'shape':
      if (element.shape === 'path' && element.path !== undefined) {
        return <Path data={pathInBox(element.path, width, height)} fill={element.fill} {...(element.stroke === null ? {} : { stroke: element.stroke })} strokeWidth={element.strokeWidth * Math.min(width, height)} lineJoin="round" lineCap="round" />
      }
      if (element.shape === 'ellipse') {
        return <Ellipse x={width / 2} y={height / 2} radiusX={width / 2} radiusY={height / 2} fill={element.fill} {...(element.stroke === null ? {} : { stroke: element.stroke })} strokeWidth={element.strokeWidth * Math.min(width, height)} />
      }
      if (element.shape === 'line') {
        return <Line points={[0, height / 2, width, height / 2]} stroke={element.stroke ?? element.fill} strokeWidth={Math.max(1, element.strokeWidth * Math.min(width, height))} />
      }
      return <Rect width={width} height={height} fill={element.fill} {...(element.stroke === null ? {} : { stroke: element.stroke })} strokeWidth={element.strokeWidth * Math.min(width, height)} cornerRadius={Math.min(width, height) * element.cornerRadius} />
    case 'placeholder':
      return <PlaceholderVisual element={element} width={width} height={height} />
    case 'light':
      return (
        <Ellipse
          x={width / 2}
          y={height / 2}
          radiusX={width * 0.4}
          radiusY={height * 0.4}
          fill={element.color}
          opacity={element.intensity * 0.24}
          shadowColor={element.color}
          shadowBlur={Math.min(width, height) * element.softness * 0.55}
          shadowOpacity={element.intensity * 0.8}
        />
      )
    case 'mask': {
      const path = element.paths[0]
      if (path === undefined) return null
      const color = element.mode === 'protect' ? '#5AA9FF' : element.mode === 'generate' ? '#7DCB9C' : '#FF7C72'
      return (
        <Line
          points={path.points.flatMap((point) => [point.x * width, point.y * height])}
          closed={path.closed}
          fill={`${color}42`}
          stroke={color}
          strokeWidth={2}
          dash={[7, 5]}
        />
      )
    }
    case 'group':
      // An adjustment layer has nothing of its own to draw; the stage applies it to what is below.
    case 'adjustment':
      return null
  }
}
