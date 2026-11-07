import type Konva from 'konva'
import { useLayoutEffect, useRef } from 'react'
import { Group, Image as KonvaImage, Layer, Rect, Stage } from 'react-konva'
import type { SceneElement } from '../../../domain'
import { resolveBlendMode } from '../../../shared/blend-mode'
import { hasLayerStyles } from '../../../shared/layer-styles'
import { StyledLayer } from './styled-layer'
import { IsolatedGroup } from './clip-stack'
import { opaqueWhereCovered } from './opaque-filter'
import { ElementVisual } from './element-visual'
import { AdjustmentBackdrop, type AdjustmentCoverage } from './adjustment-layer'
import { drawRect, renderImageEffects, type AdjustmentClips, type LaterMask } from './image-effects'

/*
 * The stage an export is drawn on, away from the screen: each layer in its
 * box, through the canvas's own drawing, from pixels prepared for it.
 */

type ImageElement = Extract<SceneElement, { type: 'image' }>

export interface LayerDraw {
  readonly element: SceneElement
  /** Draw the mask alone, white where it shows the layer, instead of the layer. */
  readonly maskOnly: boolean
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly opacity: number
  readonly operation: GlobalCompositeOperation
  readonly textEffects: boolean
  readonly image: HTMLImageElement | HTMLCanvasElement | null
  /** The selections an image layer's adjustments were made in. */
  readonly adjustmentClips: AdjustmentClips | null
  /** An image layer's mask that goes on after its filters, rather than into its source. */
  readonly laterMask: LaterMask | null
  readonly maskAlpha: HTMLCanvasElement | null
  /** An adjustment layer's mask over the whole picture. */
  readonly adjustmentMask: AdjustmentCoverage | null
}

/** A layer to draw, or a clipping stack: a base and the layers clipped to it, drawn together. */
export type ArtworkItem =
  | { readonly kind: 'layer'; readonly draw: LayerDraw }
  | { readonly kind: 'stack'; readonly base: LayerDraw; readonly members: readonly LayerDraw[] }

export function ArtworkStage({ width, height, background, outputScale, items, clip, onDrawn }: {
  readonly width: number
  readonly height: number
  readonly background: string | null
  readonly outputScale: number
  readonly items: readonly ArtworkItem[]
  /** Cut at the picture's edges, as the canvas shows it; a layer drawn for a PSD keeps what lies past them. */
  readonly clip: boolean
  onDrawn(layer: Konva.Layer): void
}): React.JSX.Element {
  const layerRef = useRef<Konva.Layer>(null)
  // Runs after every layer's own layout effect, so masked boxes are cached by now.
  useLayoutEffect(() => {
    if (layerRef.current !== null) onDrawn(layerRef.current)
  })
  return (
    <Stage width={1} height={1} listening={false}>
      <Layer ref={layerRef} listening={false}>
        <Group {...(clip ? { clipX: 0, clipY: 0, clipWidth: width, clipHeight: height } : {})}>
          {background !== null && <Rect width={width} height={height} fill={background} />}
          {items.map((item) => item.kind === 'layer'
            ? <ArtworkLayer key={item.draw.element.id} draw={item.draw} outputScale={outputScale} />
            : <ArtworkClipStack key={item.base.element.id} base={item.base} members={item.members} outputScale={outputScale} maxPixels={Math.max(16_000_000, width * height * 2)} />)}
        </Group>
      </Layer>
    </Stage>
  )
}

/**
 * A clipping stack: the base at full strength, each clipped layer cut to
 * the base's content and laid over in its own mode, keeping the base's
 * coverage, the whole laid over the picture with the base's opacity and
 * mode, as Main draws it.
 */
function ArtworkClipStack({ base, members, outputScale, maxPixels }: { readonly base: LayerDraw; readonly members: readonly LayerDraw[]; readonly outputScale: number; readonly maxPixels: number }): React.JSX.Element {
  const plainBase: LayerDraw = { ...base, opacity: 1, operation: 'source-over' }
  // What clips is the base's own content, not its shadow, glow or stroke.
  const shape: LayerDraw = { ...plainBase, element: { ...base.element, style: undefined } as SceneElement }
  // Worked out over the base made opaque where it is, then cut back to its coverage, so the clipped layers keep its transparency.
  return (
    <IsolatedGroup operation={base.operation} opacity={base.opacity} pixelRatio={1} maxPixels={maxPixels}>
      <IsolatedGroup operation="source-over" filters={[opaqueWhereCovered]} pixelRatio={1} maxPixels={maxPixels}><ArtworkLayer draw={plainBase} outputScale={outputScale} /></IsolatedGroup>
      {members.map((member) => member.element.type === 'adjustment'
        ? <ArtworkLayer key={member.element.id} draw={member} outputScale={outputScale} />
        : (
          <IsolatedGroup key={member.element.id} operation={member.operation} pixelRatio={1} maxPixels={maxPixels}>
            <ArtworkLayer draw={{ ...member, operation: 'source-over' }} outputScale={outputScale} />
            <IsolatedGroup operation="destination-in" coverParent filters={[opaqueWhereCovered]} pixelRatio={1} maxPixels={maxPixels}><ArtworkLayer draw={shape} outputScale={outputScale} /></IsolatedGroup>
          </IsolatedGroup>
        ))}
      <IsolatedGroup operation="destination-in" coverParent pixelRatio={1} maxPixels={maxPixels}><ArtworkLayer draw={plainBase} outputScale={outputScale} /></IsolatedGroup>
    </IsolatedGroup>
  )
}

function ArtworkLayer({ draw, outputScale }: { readonly draw: LayerDraw; readonly outputScale: number }): React.JSX.Element {
  if (draw.element.type === 'adjustment') {
    return <AdjustmentBackdrop width={draw.width} height={draw.height} settings={draw.element.settings} opacity={draw.element.opacity} blend={resolveBlendMode(draw.element)} mask={draw.adjustmentMask} />
  }
  // A text or shape mask covers the box: drawn alone, it is the box in white, through the mask.
  const visual = draw.maskOnly && draw.element.type !== 'image' ? <Rect width={draw.width} height={draw.height} fill="#FFFFFF" /> : (
    <ElementVisual
      element={draw.element}
      width={draw.width}
      height={draw.height}
      outputScale={outputScale}
      textEffects={draw.textEffects}
      renderImage={(element, width, height) => <ArtworkImage element={element} source={draw.image!} clips={draw.adjustmentClips} laterMask={draw.laterMask} scale={outputScale} width={width} height={height} />}
    />
  )
  const masked = draw.maskAlpha === null ? visual : <ArtworkMaskedBox alpha={draw.maskAlpha} width={draw.width} height={draw.height}>{visual}</ArtworkMaskedBox>
  const element = draw.element
  const styled = !draw.maskOnly && (element.type === 'image' || element.type === 'text' || element.type === 'shape') && hasLayerStyles(element.style)
  return (
    // A styled layer blends its content itself, so its shadow and glow keep their own modes.
    <Group x={draw.x} y={draw.y} width={draw.width} height={draw.height} rotation={element.transform.rotation} opacity={draw.opacity} globalCompositeOperation={styled ? 'source-over' : draw.operation}>
      {!styled ? masked : (
        <StyledLayer element={element as Extract<SceneElement, { type: 'image' | 'text' | 'shape' }>} width={draw.width} height={draw.height} unit={outputScale} ratio={1}
          rotation={element.transform.rotation} blend={draw.operation === 'source-over' ? 'normal' : resolveBlendMode(element)} contentKey={draw}>
          {masked}
        </StyledLayer>
      )}
    </Group>
  )
}

/** The image in its box with its effects, as the canvas draws it, at the size it is exported. */
function ArtworkImage({ element, source, clips, laterMask, scale, width, height }: {
  readonly element: ImageElement
  readonly source: HTMLImageElement | HTMLCanvasElement
  readonly clips: AdjustmentClips | null
  readonly laterMask: LaterMask | null
  /** Drawn pixels per output pixel. */
  readonly scale: number
  readonly width: number
  readonly height: number
}): React.JSX.Element {
  const effected = renderImageEffects(source, element, width, height, clips, 0, scale, laterMask)
  if (effected !== null) {
    const scaleX = width / effected.drawn.width
    const scaleY = height / effected.drawn.height
    return (
      <Group>
        {effected.shadow !== null && <KonvaImage image={effected.shadow.canvas} x={effected.shadow.x * scaleX} y={effected.shadow.y * scaleY} scaleX={scaleX} scaleY={scaleY} />}
        <KonvaImage image={effected.drawn} width={width} height={height} />
      </Group>
    )
  }
  const sourceSize = source instanceof HTMLImageElement ? { width: source.naturalWidth, height: source.naturalHeight } : { width: source.width, height: source.height }
  const { crop, draw } = drawRect(sourceSize, element, width, height)
  return (
    <Group clipX={0} clipY={0} clipWidth={width} clipHeight={height}>
      <KonvaImage image={source} x={draw.x} y={draw.y} width={draw.width} height={draw.height} cropX={crop.x} cropY={crop.y} cropWidth={crop.width} cropHeight={crop.height} />
    </Group>
  )
}

/** A text or shape layer through its mask: the group cached at export size and the mask cut in, as the canvas does. */
function ArtworkMaskedBox({ alpha, width, height, children }: { readonly alpha: HTMLCanvasElement; readonly width: number; readonly height: number; readonly children: React.ReactNode }): React.JSX.Element {
  const groupRef = useRef<Konva.Group>(null)
  useLayoutEffect(() => {
    const group = groupRef.current
    if (group === null) return
    group.clearCache()
    group.cache({ pixelRatio: 1 })
  })
  return (
    <Group ref={groupRef}>
      {children}
      <KonvaImage image={alpha} width={width} height={height} globalCompositeOperation="destination-in" />
    </Group>
  )
}
