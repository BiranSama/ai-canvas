import type Konva from 'konva'
import type { KonvaEventObject } from 'konva/lib/Node'
import { AlignCenterHorizontal, AlignCenterVertical, Check, Circle as CircleIcon, Copy, Crop, Group as GroupIcon, Lock, Minus, Square, Trash2, Type as TypeIcon, Ungroup } from 'lucide-react'
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from 'react'
import {
  Circle,
  Ellipse,
  Group,
  Image as KonvaImage,
  Label,
  Layer,
  Line,
  Rect,
  Stage,
  Tag,
  Text,
  Transformer
} from 'react-konva'
import { ELEMENT_SCHEMA_VERSION, type Scene, type SceneCommand, type SceneElement } from '../../../domain'
import type { EphemeralAnnotationRegion } from '../../../shared/agent'
import { blendModeLabel, blendModeToCanvasOperation, resolveBlendMode } from '../../../shared/blend-mode'
import {
  getRuntimeAssetUrl,
  getRuntimeAssetVersion,
  isRuntimeAssetLoading,
  isRuntimeAssetMissing,
  subscribeRuntimeAssets
} from '../assets/runtime-assets'
import type { EphemeralAnnotationTool } from '../agent/ephemeral-annotation-store'
import { activeModal, canvasKeyboardBlocked, isInteractiveTarget, MODAL_SCOPE_CHANGED } from '../interaction/keyboard-scope'
import { islandFitInsets } from '../islands/island-layout'
import { useIslandLayoutStore } from '../islands/island-layout-store'
import { groupBoundsForChildTransforms, useWorkspaceStore } from '../store/workspace-store'
import { ImeSafeTextarea } from '../components/ImeSafeTextField'
import { useCanvasViewportStore } from './canvas-viewport-store'
import {
  boundsForElements,
  clampCrop,
  clampPan,
  lineEndpointsForTransform,
  lineTransformFromStageEndpoints,
  rectContainsPoint,
  rectFromPoints,
  rectsIntersect,
  shapeEditAnchors,
  shapeEditToolbarPosition,
  rotatedElementBounds,
  snapRect,
  type CanvasPoint,
  type CanvasRect,
  type SnapGuide
} from './direct-canvas-geometry'
import { SemanticSketchVisual } from './SemanticSketchVisual'

interface Size {
  width: number
  height: number
}

function canvasSupportsBlendMode(blendMode: ReturnType<typeof resolveBlendMode>): boolean {
  if (blendMode === 'normal') return true
  const context = document.createElement('canvas').getContext('2d')
  if (context === null) return false
  const operation = blendModeToCanvasOperation(blendMode)
  context.globalCompositeOperation = 'source-over'
  context.globalCompositeOperation = operation
  return context.globalCompositeOperation === operation
}

type Guide = SnapGuide

export interface CanvasStageHandle {
  exportDataUrl(format: 'png' | 'jpeg' | 'webp', jpegBackground?: string): string | null
  viewFit(): void
  viewActualSize(): void
  viewScalePercentage(percentage: number): void
  zoomBy(factor: number): void
}

function useContainerSize(container: React.RefObject<HTMLDivElement | null>): Size {
  const [size, setSize] = useState<Size>({ width: 900, height: 720 })

  useEffect(() => {
    const element = container.current
    if (element === null) return
    const update = (): void => {
      const rect = element.getBoundingClientRect()
      setSize({ width: Math.max(1, rect.width), height: Math.max(1, rect.height) })
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [container])

  return size
}

function useHtmlImage(url: string | null): HTMLImageElement | null {
  const [loaded, setLoaded] = useState<{ url: string; image: HTMLImageElement } | null>(null)
  useEffect(() => {
    if (url === null) return
    const next = new window.Image()
    next.onload = () => setLoaded({ url, image: next })
    next.src = url
    return () => {
      next.onload = null
    }
  }, [url])
  return loaded?.url === url ? loaded.image : null
}

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

function ImageVisual({ element, width, height }: { element: Extract<SceneElement, { type: 'image' }>; width: number; height: number }): React.JSX.Element {
  useSyncExternalStore(subscribeRuntimeAssets, getRuntimeAssetVersion, getRuntimeAssetVersion)
  const assetUrl = getRuntimeAssetUrl(element.assetId)
  const image = useHtmlImage(assetUrl)
  if (image === null) {
    const missing = isRuntimeAssetMissing(element.assetId)
    const loading = isRuntimeAssetLoading(element.assetId)
    const status = missing
      ? '图片素材无法读取 · 重新导入原文件'
      : loading
        ? '正在读取图片…'
        : assetUrl !== null
          ? '正在显示图片…'
          : '正在准备图片…'
    return (
      <Group>
        <Rect width={width} height={height} fill={missing ? '#E9E1DE' : '#DCE3EA'} cornerRadius={8} />
        <Text width={width} y={height / 2 - 8} align="center" text={status} fill={missing ? '#925F58' : '#6D7783'} fontSize={13} />
      </Group>
    )
  }
  const cropX = image.width * element.crop.x
  const cropY = image.height * element.crop.y
  const cropWidth = image.width * element.crop.width
  const cropHeight = image.height * element.crop.height
  const sourceRatio = cropWidth / cropHeight
  const targetRatio = width / height
  let drawWidth = width
  let drawHeight = height
  let x = 0
  let y = 0
  if (element.fit !== 'fill') {
    const contain = element.fit === 'contain'
    const useWidth = contain ? sourceRatio > targetRatio : sourceRatio < targetRatio
    if (useWidth) {
      drawHeight = width / sourceRatio
      y = (height - drawHeight) / 2
    } else {
      drawWidth = height * sourceRatio
      x = (width - drawWidth) / 2
    }
  }
  return (
    <Group clipX={0} clipY={0} clipWidth={width} clipHeight={height}>
      <KonvaImage
        image={image}
        x={x}
        y={y}
        width={drawWidth}
        height={drawHeight}
        cropX={cropX}
        cropY={cropY}
        cropWidth={cropWidth}
        cropHeight={cropHeight}
      />
    </Group>
  )
}

function ElementVisual({ element, width, height, outputScale }: { element: SceneElement; width: number; height: number; outputScale: number }): React.JSX.Element | null {
  switch (element.type) {
    case 'image':
      return <ImageVisual element={element} width={width} height={height} />
    case 'text':
      return (
        <Text
          width={width}
          height={height}
          text={element.orientation === 'vertical' ? [...element.content].join('\n') : element.content}
          align={element.align === 'start' ? 'left' : element.align === 'end' ? 'right' : element.align}
          verticalAlign="middle"
          fill={element.fill}
          {...(element.stroke === null ? {} : { stroke: element.stroke })}
          strokeWidth={element.strokeWidth * outputScale}
          {...(element.shadowColor === null ? {} : {
            shadowColor: element.shadowColor,
            shadowBlur: element.shadowBlur * outputScale,
            shadowOpacity: 0.62
          })}
          fontFamily={element.fontFamily}
          fontSize={Math.min(height * 0.95, Math.max(7, element.fontSize * outputScale))}
          fontStyle={String(element.fontWeight)}
          letterSpacing={Math.min(element.letterSpacing, width * 0.03)}
          lineHeight={element.lineHeight}
          wrap={element.orientation === 'vertical' ? 'char' : element.wrapping === 'none' ? 'none' : element.wrapping === 'character' ? 'char' : 'word'}
          ellipsis={element.orientation !== 'vertical'}
        />
      )
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
      return null
  }
}

interface ElementNodeProps {
  element: SceneElement
  artboard: { width: number; height: number }
  zoom: number
  onSelect(event: KonvaEventObject<MouseEvent | TouchEvent>): void
  onGuides(guides: Guide[]): void
  onBeginDrag(elementId: string): void
  onFinishDrag(elementId: string): void
  isDragCommitOwner(elementId: string): boolean
  isDragCancelled(): boolean
  onRequestEdit(element: SceneElement): void
  isInlineEditing: boolean
  viewportPanReady: boolean
  cropOverride?: Extract<SceneElement, { type: 'image' }>['crop'] | undefined
  shapeCornerRadiusOverride?: number | undefined
  shapeTransformOverride?: SceneElement['transform'] | undefined
  blendModeSupported: boolean
}

function isFinalContent(element: SceneElement): boolean {
  if (element.type === 'sketch') return element.finalVisible
  if (element.type === 'shape') return element.role === 'final'
  return element.type === 'image' || element.type === 'text'
}

function ElementNode({ element, artboard, zoom, onSelect, onGuides, onBeginDrag, onFinishDrag, isDragCommitOwner, isDragCancelled, onRequestEdit, isInlineEditing, viewportPanReady, cropOverride, shapeCornerRadiusOverride, shapeTransformOverride, blendModeSupported }: ElementNodeProps): React.JSX.Element | null {
  const updateElement = useWorkspaceStore((state) => state.updateElement)
  const execute = useWorkspaceStore((state) => state.execute)
  const scene = useWorkspaceStore((state) => state.scene)
  const select = useWorkspaceStore((state) => state.select)
  const selectedIds = useWorkspaceStore((state) => state.selectedIds)
  const editingGroupId = useWorkspaceStore((state) => state.editingGroupId)
  const activeTool = useWorkspaceStore((state) => state.activeTool)
  const enterGroupEditing = useWorkspaceStore((state) => state.enterGroupEditing)
  const dragOccurredRef = useRef(false)
  const displayTransform = shapeTransformOverride ?? element.transform
  const width = displayTransform.width * artboard.width
  const height = displayTransform.height * artboard.height
  if (element.type === 'group') {
    const isEditing = editingGroupId === element.id
    const children = scene.elements.filter((candidate) => element.childIds.includes(candidate.id))
    const commitGroupTransform = (node: Konva.Node): void => {
      const scaleX = node.scaleX()
      const scaleY = node.scaleY()
      const next = {
        x: node.x() / artboard.width,
        y: node.y() / artboard.height,
        width: Math.max(0.01, element.transform.width * scaleX),
        height: Math.max(0.01, element.transform.height * scaleY),
        rotation: node.rotation()
      }
      node.scaleX(1)
      node.scaleY(1)
      const deltaRotation = next.rotation - element.transform.rotation
      const oldAngle = element.transform.rotation * Math.PI / 180
      const nextAngle = next.rotation * Math.PI / 180
      const oldCenter = {
        x: element.transform.x + element.transform.width / 2,
        y: element.transform.y + element.transform.height / 2
      }
      const nextCenter = { x: next.x + next.width / 2, y: next.y + next.height / 2 }
      const commands = children.map((child) => {
        const childCenter = {
          x: child.transform.x + child.transform.width / 2,
          y: child.transform.y + child.transform.height / 2
        }
        const vector = { x: childCenter.x - oldCenter.x, y: childCenter.y - oldCenter.y }
        const local = {
          x: vector.x * Math.cos(-oldAngle) - vector.y * Math.sin(-oldAngle),
          y: vector.x * Math.sin(-oldAngle) + vector.y * Math.cos(-oldAngle)
        }
        const scaled = { x: local.x * scaleX, y: local.y * scaleY }
        const rotated = {
          x: scaled.x * Math.cos(nextAngle) - scaled.y * Math.sin(nextAngle),
          y: scaled.x * Math.sin(nextAngle) + scaled.y * Math.cos(nextAngle)
        }
        const childWidth = child.transform.width * scaleX
        const childHeight = child.transform.height * scaleY
        return {
          kind: 'element.update' as const,
          elementId: child.id,
          changes: {
            transform: {
              x: nextCenter.x + rotated.x - childWidth / 2,
              y: nextCenter.y + rotated.y - childHeight / 2,
              width: childWidth,
              height: childHeight,
              rotation: child.transform.rotation + deltaRotation
            }
          }
        }
      })
      execute(`变换组合“${element.name}”`, [
        { kind: 'element.update', elementId: element.id, changes: { transform: next } },
        ...commands
      ])
    }

    return (
      <Group
        id={`element-${element.id}`}
        name="editor-reference"
        x={element.transform.x * artboard.width}
        y={element.transform.y * artboard.height}
        width={width}
        height={height}
        rotation={element.transform.rotation}
        visible={element.visible}
        listening={!isEditing}
        draggable={!viewportPanReady && !isEditing && !element.locked && activeTool === 'select'}
        onMouseDown={() => { dragOccurredRef.current = false }}
        onMouseUp={(event) => { if (event.evt.altKey && !dragOccurredRef.current) onSelect(event) }}
        onClick={(event) => { if (!event.evt.altKey) onSelect(event) }}
        onTap={onSelect}
        onDblClick={(event) => {
          if (element.locked) return
          event.cancelBubble = true
          enterGroupEditing(element.id)
        }}
        onDragStart={() => {
          dragOccurredRef.current = true
          if (!selectedIds.includes(element.id)) select(element.id, false)
          onBeginDrag(element.id)
        }}
        onDragMove={(event) => {
          const deltaX = event.target.x() - element.transform.x * artboard.width
          const deltaY = event.target.y() - element.transform.y * artboard.height
          const stage = event.target.getStage()
          const movingRoots = selectedIds.includes(element.id)
            ? scene.elements.filter((candidate) => selectedIds.includes(candidate.id) && !candidate.locked)
            : [element]
          const movingIds = new Set(movingRoots.flatMap((candidate) => candidate.type === 'group' ? [candidate.id, ...candidate.childIds] : [candidate.id]))
          for (const movingId of movingIds) {
            if (movingId === element.id) continue
            const moving = scene.elements.find((candidate) => candidate.id === movingId)
            if (moving === undefined) continue
            stage?.findOne(`#element-${moving.id}`)?.position({
              x: moving.transform.x * artboard.width + deltaX,
              y: moving.transform.y * artboard.height + deltaY
            })
          }
        }}
        onDragEnd={(event) => {
          if (!isDragCommitOwner(element.id)) {
            onFinishDrag(element.id)
            return
          }
          if (isDragCancelled()) {
            for (const candidate of scene.elements) {
              event.target.getStage()?.findOne(`#element-${candidate.id}`)?.position({
                x: candidate.transform.x * artboard.width,
                y: candidate.transform.y * artboard.height
              })
            }
          } else if (selectedIds.includes(element.id) && selectedIds.length > 1) {
            const delta = {
              x: event.target.x() / artboard.width - element.transform.x,
              y: event.target.y() / artboard.height - element.transform.y
            }
            const movingRoots = scene.elements.filter((candidate) => selectedIds.includes(candidate.id) && !candidate.locked)
            const movingIds = new Set(movingRoots.flatMap((candidate) => candidate.type === 'group' ? [candidate.id, ...candidate.childIds] : [candidate.id]))
            void execute(`移动 ${movingRoots.length} 个元素`, [...movingIds].flatMap((id) => {
              const moving = scene.elements.find((candidate) => candidate.id === id)
              return moving === undefined ? [] : [{
                kind: 'element.update' as const,
                elementId: moving.id,
                changes: { transform: { ...moving.transform, x: moving.transform.x + delta.x, y: moving.transform.y + delta.y } }
              }]
            }))
          } else {
            commitGroupTransform(event.target)
          }
          onFinishDrag(element.id)
        }}
      >
        <Rect width={width} height={height} fill="rgba(0,0,0,0)" />
      </Group>
    )
  }

  return (
    <Group
      id={`element-${element.id}`}
      name={isFinalContent(element) ? 'final-content' : 'editor-reference'}
      x={displayTransform.x * artboard.width}
      y={displayTransform.y * artboard.height}
      width={width}
      height={height}
      rotation={displayTransform.rotation}
      opacity={element.opacity}
      globalCompositeOperation={blendModeToCanvasOperation(resolveBlendMode(element))}
      visible={element.visible && !isInlineEditing && blendModeSupported}
      draggable={!viewportPanReady && !element.locked && (element.groupId === null || element.groupId === editingGroupId) && activeTool === 'select'}
      onMouseDown={() => { dragOccurredRef.current = false }}
      onMouseUp={(event) => { if (event.evt.altKey && !dragOccurredRef.current) onSelect(event) }}
      onClick={(event) => { if (!event.evt.altKey) onSelect(event) }}
      onTap={onSelect}
      onDblClick={(event) => {
        if (element.type !== 'text' && element.type !== 'image' && element.type !== 'shape') return
        if (element.locked) return
        event.cancelBubble = true
        select(element.id, false)
        onRequestEdit(element)
      }}
      onDragStart={() => {
        dragOccurredRef.current = true
        if (!selectedIds.includes(element.id)) select(element.id, false)
        onBeginDrag(element.id)
      }}
      onDragMove={(event) => {
        const node = event.target
        if (event.evt.altKey) {
          onGuides([])
          return
        }
        const movableRoots = scene.elements.filter((candidate) =>
          (selectedIds.includes(element.id) ? selectedIds.includes(candidate.id) : candidate.id === element.id)
          && !candidate.locked
          && (candidate.type === 'group' || candidate.groupId === null || candidate.groupId === editingGroupId)
        )
        const movingElements = movableRoots.length > 0 ? movableRoots : [element]
        const selectedSet = new Set(movingElements.flatMap((candidate) => candidate.type === 'group' ? [candidate.id, ...candidate.childIds] : [candidate.id]))
        const delta = {
          x: node.x() - element.transform.x * artboard.width,
          y: node.y() - element.transform.y * artboard.height
        }
        const localArtboard: CanvasRect = { x: 0, y: 0, width: artboard.width, height: artboard.height }
        const baseBounds = boundsForElements(movingElements, localArtboard)
        if (baseBounds === null) return
        const movingBounds = { ...baseBounds, x: baseBounds.x + delta.x, y: baseBounds.y + delta.y }
        const peers = scene.elements.filter((candidate) =>
          candidate.visible
          && !selectedSet.has(candidate.id)
          && candidate.groupId === null
          && candidate.type !== 'mask'
        )
        const snap = snapRect(
          movingBounds,
          [localArtboard, ...peers.map((peer) => rotatedElementBounds(peer, localArtboard))],
          7 / Math.max(zoom, 0.01)
        )
        const finalDelta = { x: delta.x + snap.dx, y: delta.y + snap.dy }
        node.position({
          x: element.transform.x * artboard.width + finalDelta.x,
          y: element.transform.y * artboard.height + finalDelta.y
        })
        const stage = node.getStage()
        for (const movingId of selectedSet) {
          if (movingId === element.id) continue
          const selectedElement = scene.elements.find((candidate) => candidate.id === movingId)
          if (selectedElement === undefined) continue
          stage?.findOne(`#element-${movingId}`)?.position({
            x: selectedElement.transform.x * artboard.width + finalDelta.x,
            y: selectedElement.transform.y * artboard.height + finalDelta.y
          })
        }
        onGuides([...snap.guides])
      }}
      onDragEnd={(event) => {
        onGuides([])
        if (!isDragCommitOwner(element.id)) {
          onFinishDrag(element.id)
          return
        }
        if (isDragCancelled()) {
          const stage = event.target.getStage()
          const restoreIds = new Set(selectedIds)
          for (const selectedId of selectedIds) {
            const selected = scene.elements.find((candidate) => candidate.id === selectedId)
            if (selected?.type === 'group') selected.childIds.forEach((childId) => restoreIds.add(childId))
          }
          for (const selectedId of restoreIds) {
            const selectedElement = scene.elements.find((candidate) => candidate.id === selectedId)
            if (selectedElement === undefined) continue
            stage?.findOne(`#element-${selectedId}`)?.position({
              x: selectedElement.transform.x * artboard.width,
              y: selectedElement.transform.y * artboard.height
            })
          }
          onFinishDrag(element.id)
          return
        }
        const delta = {
          x: event.target.x() / artboard.width - element.transform.x,
          y: event.target.y() / artboard.height - element.transform.y
        }
        const movableRoots = scene.elements.filter((candidate) =>
          selectedIds.includes(candidate.id) && !candidate.locked && (candidate.type === 'group' || candidate.groupId === null || candidate.groupId === editingGroupId)
        )
        if (selectedIds.includes(element.id) && movableRoots.length > 1) {
          const movableIds = new Set(movableRoots.flatMap((candidate) => candidate.type === 'group' ? [candidate.id, ...candidate.childIds] : [candidate.id]))
          const movableSelection = scene.elements.filter((candidate) => movableIds.has(candidate.id))
          const transformOverrides = new Map(movableSelection.map((candidate) => [candidate.id, {
            ...candidate.transform,
            x: candidate.transform.x + delta.x,
            y: candidate.transform.y + delta.y
          }]))
          const commands: SceneCommand[] = movableSelection.map((candidate) => ({
            kind: 'element.update',
            elementId: candidate.id,
            changes: { transform: transformOverrides.get(candidate.id)! }
          }))
          const groupIds = new Set(movableSelection.map((candidate) => candidate.groupId).filter((groupId): groupId is string => groupId !== null))
          for (const groupId of groupIds) {
            const transform = groupBoundsForChildTransforms(scene, groupId, transformOverrides)
            if (transform !== null) commands.push({ kind: 'element.update', elementId: groupId, changes: { transform } })
          }
          execute(`移动 ${movableRoots.length} 个元素`, commands)
        } else {
          updateElement(element.id, {
            transform: {
              ...element.transform,
              x: element.transform.x + delta.x,
              y: element.transform.y + delta.y
            }
          }, `移动“${element.name}”`)
        }
        onFinishDrag(element.id)
      }}
    >
      <ElementVisual
        element={element.type === 'image' && cropOverride !== undefined
          ? { ...element, crop: cropOverride }
          : element.type === 'shape' && shapeCornerRadiusOverride !== undefined
            ? { ...element, cornerRadius: shapeCornerRadiusOverride }
            : element}
        width={width}
        height={height}
        outputScale={artboard.height / scene.canvas.outputHeight}
      />
    </Group>
  )
}

export interface CanvasStageProps {
  readonly onReady?: () => void
  readonly onScaleChange?: (percentage: number) => void
  readonly preview?: boolean
  readonly ephemeralAnnotationEnabled?: boolean
  readonly ephemeralAnnotationPoints?: readonly { readonly x: number; readonly y: number }[]
  readonly onEphemeralAnnotationChange?: (points: readonly { readonly x: number; readonly y: number }[]) => void
  readonly ephemeralAnnotationRegions?: readonly EphemeralAnnotationRegion[]
  readonly ephemeralAnnotationTool?: EphemeralAnnotationTool
  readonly ephemeralAnnotationMode?: EphemeralAnnotationRegion['mode']
  readonly onEphemeralAnnotationComplete?: (region: EphemeralAnnotationRegion) => void
  readonly onEphemeralAnnotationErase?: (regionId: string) => void
  readonly focusMode?: boolean
}

const ANNOTATION_COLORS: Readonly<Record<EphemeralAnnotationRegion['mode'], { readonly fill: string; readonly stroke: string }>> = {
  edit: { fill: 'rgba(255, 124, 114, .17)', stroke: '#FF7C72' },
  generate: { fill: 'rgba(100, 199, 154, .17)', stroke: '#64C79A' },
  protect: { fill: 'rgba(117, 168, 232, .17)', stroke: '#75A8E8' }
}

function pointInPolygon(point: { readonly x: number; readonly y: number }, polygon: readonly { readonly x: number; readonly y: number }[]): boolean {
  let inside = false
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const currentPoint = polygon[index]
    const previousPoint = polygon[previous]
    if (currentPoint === undefined || previousPoint === undefined) continue
    const intersects = currentPoint.y > point.y !== previousPoint.y > point.y &&
      point.x < (previousPoint.x - currentPoint.x) * (point.y - currentPoint.y) / (previousPoint.y - currentPoint.y || Number.EPSILON) + currentPoint.x
    if (intersects) inside = !inside
  }
  return inside
}

interface MarqueeState {
  readonly start: CanvasPoint
  readonly current: CanvasPoint
  readonly additive: boolean
}

interface CropSession {
  readonly elementId: string
  readonly original: Extract<SceneElement, { type: 'image' }>['crop']
  readonly draft: Extract<SceneElement, { type: 'image' }>['crop']
}

interface TransformSession {
  readonly scene: Scene
  readonly ids: readonly string[]
}

interface TransformHud {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly rotation: number | null
  readonly left: number
  readonly top: number
}

function rotateLocalPoint(origin: CanvasPoint, local: CanvasPoint, rotation: number): CanvasPoint {
  const angle = rotation * Math.PI / 180
  return {
    x: origin.x + local.x * Math.cos(angle) - local.y * Math.sin(angle),
    y: origin.y + local.x * Math.sin(angle) + local.y * Math.cos(angle)
  }
}

function unrotateStagePoint(origin: CanvasPoint, point: CanvasPoint, rotation: number): CanvasPoint {
  const angle = -rotation * Math.PI / 180
  const x = point.x - origin.x
  const y = point.y - origin.y
  return {
    x: x * Math.cos(angle) - y * Math.sin(angle),
    y: x * Math.sin(angle) + y * Math.cos(angle)
  }
}

function editableEventTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement
    || target instanceof HTMLTextAreaElement
    || target instanceof HTMLSelectElement
    || (target instanceof HTMLElement && target.isContentEditable)
}

export const CanvasStage = forwardRef<CanvasStageHandle, CanvasStageProps>(function CanvasStage({
  onReady,
  onScaleChange,
  preview = false,
  ephemeralAnnotationEnabled = false,
  ephemeralAnnotationPoints = [],
  onEphemeralAnnotationChange,
  ephemeralAnnotationRegions = [],
  ephemeralAnnotationTool = 'lasso',
  ephemeralAnnotationMode = 'edit',
  onEphemeralAnnotationComplete,
  onEphemeralAnnotationErase,
  focusMode = false
}, forwardedRef) {
  const containerRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<Konva.Stage>(null)
  const transformerRef = useRef<Konva.Transformer>(null)
  const auxiliaryLayerRef = useRef<Konva.Layer>(null)
  const [guides, setGuides] = useState<Guide[]>([])
  const [draftStroke, setDraftStroke] = useState<number[]>([])
  const [draftMask, setDraftMask] = useState<number[]>([])
  const [ephemeralDraft, setEphemeralDraft] = useState<readonly { readonly x: number; readonly y: number }[]>([])
  const [marquee, setMarquee] = useState<MarqueeState | null>(null)
  const [spacePressed, setSpacePressed] = useState(false)
  const [isPanning, setIsPanning] = useState(false)
  const [shiftPressed, setShiftPressed] = useState(false)
  const [altPressed, setAltPressed] = useState(false)
  const [inlineTextId, setInlineTextId] = useState<string | null>(null)
  const [shapeEditId, setShapeEditId] = useState<string | null>(null)
  const [shapeRadiusDraft, setShapeRadiusDraft] = useState<{ readonly elementId: string; readonly value: number } | null>(null)
  const [shapeLineDraft, setShapeLineDraft] = useState<{ readonly elementId: string; readonly transform: SceneElement['transform'] } | null>(null)
  const [cropSession, setCropSession] = useState<CropSession | null>(null)
  const [transformHud, setTransformHud] = useState<TransformHud | null>(null)
  const panningRef = useRef(false)
  const panPointerRef = useRef<{ x: number; y: number } | null>(null)
  const dragActiveRef = useRef(false)
  const dragCancelledRef = useRef(false)
  const dragCommitOwnerRef = useRef<string | null>(null)
  const cropDragRef = useRef<{ readonly pointer: CanvasPoint; readonly crop: CropSession['draft'] } | null>(null)
  const transformSessionRef = useRef<TransformSession | null>(null)
  const shapeRadiusGestureRef = useRef<{ readonly elementId: string; readonly original: number } | null>(null)
  const shapeRadiusDraftRef = useRef<{ readonly elementId: string; readonly value: number } | null>(null)
  const shapeLineGestureRef = useRef<{ readonly elementId: string; readonly original: SceneElement['transform']; readonly endpoint: 'start' | 'end' } | null>(null)
  const shapeLineDraftRef = useRef<{ readonly elementId: string; readonly transform: SceneElement['transform'] } | null>(null)
  const initiallyFittedProjectRef = useRef<string | null>(null)
  const ephemeralDrawingRef = useRef(false)
  const ephemeralPointsRef = useRef<readonly { readonly x: number; readonly y: number }[]>([])
  const size = useContainerSize(containerRef)
  const scene = useWorkspaceStore((state) => state.scene)
  const selectedIds = useWorkspaceStore((state) => state.selectedIds)
  const editingGroupId = useWorkspaceStore((state) => state.editingGroupId)
  const select = useWorkspaceStore((state) => state.select)
  const setSelection = useWorkspaceStore((state) => state.setSelection)
  const exitGroupEditing = useWorkspaceStore((state) => state.exitGroupEditing)
  const activeTool = useWorkspaceStore((state) => state.activeTool)
  const setActiveTool = useWorkspaceStore((state) => state.setActiveTool)
  const addElement = useWorkspaceStore((state) => state.addElement)
  const execute = useWorkspaceStore((state) => state.execute)
  const updateElement = useWorkspaceStore((state) => state.updateElement)
  const duplicateSelection = useWorkspaceStore((state) => state.duplicateSelection)
  const deleteSelection = useWorkspaceStore((state) => state.deleteSelection)
  const groupSelection = useWorkspaceStore((state) => state.groupSelection)
  const ungroupSelection = useWorkspaceStore((state) => state.ungroupSelection)
  const alignSelection = useWorkspaceStore((state) => state.alignSelection)
  const distributeSelection = useWorkspaceStore((state) => state.distributeSelection)
  const workspaceZoom = useWorkspaceStore((state) => state.zoom)
  const pan = useWorkspaceStore((state) => state.pan)
  const setViewport = useWorkspaceStore((state) => state.setViewport)
  const ratioLocked = useWorkspaceStore((state) => state.transformRatioLocked)
  const islandLayouts = useIslandLayoutStore((state) => state.layouts)
  const safeFitInsets = useMemo(
    () => preview || focusMode
      ? { top: 24, right: 24, bottom: 24, left: 24 }
      : islandFitInsets(islandLayouts, size),
    [focusMode, islandLayouts, preview, size]
  )

  // Document coordinates stay in output pixels. Tool islands only influence a
  // deliberate "fit" command; dragging or resizing them never changes the
  // document scale underneath the user's pointer.
  const baseArtboard = useMemo(() => ({
    width: scene.canvas.outputWidth,
    height: scene.canvas.outputHeight
  }), [scene.canvas.outputHeight, scene.canvas.outputWidth])
  const zoom = preview
    ? Math.max(0.01, Math.min(
        Math.max(1, size.width - safeFitInsets.left - safeFitInsets.right) / baseArtboard.width,
        Math.max(1, size.height - safeFitInsets.top - safeFitInsets.bottom) / baseArtboard.height
      ))
    : workspaceZoom
  const stagePanX = preview ? 0 : pan.x
  const stagePanY = preview ? 0 : pan.y

  const artboard = {
    x: (size.width - baseArtboard.width * zoom) / 2 + stagePanX,
    y: (size.height - baseArtboard.height * zoom) / 2 + stagePanY,
    width: baseArtboard.width,
    height: baseArtboard.height
  }

  const displayedArtboard = useMemo<CanvasRect>(() => ({
    x: artboard.x,
    y: artboard.y,
    width: artboard.width * zoom,
    height: artboard.height * zoom
  }), [artboard.x, artboard.y, artboard.width, artboard.height, zoom])
  const selectedElements = useMemo(
    () => selectedIds
      .map((id) => scene.elements.find((element) => element.id === id))
      .filter((element): element is SceneElement => element !== undefined),
    [scene.elements, selectedIds]
  )
  const selectableElements = useMemo(() => scene.elements.filter((element) => {
    if (!element.visible || element.locked || element.type === 'mask') return false
    if (element.type === 'group') return editingGroupId !== element.id
    if (editingGroupId !== null) return element.groupId === editingGroupId
    return element.groupId === null
  }), [editingGroupId, scene.elements])
  const blendSupportByElement = useMemo(() => new Map(scene.elements.map((element) => {
    const blendMode = resolveBlendMode(element)
    return [element.id, canvasSupportsBlendMode(blendMode)] as const
  })), [scene.elements])
  const unsupportedBlendModes = useMemo(() => [...new Set(scene.elements.flatMap((element) => {
    const blendMode = resolveBlendMode(element)
    return element.visible && blendMode !== 'normal' && blendSupportByElement.get(element.id) === false ? [blendMode] : []
  }))], [blendSupportByElement, scene.elements])
  const selectionBounds = useMemo(
    () => boundsForElements(selectedElements, displayedArtboard),
    [displayedArtboard, selectedElements]
  )
  const contextBarTop = selectionBounds === null
    ? 12
    : selectionBounds.y - 96 >= 12
      ? selectionBounds.y - 96
      : Math.max(12, Math.min(size.height - 50, selectionBounds.y + selectionBounds.height + 18))
  const inlineText = inlineTextId === null
    ? undefined
    : scene.elements.find((element): element is Extract<SceneElement, { type: 'text' }> => element.id === inlineTextId && element.type === 'text')
  const shapeEditElement = shapeEditId === null
    ? undefined
    : scene.elements.find((element): element is Extract<SceneElement, { type: 'shape' }> => element.id === shapeEditId && element.type === 'shape')
  const shapeEditDisplayElement = shapeEditElement === undefined
    ? undefined
    : shapeLineDraft?.elementId === shapeEditElement.id
      ? { ...shapeEditElement, transform: shapeLineDraft.transform }
      : shapeEditElement
  const shapeEditBounds = shapeEditDisplayElement === undefined ? null : rotatedElementBounds(shapeEditDisplayElement, displayedArtboard)
  const shapeLineEndpoints = shapeEditDisplayElement?.shape === 'line'
    ? lineEndpointsForTransform(shapeEditDisplayElement.transform, displayedArtboard)
    : null
  const shapeToolbarPosition = shapeEditBounds === null
    ? null
    : shapeEditToolbarPosition(shapeEditBounds, size, { width: 368, height: 44 })
  const cropElement = cropSession === null
    ? undefined
    : scene.elements.find((element): element is Extract<SceneElement, { type: 'image' }> => element.id === cropSession.elementId && element.type === 'image')

  const setClampedViewport = useCallback((nextZoom: number, nextPan: CanvasPoint): void => {
    const centeredArtboard = {
      x: (size.width - baseArtboard.width * nextZoom) / 2,
      y: (size.height - baseArtboard.height * nextZoom) / 2,
      width: baseArtboard.width * nextZoom,
      height: baseArtboard.height * nextZoom
    }
    setViewport(nextZoom, clampPan({ pan: nextPan, viewport: size, centeredArtboard }))
  }, [baseArtboard.height, baseArtboard.width, setViewport, size])

  const viewFit = useCallback((): void => {
    const safeWidth = Math.max(120, size.width - safeFitInsets.left - safeFitInsets.right)
    const safeHeight = Math.max(120, size.height - safeFitInsets.top - safeFitInsets.bottom)
    const nextZoom = Math.min(safeWidth / baseArtboard.width, safeHeight / baseArtboard.height)
    const safeCenter = {
      x: safeFitInsets.left + safeWidth / 2,
      y: safeFitInsets.top + safeHeight / 2
    }
    setClampedViewport(nextZoom, {
      x: safeCenter.x - size.width / 2,
      y: safeCenter.y - size.height / 2
    })
  }, [baseArtboard.height, baseArtboard.width, safeFitInsets.bottom, safeFitInsets.left, safeFitInsets.right, safeFitInsets.top, setClampedViewport, size.height, size.width])

  const beginElementDrag = useCallback((elementId: string): void => {
    if (!dragActiveRef.current) {
      dragCommitOwnerRef.current = elementId
      dragCancelledRef.current = false
    }
    dragActiveRef.current = true
  }, [])

  const finishElementDrag = useCallback((elementId: string): void => {
    if (dragCommitOwnerRef.current !== elementId) return
    dragActiveRef.current = false
    dragCancelledRef.current = false
    dragCommitOwnerRef.current = null
  }, [])

  const isDragCommitOwner = useCallback((elementId: string): boolean => dragCommitOwnerRef.current === elementId, [])

  const cancelActiveElementDrag = useCallback((): boolean => {
    if (!dragActiveRef.current) return false
    dragCancelledRef.current = true
    const stage = stageRef.current
    if (stage !== null) {
      stage.find((node: Konva.Node) => node.isDragging()).forEach((node: Konva.Node) => node.stopDrag())
    }
    dragActiveRef.current = false
    dragCancelledRef.current = false
    dragCommitOwnerRef.current = null
    setGuides([])
    return true
  }, [])

  const cancelShapeRadiusGesture = useCallback((): boolean => {
    if (shapeRadiusGestureRef.current === null && shapeRadiusDraftRef.current === null) return false
    shapeRadiusGestureRef.current = null
    shapeRadiusDraftRef.current = null
    stageRef.current?.find('.shape-radius-handle').forEach((node) => {
      if (node.isDragging()) node.stopDrag()
    })
    setShapeRadiusDraft(null)
    return true
  }, [])

  const cancelShapeLineGesture = useCallback((): boolean => {
    if (shapeLineGestureRef.current === null && shapeLineDraftRef.current === null) return false
    // Clear the refs before stopDrag: Konva synchronously dispatches dragend,
    // which must observe a cancelled gesture and therefore never commit it.
    shapeLineGestureRef.current = null
    shapeLineDraftRef.current = null
    stageRef.current?.find('.shape-line-endpoint').forEach((node) => {
      if (node.isDragging()) node.stopDrag()
    })
    setShapeLineDraft(null)
    return true
  }, [])

  const requestElementEdit = useCallback((element: SceneElement): void => {
    setGuides([])
    setMarquee(null)
    cancelShapeRadiusGesture()
    cancelShapeLineGesture()
    if (element.type === 'text') {
      setCropSession(null)
      setShapeEditId(null)
      setInlineTextId(element.id)
    } else if (element.type === 'image') {
      setInlineTextId(null)
      setShapeEditId(null)
      setCropSession({ elementId: element.id, original: { ...element.crop }, draft: { ...element.crop } })
    } else if (element.type === 'shape' && !element.locked) {
      setInlineTextId(null)
      setCropSession(null)
      setShapeEditId(element.id)
    }
  }, [cancelShapeLineGesture, cancelShapeRadiusGesture])

  useEffect(() => {
    if (shapeEditId === null) return
    const element = scene.elements.find((candidate) => candidate.id === shapeEditId)
    if (element?.type === 'shape' && !element.locked && selectedIds.length === 1 && selectedIds[0] === shapeEditId) return
    const frame = window.requestAnimationFrame(() => {
      shapeRadiusGestureRef.current = null
      shapeRadiusDraftRef.current = null
      shapeLineGestureRef.current = null
      shapeLineDraftRef.current = null
      setShapeRadiusDraft(null)
      setShapeLineDraft(null)
      setShapeEditId(null)
    })
    return () => window.cancelAnimationFrame(frame)
  }, [scene.elements, selectedIds, shapeEditId])

  useEffect(() => {
    if (shapeEditId === null || activeTool === 'select') return
    const frame = window.requestAnimationFrame(() => {
      cancelShapeRadiusGesture()
      cancelShapeLineGesture()
      setShapeEditId(null)
    })
    return () => window.cancelAnimationFrame(frame)
  }, [activeTool, cancelShapeLineGesture, cancelShapeRadiusGesture, shapeEditId])

  const beginShapeRadiusGesture = useCallback((element: Extract<SceneElement, { type: 'shape' }>): void => {
    shapeRadiusGestureRef.current = { elementId: element.id, original: element.cornerRadius }
    const draft = { elementId: element.id, value: element.cornerRadius }
    shapeRadiusDraftRef.current = draft
    setShapeRadiusDraft(draft)
  }, [])

  const updateShapeRadiusGesture = useCallback((elementId: string, value: number): void => {
    const draft = { elementId, value }
    shapeRadiusDraftRef.current = draft
    setShapeRadiusDraft(draft)
  }, [])

  const finishShapeRadiusGesture = useCallback((element: Extract<SceneElement, { type: 'shape' }>): void => {
    const gesture = shapeRadiusGestureRef.current
    const draft = shapeRadiusDraftRef.current
    shapeRadiusGestureRef.current = null
    if (gesture?.elementId === element.id && draft?.elementId === element.id && Math.abs(draft.value - gesture.original) > .0001) {
      void updateElement(element.id, { cornerRadius: draft.value }, `调整“${element.name}”圆角`).finally(() => {
        if (shapeRadiusDraftRef.current === draft) {
          shapeRadiusDraftRef.current = null
          setShapeRadiusDraft(null)
        }
      })
      return
    }
    shapeRadiusDraftRef.current = null
    setShapeRadiusDraft(null)
  }, [updateElement])

  const beginShapeLineGesture = useCallback((element: Extract<SceneElement, { type: 'shape' }>, endpoint: 'start' | 'end'): void => {
    shapeLineGestureRef.current = { elementId: element.id, original: { ...element.transform }, endpoint }
    const draft = { elementId: element.id, transform: { ...element.transform } }
    shapeLineDraftRef.current = draft
    setShapeLineDraft(draft)
  }, [])

  const updateShapeLineGesture = useCallback((elementId: string, endpoint: 'start' | 'end', position: CanvasPoint): void => {
    const gesture = shapeLineGestureRef.current
    if (gesture?.elementId !== elementId || gesture.endpoint !== endpoint) return
    const originalEndpoints = lineEndpointsForTransform(gesture.original, displayedArtboard)
    const nextTransform = lineTransformFromStageEndpoints(
      endpoint === 'start' ? position : originalEndpoints.start,
      endpoint === 'end' ? position : originalEndpoints.end,
      gesture.original.height,
      displayedArtboard
    )
    const draft = { elementId, transform: nextTransform }
    shapeLineDraftRef.current = draft
    setShapeLineDraft(draft)
  }, [displayedArtboard])

  const finishShapeLineGesture = useCallback((element: Extract<SceneElement, { type: 'shape' }>): void => {
    const gesture = shapeLineGestureRef.current
    const draft = shapeLineDraftRef.current
    shapeLineGestureRef.current = null
    const changed = gesture !== null && draft !== null && (
      Math.abs(draft.transform.x - gesture.original.x) > .000001
      || Math.abs(draft.transform.y - gesture.original.y) > .000001
      || Math.abs(draft.transform.width - gesture.original.width) > .000001
      || Math.abs(draft.transform.height - gesture.original.height) > .000001
      || Math.abs(draft.transform.rotation - gesture.original.rotation) > .000001
    )
    if (gesture?.elementId === element.id && draft?.elementId === element.id && changed) {
      void updateElement(element.id, { transform: draft.transform }, `调整“${element.name}”端点`).finally(() => {
        if (shapeLineDraftRef.current === draft) {
          shapeLineDraftRef.current = null
          setShapeLineDraft(null)
        }
      })
      return
    }
    shapeLineDraftRef.current = null
    setShapeLineDraft(null)
  }, [updateElement])

  const getEphemeralPoint = (): { readonly x: number; readonly y: number } | null => {
    const pointer = stageRef.current?.getPointerPosition()
    if (pointer === null || pointer === undefined) return null
    const width = artboard.width * zoom
    const height = artboard.height * zoom
    const x = (pointer.x - artboard.x) / width
    const y = (pointer.y - artboard.y) / height
    if (x < 0 || x > 1 || y < 0 || y > 1) return null
    return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) }
  }

  const beginEphemeralAnnotation = (): void => {
    if (!preview || !ephemeralAnnotationEnabled) return
    const point = getEphemeralPoint()
    if (point === null) return
    if (ephemeralAnnotationTool === 'erase') {
      const hit = [...ephemeralAnnotationRegions].reverse().find((region) => pointInPolygon(point, region.points))
      if (hit !== undefined) onEphemeralAnnotationErase?.(hit.id)
      return
    }
    ephemeralDrawingRef.current = true
    ephemeralPointsRef.current = [point]
    setEphemeralDraft([point])
    onEphemeralAnnotationChange?.([point])
  }

  const continueEphemeralAnnotation = (): void => {
    if (!preview || !ephemeralAnnotationEnabled || !ephemeralDrawingRef.current) return
    const point = getEphemeralPoint()
    if (point === null) return
    if (ephemeralAnnotationTool === 'rect') {
      const start = ephemeralPointsRef.current[0]
      if (start === undefined) return
      const next = [start, { x: point.x, y: start.y }, point, { x: start.x, y: point.y }]
      ephemeralPointsRef.current = next
      setEphemeralDraft(next)
      onEphemeralAnnotationChange?.(next)
      return
    }
    const previous = ephemeralPointsRef.current.at(-1)
    if (previous !== undefined && Math.hypot(point.x - previous.x, point.y - previous.y) < 0.004) return
    const next = [...ephemeralPointsRef.current, point]
    ephemeralPointsRef.current = next
    setEphemeralDraft(next)
    onEphemeralAnnotationChange?.(next)
  }

  const finishEphemeralAnnotation = (): void => {
    if (!ephemeralDrawingRef.current) return
    ephemeralDrawingRef.current = false
    if (ephemeralPointsRef.current.length >= 3 && onEphemeralAnnotationComplete !== undefined) {
      onEphemeralAnnotationComplete({
        id: crypto.randomUUID(),
        mode: ephemeralAnnotationMode,
        points: [...ephemeralPointsRef.current],
        closed: true,
        width: ephemeralAnnotationTool === 'paint' ? 0.026 : 0.015
      })
      ephemeralPointsRef.current = []
      setEphemeralDraft([])
      onEphemeralAnnotationChange?.([])
    } else if (ephemeralPointsRef.current.length < 3) {
      ephemeralPointsRef.current = []
      setEphemeralDraft([])
      onEphemeralAnnotationChange?.([])
    }
  }

  useEffect(() => {
    const stage = stageRef.current
    const transformer = transformerRef.current
    if (stage === null || transformer === null) return
    if (preview || inlineTextId !== null || cropSession !== null || shapeEditElement?.shape === 'line' || selectedIds.length === 0) {
      transformer.nodes([])
    } else {
      const nodes = selectedIds.flatMap((id) => {
        const selected = scene.elements.find((element) => element.id === id)
        const node = stage.findOne(`#element-${id}`)
        const editingRootSelected = selected?.type === 'group' && selected.id === editingGroupId
        return node === undefined || selected?.locked === true || editingRootSelected ? [] : [node]
      })
      transformer.nodes(nodes)
    }
    for (const anchorName of ['top-left', 'top-center', 'top-right', 'middle-left', 'middle-right', 'bottom-left', 'bottom-center', 'bottom-right', 'rotater']) {
      transformer.find(`.${anchorName}`).forEach((anchor) => (anchor as Konva.Shape).hitStrokeWidth(34))
    }
    // Selection changes are infrequent, while the transform anchors must be
    // interactive immediately. A deferred batch draw can leave Konva's hit
    // canvas one frame behind the visible transformer, making a first click
    // on an anchor intermittently miss.
    transformer.getLayer()?.draw()
  }, [cropSession, editingGroupId, inlineTextId, preview, scene.elements, selectedIds, shapeEditElement?.shape, size.width])

  const restoreTransformSession = useCallback((session: TransformSession): void => {
    const stage = stageRef.current
    if (stage === null) return
    const restoreIds = new Set(session.ids)
    for (const id of session.ids) {
      const element = session.scene.elements.find((candidate) => candidate.id === id)
      if (element?.type === 'group') element.childIds.forEach((childId) => restoreIds.add(childId))
    }
    for (const id of restoreIds) {
      const element = session.scene.elements.find((candidate) => candidate.id === id)
      const node = stage.findOne(`#element-${id}`)
      if (element === undefined || node === undefined) continue
      node.setAttrs({
        x: element.transform.x * baseArtboard.width,
        y: element.transform.y * baseArtboard.height,
        scaleX: 1,
        scaleY: 1,
        rotation: element.transform.rotation
      })
    }
    transformerRef.current?.stopTransform()
    transformerRef.current?.getLayer()?.batchDraw()
    setTransformHud(null)
  }, [baseArtboard.height, baseArtboard.width])

  const commitTransformSession = useCallback((): void => {
    const session = transformSessionRef.current
    const stage = stageRef.current
    transformSessionRef.current = null
    if (session === null || stage === null) return
    const commands = new Map<string, SceneCommand>()
    const childOverrides = new Map<string, SceneElement['transform']>()
    for (const id of session.ids) {
      const original = session.scene.elements.find((element) => element.id === id)
      const node = stage.findOne(`#element-${id}`)
      if (original === undefined || node === undefined || original.locked) continue
      const scaleX = Math.max(0.001, node.scaleX())
      const scaleY = Math.max(0.001, node.scaleY())
      const next = {
        x: node.x() / baseArtboard.width,
        y: node.y() / baseArtboard.height,
        width: Math.max(0.01, original.transform.width * scaleX),
        height: Math.max(0.01, original.transform.height * scaleY),
        rotation: node.rotation()
      }
      node.scale({ x: 1, y: 1 })
      commands.set(original.id, { kind: 'element.update', elementId: original.id, changes: { transform: next } })
      if (original.groupId !== null) childOverrides.set(original.id, next)
      if (original.type !== 'group') continue
      const children = session.scene.elements.filter((child) => original.childIds.includes(child.id))
      const oldAngle = original.transform.rotation * Math.PI / 180
      const nextAngle = next.rotation * Math.PI / 180
      const oldCenter = {
        x: original.transform.x + original.transform.width / 2,
        y: original.transform.y + original.transform.height / 2
      }
      const nextCenter = { x: next.x + next.width / 2, y: next.y + next.height / 2 }
      for (const child of children) {
        const childCenter = {
          x: child.transform.x + child.transform.width / 2,
          y: child.transform.y + child.transform.height / 2
        }
        const vector = { x: childCenter.x - oldCenter.x, y: childCenter.y - oldCenter.y }
        const local = {
          x: vector.x * Math.cos(-oldAngle) - vector.y * Math.sin(-oldAngle),
          y: vector.x * Math.sin(-oldAngle) + vector.y * Math.cos(-oldAngle)
        }
        const scaled = { x: local.x * scaleX, y: local.y * scaleY }
        const rotated = {
          x: scaled.x * Math.cos(nextAngle) - scaled.y * Math.sin(nextAngle),
          y: scaled.x * Math.sin(nextAngle) + scaled.y * Math.cos(nextAngle)
        }
        const childWidth = child.transform.width * scaleX
        const childHeight = child.transform.height * scaleY
        const childTransform = {
          x: nextCenter.x + rotated.x - childWidth / 2,
          y: nextCenter.y + rotated.y - childHeight / 2,
          width: childWidth,
          height: childHeight,
          rotation: child.transform.rotation + next.rotation - original.transform.rotation
        }
        commands.set(child.id, { kind: 'element.update', elementId: child.id, changes: { transform: childTransform } })
      }
    }
    const affectedGroups = new Set(
      [...childOverrides.keys()]
        .map((id) => session.scene.elements.find((element) => element.id === id)?.groupId)
        .filter((id): id is string => id !== null && id !== undefined && !session.ids.includes(id))
    )
    for (const groupId of affectedGroups) {
      const transform = groupBoundsForChildTransforms(session.scene, groupId, childOverrides)
      if (transform !== null) commands.set(groupId, { kind: 'element.update', elementId: groupId, changes: { transform } })
    }
    if (commands.size > 0) void execute(`变换 ${session.ids.length} 个元素`, [...commands.values()])
    setTransformHud(null)
  }, [baseArtboard.height, baseArtboard.width, execute])

  useEffect(() => onReady?.(), [onReady])
  useEffect(() => {
    onScaleChange?.(zoom * 100)
  }, [onScaleChange, zoom])

  useEffect(() => {
    if (preview || initiallyFittedProjectRef.current === scene.projectId) return
    if (islandLayouts.tools === undefined || islandLayouts.composer === undefined || islandLayouts.inspector === undefined) return
    const rect = containerRef.current?.getBoundingClientRect()
    if (rect === undefined || Math.abs(rect.width - size.width) > 1 || Math.abs(rect.height - size.height) > 1) return
    initiallyFittedProjectRef.current = scene.projectId
    viewFit()
  }, [islandLayouts.composer, islandLayouts.inspector, islandLayouts.tools, preview, scene.projectId, size.height, size.width, viewFit])

  useEffect(() => {
    if (preview) return
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (canvasKeyboardBlocked(event)) return
      if (event.key === ' ') {
        if (!isInteractiveTarget(event.target)) {
          event.preventDefault()
          setSpacePressed(true)
        }
        return
      }
      setShiftPressed(event.shiftKey)
      setAltPressed(event.altKey)
      if (event.isComposing || editableEventTarget(event.target)) return
      if (event.key === 'Escape') {
        const cancelledDrag = cancelActiveElementDrag()
        const cancelledRadius = cancelShapeRadiusGesture()
        const cancelledLine = cancelShapeLineGesture()
        const session = transformSessionRef.current
        if (session !== null) {
          transformSessionRef.current = null
          restoreTransformSession(session)
        }
        if (cropSession !== null) setCropSession(null)
        if (inlineTextId !== null) setInlineTextId(null)
        if (shapeEditId !== null) setShapeEditId(null)
        if (marquee !== null) setMarquee(null)
        if (session !== null || cropSession !== null || inlineTextId !== null || shapeEditId !== null || cancelledDrag || cancelledRadius || cancelledLine || marquee !== null) {
          event.preventDefault()
          event.stopImmediatePropagation()
        }
        return
      }
      if (event.key === 'Enter' && cropSession !== null) {
        event.preventDefault()
        event.stopImmediatePropagation()
        void updateElement(cropSession.elementId, { crop: cropSession.draft }, '裁剪图片')
        setCropSession(null)
        return
      }
      if (event.key === 'Enter' && shapeEditId !== null) {
        event.preventDefault()
        event.stopImmediatePropagation()
        cancelShapeRadiusGesture()
        cancelShapeLineGesture()
        setShapeEditId(null)
      }
    }
    const handleKeyUp = (event: KeyboardEvent): void => {
      if (event.key === ' ') setSpacePressed(false)
      setShiftPressed(event.shiftKey)
      setAltPressed(event.altKey)
    }
    const handleBlur = (): void => {
      setSpacePressed(false)
      setShiftPressed(false)
      setAltPressed(false)
      panningRef.current = false
      setIsPanning(false)
      panPointerRef.current = null
      cancelActiveElementDrag()
      cancelShapeRadiusGesture()
      cancelShapeLineGesture()
      setShapeEditId(null)
      const session = transformSessionRef.current
      if (session !== null) {
        transformSessionRef.current = null
        restoreTransformSession(session)
      }
    }
    window.addEventListener('keydown', handleKeyDown, true)
    window.addEventListener('keyup', handleKeyUp, true)
    window.addEventListener('blur', handleBlur)
    const modalChanged = (): void => { if (activeModal() !== null) handleBlur() }
    window.addEventListener(MODAL_SCOPE_CHANGED, modalChanged)
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true)
      window.removeEventListener('keyup', handleKeyUp, true)
      window.removeEventListener('blur', handleBlur)
      window.removeEventListener(MODAL_SCOPE_CHANGED, modalChanged)
    }
  }, [cancelActiveElementDrag, cancelShapeLineGesture, cancelShapeRadiusGesture, cropSession, inlineTextId, marquee, preview, restoreTransformSession, shapeEditId, updateElement])

  const publishArtboard = useCanvasViewportStore((state) => state.publish)
  useEffect(() => {
    if (preview) return
    publishArtboard({ x: artboard.x, y: artboard.y, width: artboard.width, height: artboard.height, zoom })
  }, [artboard.height, artboard.width, artboard.x, artboard.y, preview, publishArtboard, zoom])

  useImperativeHandle(forwardedRef, () => ({
    viewFit,
    viewActualSize() {
      setClampedViewport(1, { x: 0, y: 0 })
    },
    viewScalePercentage(percentage) {
      const nextZoom = Math.min(32, Math.max(0.05, percentage / 100))
      const ratio = nextZoom / Math.max(zoom, 0.0001)
      setClampedViewport(nextZoom, { x: pan.x * ratio, y: pan.y * ratio })
    },
    zoomBy(factor) {
      const nextZoom = Math.min(32, Math.max(0.05, zoom * factor))
      const ratio = nextZoom / Math.max(zoom, 0.0001)
      setClampedViewport(nextZoom, { x: pan.x * ratio, y: pan.y * ratio })
    },
    exportDataUrl(format, jpegBackground = '#FFFFFF') {
      if (unsupportedBlendModes.length > 0) return null
      const stage = stageRef.current
      const auxiliary = auxiliaryLayerRef.current
      if (stage === null || auxiliary === null) return null
      const editorReferences = stage.find('.editor-reference')
      const editorReferenceVisibility = editorReferences.map((node) => node.visible())
      const editorChrome = stage.find('.editor-chrome')
      const editorChromeVisibility = editorChrome.map((node) => node.visible())
      auxiliary.hide()
      editorReferences.forEach((node) => node.hide())
      editorChrome.forEach((node) => node.hide())
      stage.draw()
      try {
        const renderScale = Math.max(
          scene.canvas.outputWidth / (artboard.width * zoom),
          scene.canvas.outputHeight / (artboard.height * zoom)
        )
        const rendered = stage.toCanvas({
          x: artboard.x,
          y: artboard.y,
          width: artboard.width * zoom,
          height: artboard.height * zoom,
          pixelRatio: renderScale
        })
        const output = document.createElement('canvas')
        output.width = scene.canvas.outputWidth
        output.height = scene.canvas.outputHeight
        const context = output.getContext('2d')
        if (context === null) return null
        if (format === 'jpeg') {
          context.fillStyle = jpegBackground
          context.fillRect(0, 0, output.width, output.height)
        }
        context.imageSmoothingEnabled = true
        context.imageSmoothingQuality = 'high'
        context.drawImage(rendered, 0, 0, output.width, output.height)
        return output.toDataURL(
          format === 'png' ? 'image/png' : format === 'jpeg' ? 'image/jpeg' : 'image/webp',
          0.94
        )
      } finally {
        editorReferences.forEach((node, index) => node.visible(editorReferenceVisibility[index] ?? false))
        editorChrome.forEach((node, index) => node.visible(editorChromeVisibility[index] ?? false))
        auxiliary.show()
        stage.draw()
      }
    }
  }), [artboard.height, artboard.width, artboard.x, artboard.y, pan.x, pan.y, scene.canvas.outputHeight, scene.canvas.outputWidth, setClampedViewport, unsupportedBlendModes.length, viewFit, zoom])

  const handleWheel = useCallback((event: KonvaEventObject<WheelEvent>) => {
    event.evt.preventDefault()
    const stage = stageRef.current
    const pointer = stage?.getPointerPosition()
    if (pointer === null || pointer === undefined) return
    if (cropSession !== null && cropElement !== undefined) {
      const bounds = rotatedElementBounds(cropElement, displayedArtboard)
      if (rectContainsPoint(bounds, pointer)) {
        const factor = event.evt.deltaY > 0 ? 1.08 : 0.92
        setCropSession((current) => {
          if (current === null) return current
          const width = current.draft.width * factor
          const height = current.draft.height * factor
          return {
            ...current,
            draft: clampCrop({
              x: current.draft.x - (width - current.draft.width) / 2,
              y: current.draft.y - (height - current.draft.height) / 2,
              width,
              height
            })
          }
        })
        return
      }
    }
    const zoomGesture = event.evt.ctrlKey || event.evt.metaKey || event.evt.altKey
    if (!zoomGesture) {
      const deltaX = event.evt.shiftKey && Math.abs(event.evt.deltaX) < Math.abs(event.evt.deltaY)
        ? event.evt.deltaY
        : event.evt.deltaX
      const deltaY = event.evt.shiftKey ? 0 : event.evt.deltaY
      setClampedViewport(zoom, { x: pan.x - deltaX, y: pan.y - deltaY })
      return
    }
    const nextZoom = Math.min(32, Math.max(0.05, zoom * (event.evt.deltaY > 0 ? 0.9 : 1.1)))
    const center = {
      x: size.width / 2,
      y: size.height / 2
    }
    const oldTop = {
      x: center.x - baseArtboard.width * zoom / 2 + pan.x,
      y: center.y - baseArtboard.height * zoom / 2 + pan.y
    }
    const normalized = {
      x: (pointer.x - oldTop.x) / (baseArtboard.width * zoom),
      y: (pointer.y - oldTop.y) / (baseArtboard.height * zoom)
    }
    const desiredTop = {
      x: pointer.x - normalized.x * baseArtboard.width * nextZoom,
      y: pointer.y - normalized.y * baseArtboard.height * nextZoom
    }
    setClampedViewport(nextZoom, {
      x: desiredTop.x - (center.x - baseArtboard.width * nextZoom / 2),
      y: desiredTop.y - (center.y - baseArtboard.height * nextZoom / 2)
    })
  }, [baseArtboard.height, baseArtboard.width, cropElement, cropSession, displayedArtboard, pan.x, pan.y, setClampedViewport, size.height, size.width, zoom])

  const sortedElements = [...scene.elements]
    .sort((left, right) => left.zIndex - right.zIndex)
    .filter((element) => element.type !== 'mask' || activeTool === 'mask' || selectedIds.includes(element.id))

  const beginMask = (): boolean => {
    if (activeTool !== 'mask') return false
    const target = scene.elements.find((element) => element.id === selectedIds[0])
    const pointer = stageRef.current?.getPointerPosition()
    if (target?.type !== 'image' || pointer === null || pointer === undefined) return true
    const insideTarget =
      pointer.x >= artboard.x + target.transform.x * artboard.width * zoom &&
      pointer.x <= artboard.x + (target.transform.x + target.transform.width) * artboard.width * zoom &&
      pointer.y >= artboard.y + target.transform.y * artboard.height * zoom &&
      pointer.y <= artboard.y + (target.transform.y + target.transform.height) * artboard.height * zoom
    if (insideTarget) setDraftMask([pointer.x, pointer.y])
    return true
  }

  const continueMask = (): boolean => {
    if (activeTool !== 'mask' || draftMask.length === 0) return false
    const pointer = stageRef.current?.getPointerPosition()
    if (pointer !== null && pointer !== undefined) setDraftMask((points) => [...points, pointer.x, pointer.y])
    return true
  }

  const finishMask = (): boolean => {
    if (activeTool !== 'mask') return false
    const target = scene.elements.find((element) => element.id === selectedIds[0])
    if (target?.type === 'image' && draftMask.length >= 6) {
      const angle = -target.transform.rotation * Math.PI / 180
      const center = {
        x: target.transform.x + target.transform.width / 2,
        y: target.transform.y + target.transform.height / 2
      }
      const points = Array.from({ length: draftMask.length / 2 }, (_, index) => {
        const canvasPoint = {
          x: ((draftMask[index * 2] as number) - artboard.x) / (artboard.width * zoom),
          y: ((draftMask[index * 2 + 1] as number) - artboard.y) / (artboard.height * zoom)
        }
        const dx = canvasPoint.x - center.x
        const dy = canvasPoint.y - center.y
        const unrotated = {
          x: center.x + dx * Math.cos(angle) - dy * Math.sin(angle),
          y: center.y + dx * Math.sin(angle) + dy * Math.cos(angle)
        }
        return {
          x: Math.min(1, Math.max(0, (unrotated.x - target.transform.x) / target.transform.width)),
          y: Math.min(1, Math.max(0, (unrotated.y - target.transform.y) / target.transform.height))
        }
      })
      const element: SceneElement = {
        id: globalThis.crypto.randomUUID(),
        version: ELEMENT_SCHEMA_VERSION,
        type: 'mask',
        name: '局部修改区域',
        description: '仅在此区域应用局部修改；其他区域保持不变。',
        transform: { ...target.transform },
        zIndex: scene.elements.length,
        opacity: 1,
        blendMode: 'normal',
        visible: true,
        locked: false,
        groupId: null,
        semanticRole: 'edit-mask',
        referencePolicy: 'exclude',
        mode: 'edit',
        targetElementId: target.id,
        paths: [{ id: globalThis.crypto.randomUUID(), points, closed: true }],
        feather: 0.08
      }
      addElement(element, '绘制局部修改蒙版')
    }
    setDraftMask([])
    setActiveTool('select')
    return true
  }

  const beginSketch = (): boolean => {
    if (activeTool !== 'sketch') return false
    const pointer = stageRef.current?.getPointerPosition()
    if (pointer === null || pointer === undefined) return true
    const inside =
      pointer.x >= artboard.x && pointer.x <= artboard.x + artboard.width * zoom &&
      pointer.y >= artboard.y && pointer.y <= artboard.y + artboard.height * zoom
    if (inside) setDraftStroke([pointer.x, pointer.y])
    return true
  }

  const continueSketch = (): boolean => {
    if (activeTool !== 'sketch' || draftStroke.length === 0) return false
    const pointer = stageRef.current?.getPointerPosition()
    if (pointer !== null && pointer !== undefined) {
      setDraftStroke((points) => [...points, pointer.x, pointer.y])
    }
    return true
  }

  const finishSketch = (): boolean => {
    if (activeTool !== 'sketch') return false
    if (draftStroke.length >= 4) {
      const normalized = Array.from({ length: draftStroke.length / 2 }, (_, index) => ({
        x: Math.min(1, Math.max(0, (draftStroke[index * 2] as number - artboard.x) / (artboard.width * zoom))),
        y: Math.min(1, Math.max(0, (draftStroke[index * 2 + 1] as number - artboard.y) / (artboard.height * zoom)))
      }))
      const left = Math.min(...normalized.map((point) => point.x))
      const top = Math.min(...normalized.map((point) => point.y))
      const right = Math.max(...normalized.map((point) => point.x))
      const bottom = Math.max(...normalized.map((point) => point.y))
      const width = Math.max(0.01, right - left)
      const height = Math.max(0.01, bottom - top)
      const element: SceneElement = {
        id: globalThis.crypto.randomUUID(),
        version: ELEMENT_SCHEMA_VERSION,
        type: 'sketch',
        name: '自由草图',
        description: '用户在画布上绘制的构图参考',
        transform: { x: left, y: top, width, height, rotation: 0 },
        zIndex: scene.elements.length,
        opacity: 1,
        blendMode: 'normal',
        visible: true,
        locked: false,
        groupId: null,
        semanticRole: 'composition-sketch',
        referencePolicy: 'include',
        strokes: [{
          id: globalThis.crypto.randomUUID(),
          points: normalized.map((point) => ({ x: (point.x - left) / width, y: (point.y - top) / height })),
          color: '#7D96B3',
          width: 0.016,
          opacity: 0.9
        }],
        fidelity: 0.72,
        finalVisible: false
      }
      addElement(element, '绘制自由草图')
    }
    setDraftStroke([])
    setActiveTool('select')
    return true
  }

  const beginCropDrag = (): boolean => {
    if (cropSession === null || cropElement === undefined) return false
    const pointer = stageRef.current?.getPointerPosition()
    if (pointer === null || pointer === undefined || !rectContainsPoint(rotatedElementBounds(cropElement, displayedArtboard), pointer)) return false
    cropDragRef.current = { pointer, crop: { ...cropSession.draft } }
    return true
  }

  const continueCropDrag = (): boolean => {
    const initial = cropDragRef.current
    if (initial === null || cropElement === undefined) return false
    const pointer = stageRef.current?.getPointerPosition()
    if (pointer === null || pointer === undefined) return true
    const width = Math.max(1, cropElement.transform.width * displayedArtboard.width)
    const height = Math.max(1, cropElement.transform.height * displayedArtboard.height)
    setCropSession((current) => current === null ? null : {
      ...current,
      draft: clampCrop({
        ...initial.crop,
        x: initial.crop.x - (pointer.x - initial.pointer.x) / width * initial.crop.width,
        y: initial.crop.y - (pointer.y - initial.pointer.y) / height * initial.crop.height
      })
    })
    return true
  }

  const finishCropDrag = (): boolean => {
    if (cropDragRef.current === null) return false
    cropDragRef.current = null
    return true
  }

  const beginMarquee = (event: KonvaEventObject<MouseEvent>): boolean => {
    const targetIsSurface = event.target === event.target.getStage() || event.target.name() === 'artboard-background'
    if (activeTool !== 'select' || event.evt.button !== 0 || !targetIsSurface) return false
    const pointer = stageRef.current?.getPointerPosition()
    if (pointer === null || pointer === undefined) return true
    setMarquee({
      start: pointer,
      current: pointer,
      additive: event.evt.shiftKey || event.evt.ctrlKey || event.evt.metaKey
    })
    return true
  }

  const continueMarquee = (): boolean => {
    if (marquee === null) return false
    const pointer = stageRef.current?.getPointerPosition()
    if (pointer !== null && pointer !== undefined) setMarquee({ ...marquee, current: pointer })
    return true
  }

  const finishMarquee = (): boolean => {
    if (marquee === null) return false
    const rect = rectFromPoints(marquee.start, marquee.current)
    if (rect.width < 3 && rect.height < 3) {
      if (!marquee.additive) setSelection([])
    } else {
      const hitIds = selectableElements
        .filter((element) => rectsIntersect(rect, rotatedElementBounds(element, displayedArtboard)))
        .map((element) => element.id)
      if (marquee.additive) {
        const next = new Set(selectedIds)
        for (const id of hitIds) {
          if (next.has(id)) next.delete(id)
          else next.add(id)
        }
        setSelection([...next])
      } else {
        setSelection(hitIds)
      }
    }
    setMarquee(null)
    return true
  }

  const handleElementSelect = (element: SceneElement, event: KonvaEventObject<MouseEvent | TouchEvent>): void => {
    event.cancelBubble = true
    const targetId = element.groupId !== null && element.groupId !== editingGroupId ? element.groupId : element.id
    if (!event.evt.altKey) {
      select(targetId, event.evt.shiftKey || event.evt.ctrlKey || event.evt.metaKey)
      return
    }
    const pointer = stageRef.current?.getPointerPosition()
    if (pointer === null || pointer === undefined) return
    const stack = selectableElements
      .filter((candidate) => rectContainsPoint(rotatedElementBounds(candidate, displayedArtboard), pointer))
      .sort((left, right) => right.zIndex - left.zIndex)
    if (stack.length === 0) return
    const currentIndex = stack.findIndex((candidate) => selectedIds.includes(candidate.id))
    const next = stack[(currentIndex + 1) % stack.length]
    if (next !== undefined) select(next.id, false)
  }

  const changeShapeKind = useCallback((element: Extract<SceneElement, { type: 'shape' }>, shape: Extract<SceneElement, { type: 'shape' }>['shape']): void => {
    cancelShapeRadiusGesture()
    cancelShapeLineGesture()
    if (element.shape === shape) return
    void updateElement(element.id, { shape }, `将“${element.name}”改为${shape === 'rectangle' ? '矩形' : shape === 'ellipse' ? '椭圆' : '直线'}`)
  }, [cancelShapeLineGesture, cancelShapeRadiusGesture, updateElement])

  const selectionDefaultsToRatio = (
    selectedElements.length > 0
    && selectedElements.every((element) => element.type === 'image' || element.type === 'text' || element.type === 'group')
  )
  const transformKeepsRatio = ratioLocked || (shiftPressed ? !selectionDefaultsToRatio : selectionDefaultsToRatio)
  const selectedImage = selectedElements.length === 1 && selectedElements[0]?.type === 'image' ? selectedElements[0] : null
  const transformerAnchors = shapeEditElement === undefined
    ? ['top-left', 'top-center', 'top-right', 'middle-left', 'middle-right', 'bottom-left', 'bottom-center', 'bottom-right']
    : [...shapeEditAnchors(shapeEditElement.shape)]
  let shapeEditOverlay: React.JSX.Element | null = null
  if (shapeEditElement !== undefined && shapeEditDisplayElement !== undefined) {
    const origin = {
      x: artboard.x + shapeEditDisplayElement.transform.x * artboard.width * zoom,
      y: artboard.y + shapeEditDisplayElement.transform.y * artboard.height * zoom
    }
    const width = shapeEditDisplayElement.transform.width * artboard.width * zoom
    const height = shapeEditDisplayElement.transform.height * artboard.height * zoom
    if (shapeEditElement.shape === 'line' && shapeLineEndpoints !== null) {
      shapeEditOverlay = (
        <Group name="shape-line-guides editor-chrome">
          <Line
            listening={false}
            points={[shapeLineEndpoints.start.x, shapeLineEndpoints.start.y, shapeLineEndpoints.end.x, shapeLineEndpoints.end.y]}
            stroke="rgba(55,107,255,.46)"
            strokeWidth={1}
            dash={[4, 5]}
          />
          {(['start', 'end'] as const).map((endpoint) => {
            const point = shapeLineEndpoints[endpoint]
            return (
              <Circle
                key={endpoint}
                name="shape-line-endpoint editor-chrome"
                x={point.x}
                y={point.y}
                radius={5.5}
                fill="#F9FBFE"
                stroke="#376BFF"
                strokeWidth={1.4}
                shadowColor="#172033"
                shadowBlur={5}
                shadowOpacity={.18}
                hitStrokeWidth={34}
                draggable
                onMouseDown={(event) => { event.cancelBubble = true }}
                onDragStart={(event) => {
                  event.cancelBubble = true
                  beginShapeLineGesture(shapeEditElement, endpoint)
                }}
                onDragMove={(event) => {
                  event.cancelBubble = true
                  updateShapeLineGesture(shapeEditElement.id, endpoint, event.target.position())
                }}
                onDragEnd={(event) => {
                  event.cancelBubble = true
                  finishShapeLineGesture(shapeEditElement)
                }}
              />
            )
          })}
        </Group>
      )
    } else if (shapeEditElement.shape === 'ellipse') {
      shapeEditOverlay = (
        <Group
          name="shape-axis-guides editor-chrome"
          listening={false}
          x={origin.x}
          y={origin.y}
          rotation={shapeEditDisplayElement.transform.rotation}
        >
          <Line points={[0, height / 2, width, height / 2]} stroke="rgba(55,107,255,.48)" strokeWidth={1} dash={[4, 5]} />
          <Line points={[width / 2, 0, width / 2, height]} stroke="rgba(55,107,255,.48)" strokeWidth={1} dash={[4, 5]} />
          <Circle x={width / 2} y={height / 2} radius={3.5} fill="#F9FBFE" stroke="#376BFF" strokeWidth={1.2} />
        </Group>
      )
    } else if (shapeEditElement.shape === 'rectangle') {
      const value = shapeRadiusDraft?.elementId === shapeEditElement.id ? shapeRadiusDraft.value : shapeEditElement.cornerRadius
      const radiusPixels = value * Math.min(width, height)
      const handlePosition = rotateLocalPoint(origin, { x: width - radiusPixels, y: radiusPixels }, shapeEditDisplayElement.transform.rotation)
      const radiusFromStagePoint = (point: CanvasPoint): { readonly value: number; readonly position: CanvasPoint } => {
        const local = unrotateStagePoint(origin, point, shapeEditDisplayElement.transform.rotation)
        const nextValue = Math.min(.5, Math.max(0, Math.min(width - local.x, local.y) / Math.max(.001, Math.min(width, height))))
        const nextRadius = nextValue * Math.min(width, height)
        return {
          value: Number(nextValue.toFixed(4)),
          position: rotateLocalPoint(origin, { x: width - nextRadius, y: nextRadius }, shapeEditDisplayElement.transform.rotation)
        }
      }
      shapeEditOverlay = (
        <Circle
          name="shape-radius-handle editor-chrome"
          data-testid="shape-radius-handle"
          x={handlePosition.x}
          y={handlePosition.y}
          radius={5.5}
          fill="#F9FBFE"
          stroke="#376BFF"
          strokeWidth={1.4}
          shadowColor="#172033"
          shadowBlur={5}
          shadowOpacity={.18}
          hitStrokeWidth={34}
          draggable
          dragBoundFunc={(position) => radiusFromStagePoint(position).position}
          onMouseDown={(event) => { event.cancelBubble = true }}
          onDragStart={(event) => {
            event.cancelBubble = true
            beginShapeRadiusGesture(shapeEditElement)
          }}
          onDragMove={(event) => {
            event.cancelBubble = true
            const next = radiusFromStagePoint(event.target.position())
            updateShapeRadiusGesture(shapeEditElement.id, next.value)
          }}
          onDragEnd={(event) => {
            event.cancelBubble = true
            finishShapeRadiusGesture(shapeEditElement)
          }}
        />
      )
    }
  }

  return (
    <div
      ref={containerRef}
      className={`canvas-stage${spacePressed || activeTool === 'hand' ? ' is-pan-ready' : ''}${isPanning ? ' is-panning' : ''}${cropSession !== null ? ' is-cropping' : ''}${shapeEditId !== null ? ' is-shape-editing' : ''}`}
      data-testid="canvas-stage"
      tabIndex={preview ? -1 : 0}
      aria-label={preview ? '作品预览' : '画布编辑区'}
      onPointerDownCapture={(event) => {
        if (!preview && event.target instanceof Element && event.target.closest('.konvajs-content')) {
          containerRef.current?.focus({ preventScroll: true })
        }
      }}
      data-scene-revision={scene.revision}
      data-shape-editing={shapeEditId ?? ''}
      data-shape-edit-kind={shapeEditElement?.shape ?? ''}
      data-shape-edit-anchors={shapeEditElement === undefined ? '' : shapeEditAnchors(shapeEditElement.shape).join(',')}
      data-shape-line-start-x={shapeLineEndpoints?.start.x ?? ''}
      data-shape-line-start-y={shapeLineEndpoints?.start.y ?? ''}
      data-shape-line-end-x={shapeLineEndpoints?.end.x ?? ''}
      data-shape-line-end-y={shapeLineEndpoints?.end.y ?? ''}
      data-blend-export-supported={unsupportedBlendModes.length === 0 ? 'true' : 'false'}
      data-artboard-x={displayedArtboard.x}
      data-artboard-y={displayedArtboard.y}
      data-artboard-width={displayedArtboard.width}
      data-artboard-height={displayedArtboard.height}
    >
      <Stage
        ref={stageRef}
        width={size.width}
        height={size.height}
        onWheel={(event) => {
          if (!preview) handleWheel(event)
        }}
        onMouseDown={(event) => {
          if (preview) {
            beginEphemeralAnnotation()
            return
          }
          if (event.evt.button === 1 || ((spacePressed || activeTool === 'hand') && event.evt.button === 0)) {
            event.evt.preventDefault()
            panningRef.current = true
            setIsPanning(true)
            panPointerRef.current = stageRef.current?.getPointerPosition() ?? null
            return
          }
          if (
            shapeEditId !== null &&
            (event.target === event.target.getStage() || event.target.name() === 'artboard-background')
          ) {
            cancelShapeRadiusGesture()
            cancelShapeLineGesture()
            setShapeEditId(null)
          }
          if (beginMask() || beginSketch()) return
          if (beginCropDrag() || beginMarquee(event)) return
        }}
        onMouseMove={() => {
          if (preview) {
            continueEphemeralAnnotation()
            return
          }
          if (continueMask() || continueSketch()) return
          if (continueCropDrag() || continueMarquee()) return
          if (!panningRef.current) return
          const pointer = stageRef.current?.getPointerPosition()
          const previous = panPointerRef.current
          if (pointer === null || pointer === undefined || previous === null) return
          const current = useWorkspaceStore.getState()
          setClampedViewport(current.zoom, {
            x: current.pan.x + pointer.x - previous.x,
            y: current.pan.y + pointer.y - previous.y
          })
          panPointerRef.current = pointer
        }}
        onMouseUp={() => {
          if (preview) {
            finishEphemeralAnnotation()
            return
          }
          if (finishMask() || finishSketch()) return
          if (finishCropDrag() || finishMarquee()) return
          panningRef.current = false
          setIsPanning(false)
          panPointerRef.current = null
        }}
        onMouseLeave={() => {
          finishEphemeralAnnotation()
          finishCropDrag()
          setMarquee(null)
          panningRef.current = false
          setIsPanning(false)
          panPointerRef.current = null
        }}
        onTouchStart={(event) => {
          if (!preview && event.target === event.target.getStage()) select(null)
        }}
        onDblClick={(event) => {
          if (!preview && editingGroupId !== null && event.target === event.target.getStage()) exitGroupEditing()
        }}
      >
        <Layer name="editor-chrome" listening={false}>
          <Rect
            x={artboard.x - 1}
            y={artboard.y - 1}
            width={artboard.width * zoom + 2}
            height={artboard.height * zoom + 2}
            fill={scene.canvas.transparent ? '#FFFFFF' : scene.canvas.backgroundColor}
            shadowColor="#1E2733"
            shadowBlur={34}
            shadowOffsetY={16}
            shadowOpacity={0.18}
            cornerRadius={3}
          />
        </Layer>
        <Layer>
          <Group
            id="artboard-content"
            x={artboard.x}
            y={artboard.y}
            scaleX={zoom}
            scaleY={zoom}
            clipX={0}
            clipY={0}
            clipWidth={artboard.width}
            clipHeight={artboard.height}
            listening={!preview}
          >
            <Rect
              name="artboard-background"
              width={artboard.width}
              height={artboard.height}
              fill={scene.canvas.transparent ? 'rgba(255,255,255,0)' : scene.canvas.backgroundColor}
              onDblClick={(event) => {
                if (editingGroupId === null) return
                event.cancelBubble = true
                exitGroupEditing()
              }}
            />
            {sortedElements.map((element) => (
              <ElementNode
                key={element.id}
                element={element}
                artboard={baseArtboard}
                zoom={zoom}
                onGuides={setGuides}
                onSelect={(event) => handleElementSelect(element, event)}
                onBeginDrag={beginElementDrag}
                onFinishDrag={finishElementDrag}
                isDragCommitOwner={isDragCommitOwner}
                isDragCancelled={() => dragCancelledRef.current}
                onRequestEdit={requestElementEdit}
                isInlineEditing={inlineTextId === element.id}
                viewportPanReady={spacePressed || activeTool === 'hand'}
                cropOverride={cropSession?.elementId === element.id ? cropSession.draft : undefined}
                shapeCornerRadiusOverride={shapeRadiusDraft?.elementId === element.id ? shapeRadiusDraft.value : undefined}
                shapeTransformOverride={shapeLineDraft?.elementId === element.id ? shapeLineDraft.transform : undefined}
                blendModeSupported={blendSupportByElement.get(element.id) !== false}
              />
            ))}
          </Group>
        </Layer>
        <Layer ref={auxiliaryLayerRef} name="editor-auxiliary" listening={!preview}>
          {!preview && marquee !== null && (() => {
            const rect = rectFromPoints(marquee.start, marquee.current)
            return (
              <Rect
                listening={false}
                x={rect.x}
                y={rect.y}
                width={rect.width}
                height={rect.height}
                fill="rgba(55, 107, 255, .08)"
                stroke="#5F8CF1"
                strokeWidth={1}
                dash={[5, 4]}
              />
            )
          })()}
          {!preview && guides.map((guide, index) => guide.axis === 'x' ? (
            <Line listening={false} key={`${guide.axis}-${index}`} points={[artboard.x + guide.position * zoom, artboard.y, artboard.x + guide.position * zoom, artboard.y + artboard.height * zoom]} stroke="#74A7E8" strokeWidth={1} dash={[4, 4]} />
          ) : (
            <Line listening={false} key={`${guide.axis}-${index}`} points={[artboard.x, artboard.y + guide.position * zoom, artboard.x + artboard.width * zoom, artboard.y + guide.position * zoom]} stroke="#74A7E8" strokeWidth={1} dash={[4, 4]} />
          ))}
          {!preview && draftStroke.length >= 4 && (
            <Line listening={false} points={draftStroke} stroke="#7893B2" strokeWidth={2.2} opacity={0.86} lineCap="round" lineJoin="round" tension={0.12} />
          )}
          {!preview && draftMask.length >= 4 && (
            <Line listening={false} points={draftMask} closed fill="rgba(255,124,114,.28)" stroke="#FF7C72" strokeWidth={2.2} opacity={0.96} lineCap="round" lineJoin="round" tension={0.12} />
          )}
          {preview && ephemeralAnnotationRegions.map((region) => (
            <Line
              key={region.id}
              points={region.points.flatMap((point) => [
                artboard.x + point.x * artboard.width * zoom,
                artboard.y + point.y * artboard.height * zoom
              ])}
              closed={region.closed}
              fill={ANNOTATION_COLORS[region.mode].fill}
              stroke={ANNOTATION_COLORS[region.mode].stroke}
              strokeWidth={Math.max(2, region.width * artboard.width * zoom)}
              dash={region.mode === 'protect' ? [3, 4] : region.mode === 'generate' ? [10, 4] : [7, 5]}
              lineCap="round"
              lineJoin="round"
              tension={ephemeralAnnotationTool === 'rect' ? 0 : 0.12}
            />
          ))}
          {preview && (ephemeralDraft.length >= 3 || ephemeralAnnotationPoints.length >= 3) && (() => {
            const points = ephemeralDraft.length >= 3 ? ephemeralDraft : ephemeralAnnotationPoints
            return (
              <Line
                points={points.flatMap((point) => [
                  artboard.x + point.x * artboard.width * zoom,
                  artboard.y + point.y * artboard.height * zoom
                ])}
                closed
                fill={ANNOTATION_COLORS[ephemeralAnnotationMode].fill}
                stroke={ANNOTATION_COLORS[ephemeralAnnotationMode].stroke}
                strokeWidth={2}
                dash={[7, 5]}
                lineCap="round"
                lineJoin="round"
                tension={ephemeralAnnotationTool === 'rect' ? 0 : 0.12}
              />
            )
          })()}
          {!preview && selectedIds.map((id) => scene.elements.find((element) => element.id === id)).filter((element): element is SceneElement => element?.locked === true).map((element) => (
            <Rect
              listening={false}
              key={`locked-${element.id}`}
              x={artboard.x + element.transform.x * artboard.width * zoom}
              y={artboard.y + element.transform.y * artboard.height * zoom}
              width={element.transform.width * artboard.width * zoom}
              height={element.transform.height * artboard.height * zoom}
              rotation={element.transform.rotation}
              stroke="#85B8F4"
              strokeWidth={1.5}
              dash={[4, 4]}
            />
          ))}
          {!preview && cropElement !== undefined && cropSession !== null && (
            <Group listening={false}>
              <Rect
                x={artboard.x + cropElement.transform.x * artboard.width * zoom}
                y={artboard.y + cropElement.transform.y * artboard.height * zoom}
                width={cropElement.transform.width * artboard.width * zoom}
                height={cropElement.transform.height * artboard.height * zoom}
                rotation={cropElement.transform.rotation}
                stroke="#F7F9FD"
                strokeWidth={2}
                dash={[8, 5]}
                shadowColor="#172033"
                shadowBlur={5}
                shadowOpacity={0.35}
              />
              <Label
                x={artboard.x + cropElement.transform.x * artboard.width * zoom + 10}
                y={artboard.y + cropElement.transform.y * artboard.height * zoom + 10}
              >
                <Tag fill="rgba(23, 32, 51, .78)" cornerRadius={7} />
                <Text text="拖动移动图片 · 滚轮缩放" fill="#FFFFFF" fontSize={11} padding={7} />
              </Label>
            </Group>
          )}
          {!preview && shapeEditOverlay}
          {!preview && (
            <Transformer
              ref={transformerRef}
              rotateEnabled
              enabledAnchors={transformerAnchors}
              keepRatio={transformKeepsRatio}
              shiftBehavior="default"
              centeredScaling={altPressed}
              rotationSnaps={shiftPressed ? Array.from({ length: 24 }, (_, index) => index * 15) : []}
              rotationSnapTolerance={6}
              flipEnabled={false}
              borderStroke="#73A7E5"
              borderStrokeWidth={1.2}
              anchorFill="#FCFDFE"
              anchorStroke="#5E91D0"
              anchorSize={11}
              anchorCornerRadius={5.5}
              rotateAnchorOffset={22}
              boundBoxFunc={(oldBox, nextBox) => nextBox.width < 12 || nextBox.height < 12 ? oldBox : nextBox}
              onTransformStart={() => {
                transformSessionRef.current = { scene: structuredClone(scene), ids: [...selectedIds] }
              }}
              onTransform={() => {
                const transformer = transformerRef.current
                if (transformer === null) return
                const box = transformer.getClientRect()
                const node = transformer.nodes()[0]
                setTransformHud({
                  x: box.x,
                  y: box.y,
                  width: box.width,
                  height: box.height,
                  rotation: selectedIds.length === 1 ? node?.rotation() ?? null : null,
                  left: Math.max(10, Math.min(size.width - 170, box.x + box.width / 2 - 80)),
                  top: Math.max(10, box.y - 38)
                })
              }}
              onTransformEnd={commitTransformSession}
            />
          )}
          {!preview && <Circle listening={false} x={artboard.x + 14} y={artboard.y + 14} radius={3} fill="rgba(255,255,255,.55)" />}
        </Layer>
      </Stage>
      {!preview && inlineText !== undefined && (
        <ImeSafeTextarea
          className="canvas-inline-text-editor"
          aria-label={`编辑文字：${inlineText.name}`}
          autoFocus
          value={inlineText.content}
          commitDelayMs={null}
          onCommit={(content) => {
            void updateElement(inlineText.id, { content }, `编辑“${inlineText.name}”`)
            setInlineTextId(null)
          }}
          onEscape={() => setInlineTextId(null)}
          onBlurComplete={() => setInlineTextId(null)}
          onKeyDown={(event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault()
              event.currentTarget.blur()
            }
          }}
          style={{
            left: artboard.x + inlineText.transform.x * artboard.width * zoom,
            top: artboard.y + inlineText.transform.y * artboard.height * zoom,
            width: inlineText.transform.width * artboard.width * zoom,
            height: inlineText.transform.height * artboard.height * zoom,
            transform: `rotate(${inlineText.transform.rotation}deg)`,
            transformOrigin: 'top left',
            fontFamily: inlineText.fontFamily,
            fontSize: Math.max(9, inlineText.fontSize * artboard.height / scene.canvas.outputHeight * zoom),
            fontWeight: inlineText.fontWeight,
            color: inlineText.fill,
            letterSpacing: `${inlineText.letterSpacing * artboard.height / scene.canvas.outputHeight * zoom}px`,
            lineHeight: inlineText.lineHeight,
            textAlign: inlineText.align === 'start' ? 'left' : inlineText.align === 'end' ? 'right' : inlineText.align,
            mixBlendMode: resolveBlendMode(inlineText)
          }}
        />
      )}
      {!preview && shapeEditElement !== undefined && shapeToolbarPosition !== null && (
        <div
          className={`shape-direct-toolbar glass-surface is-${shapeToolbarPosition.placement}`}
          role="toolbar"
          aria-label="形状直接编辑"
          data-testid="shape-direct-toolbar"
          style={{ left: shapeToolbarPosition.left, top: shapeToolbarPosition.top }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <div className="shape-kind-segment" role="group" aria-label="形态">
            <button type="button" className={shapeEditElement.shape === 'rectangle' ? 'is-active' : ''} aria-label="矩形" aria-pressed={shapeEditElement.shape === 'rectangle'} title="矩形" onClick={() => changeShapeKind(shapeEditElement, 'rectangle')}><Square size={15} /></button>
            <button type="button" className={shapeEditElement.shape === 'ellipse' ? 'is-active' : ''} aria-label="椭圆" aria-pressed={shapeEditElement.shape === 'ellipse'} title="椭圆" onClick={() => changeShapeKind(shapeEditElement, 'ellipse')}><CircleIcon size={15} /></button>
            <button type="button" className={shapeEditElement.shape === 'line' ? 'is-active' : ''} aria-label="直线" aria-pressed={shapeEditElement.shape === 'line'} title="直线" onClick={() => changeShapeKind(shapeEditElement, 'line')}><Minus size={16} /></button>
          </div>
          <span className="shape-toolbar-divider" aria-hidden="true" />
          <label className="shape-color-well" title="填充">
            <span>填充</span>
            <input aria-label="形状填充" type="color" value={shapeEditElement.fill} onChange={(event) => void updateElement(shapeEditElement.id, { fill: event.currentTarget.value }, `调整“${shapeEditElement.name}”填充`)} />
          </label>
          <label className={`shape-color-well${shapeEditElement.stroke === null ? ' is-off' : ''}`} title="描边">
            <span>描边</span>
            <input aria-label="形状描边" type="color" value={shapeEditElement.stroke ?? '#7890AA'} onChange={(event) => void updateElement(shapeEditElement.id, { stroke: event.currentTarget.value }, `调整“${shapeEditElement.name}”描边`)} />
          </label>
          <button type="button" className={`shape-stroke-toggle${shapeEditElement.stroke === null ? '' : ' is-active'}`} aria-label={shapeEditElement.stroke === null ? '启用描边' : '关闭描边'} aria-pressed={shapeEditElement.stroke !== null} onClick={() => void updateElement(shapeEditElement.id, { stroke: shapeEditElement.stroke === null ? '#7890AA' : null }, shapeEditElement.stroke === null ? '启用形状描边' : '关闭形状描边')}><Minus size={15} /></button>
          <span className="shape-toolbar-divider" aria-hidden="true" />
          <button type="button" className="shape-edit-done" aria-label="完成形状编辑" title="完成" onClick={() => {
            cancelShapeRadiusGesture()
            cancelShapeLineGesture()
            setShapeEditId(null)
          }}><Check size={16} /></button>
        </div>
      )}
      {!preview && unsupportedBlendModes.length > 0 && (
        <div className="canvas-blend-warning" role="status">
          当前图形环境无法精确呈现{unsupportedBlendModes.map(blendModeLabel).join('、')}；相关元素与导出已暂停，避免错误合成。
        </div>
      )}
      {!preview && transformHud !== null && (
        <div
          className="canvas-transform-hud glass-surface"
          aria-live="polite"
          style={{ left: transformHud.left, top: transformHud.top }}
        >
          <span>X {Math.round((transformHud.x - artboard.x) / zoom)}</span>
          <span>Y {Math.round((transformHud.y - artboard.y) / zoom)}</span>
          <span>W {Math.round(transformHud.width / zoom)}</span>
          <span>H {Math.round(transformHud.height / zoom)}</span>
          {transformHud.rotation !== null && <span>{Math.round(transformHud.rotation)}°</span>}
        </div>
      )}
      {!preview && shapeEditId === null && selectionBounds !== null && selectedElements.length > 0 && marquee === null && (
        <div
          className="canvas-context-bar glass-surface"
          role="toolbar"
          aria-label="所选元素快捷操作"
          style={{
            left: Math.max(12, Math.min(size.width - Math.min(572, size.width - 24), selectionBounds.x + selectionBounds.width / 2 - 280)),
            top: contextBarTop
          }}
        >
          {selectedElements.length === 1 && selectedElements[0]?.type === 'text' && inlineTextId === null && (
            <button type="button" onClick={() => requestElementEdit(selectedElements[0] as SceneElement)}><TypeIcon size={14} />编辑文字</button>
          )}
          {selectedElements.length === 1 && selectedElements[0]?.type === 'image' && cropSession === null && (
            <button type="button" onClick={() => requestElementEdit(selectedElements[0] as SceneElement)}><Crop size={14} />裁剪</button>
          )}
          {cropSession !== null ? (
            <>
              <button type="button" onClick={() => setCropSession((current) => current === null ? null : { ...current, draft: { ...current.original } })}>重置</button>
              <button type="button" onClick={() => setCropSession(null)}>取消</button>
              <button type="button" className="is-primary" onClick={() => {
                void updateElement(cropSession.elementId, { crop: cropSession.draft }, '裁剪图片')
                setCropSession(null)
              }}>完成</button>
            </>
          ) : (
            <>
              {selectedElements.length > 1 && <button type="button" title="水平居中" aria-label="水平居中" onClick={() => void alignSelection('center-x')}><AlignCenterHorizontal size={14} /></button>}
              {selectedElements.length > 1 && <button type="button" title="垂直居中" aria-label="垂直居中" onClick={() => void alignSelection('center-y')}><AlignCenterVertical size={14} /></button>}
              {selectedElements.length > 2 && <button type="button" aria-label="水平等距分布" onClick={() => void distributeSelection('horizontal')}>横向分布</button>}
              {selectedElements.length > 2 && <button type="button" aria-label="垂直等距分布" onClick={() => void distributeSelection('vertical')}>纵向分布</button>}
              {selectedImage !== null && <button type="button" onClick={() => void updateElement(selectedImage.id, { fit: selectedImage.fit === 'contain' ? 'cover' : 'contain' }, '切换图片适配')}>{selectedImage.fit === 'contain' ? '填满' : '完整'}</button>}
              {selectedElements.length > 1 && <button type="button" aria-label="编组所选元素" onClick={() => void groupSelection()}><GroupIcon size={14} />组合</button>}
              {selectedElements.length === 1 && selectedElements[0]?.type === 'group' && <button type="button" aria-label="解组所选元素" onClick={() => void ungroupSelection()}><Ungroup size={14} />解组</button>}
              <button type="button" title="复制副本" aria-label="复制副本" onClick={() => void duplicateSelection()}><Copy size={14} /></button>
              <button type="button" title={selectedElements.every((element) => element.locked) ? '解锁' : '锁定'} aria-label={selectedElements.every((element) => element.locked) ? '解锁' : '锁定'} onClick={() => {
                const locked = !selectedElements.every((element) => element.locked)
                void execute(locked ? '锁定元素' : '解锁元素', selectedElements.map((element) => ({ kind: 'element.update', elementId: element.id, changes: { locked } })))
              }}><Lock size={14} /></button>
              <button type="button" className="is-danger" title="删除" aria-label="删除" onClick={() => void deleteSelection()}><Trash2 size={14} /></button>
            </>
          )}
        </div>
      )}
    </div>
  )
})
