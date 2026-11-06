import type Konva from 'konva'
import { useLayoutEffect, useRef } from 'react'
import { Group, Image as KonvaImage, Layer, Rect, Stage } from 'react-konva'
import type { SceneElement } from '../../../domain'
import { ElementVisual } from './element-visual'
import { drawRect, renderImageEffects } from './image-effects'

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
  readonly maskAlpha: HTMLCanvasElement | null
}

export function ArtworkStage({ width, height, background, outputScale, draws, clip, onDrawn }: {
  readonly width: number
  readonly height: number
  readonly background: string | null
  readonly outputScale: number
  readonly draws: readonly LayerDraw[]
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
          {draws.map((draw) => <ArtworkLayer key={draw.element.id} draw={draw} outputScale={outputScale} />)}
        </Group>
      </Layer>
    </Stage>
  )
}

function ArtworkLayer({ draw, outputScale }: { readonly draw: LayerDraw; readonly outputScale: number }): React.JSX.Element {
  // A text or shape mask covers the box: drawn alone, it is the box in white, through the mask.
  const visual = draw.maskOnly && draw.element.type !== 'image' ? <Rect width={draw.width} height={draw.height} fill="#FFFFFF" /> : (
    <ElementVisual
      element={draw.element}
      width={draw.width}
      height={draw.height}
      outputScale={outputScale}
      textEffects={draw.textEffects}
      renderImage={(element, width, height) => <ArtworkImage element={element} source={draw.image!} width={width} height={height} />}
    />
  )
  return (
    <Group x={draw.x} y={draw.y} width={draw.width} height={draw.height} rotation={draw.element.transform.rotation} opacity={draw.opacity} globalCompositeOperation={draw.operation}>
      {draw.maskAlpha === null ? visual : <ArtworkMaskedBox alpha={draw.maskAlpha} width={draw.width} height={draw.height}>{visual}</ArtworkMaskedBox>}
    </Group>
  )
}

/** The image in its box with its effects, as the canvas draws it, at the size it is exported. */
function ArtworkImage({ element, source, width, height }: { readonly element: ImageElement; readonly source: HTMLImageElement | HTMLCanvasElement; readonly width: number; readonly height: number }): React.JSX.Element {
  const effected = renderImageEffects(source, element, width, height)
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
