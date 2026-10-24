import { parseAspectRatio, type SceneElement } from '../../../domain'
import type { WorkspaceBootstrap } from '../../../shared/project'
import { createElementForTool } from '../canvas/element-factory'

export const OPENABLE_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const
type OpenableImageType = (typeof OPENABLE_IMAGE_TYPES)[number]

const MAX_IMAGE_BYTES = 100 * 1024 * 1024
const MIN_EDGE = 64
const MAX_EDGE = 16_384

function isOpenableImage(type: string): type is OpenableImageType {
  return (OPENABLE_IMAGE_TYPES as readonly string[]).includes(type)
}

/** The canvas takes the image's pixel size, within what a canvas allows. */
function canvasSizeFor(width: number, height: number): { readonly width: number; readonly height: number } {
  const down = Math.min(1, MAX_EDGE / Math.max(width, height))
  const up = Math.max(1, MIN_EDGE / Math.min(width * down, height * down))
  const scale = down * up
  return {
    width: Math.max(MIN_EDGE, Math.min(MAX_EDGE, Math.round(width * scale))),
    height: Math.max(MIN_EDGE, Math.min(MAX_EDGE, Math.round(height * scale)))
  }
}

/**
 * Opens an image the way Photoshop opens one: a new project named after the
 * file, whose canvas is the image's size, holding the image as its one
 * layer: 背景 when it is opaque, 图层 0 when it has transparency. The
 * project goes into the library without asking where. Returns the new
 * project's bootstrap, or null when creating it was cancelled.
 */
export async function createProjectFromImage(file: File): Promise<WorkspaceBootstrap | null> {
  if (!isOpenableImage(file.type)) throw new Error('请选择 PNG、JPEG 或 WebP 图片。')
  if (file.size <= 0 || file.size > MAX_IMAGE_BYTES) throw new Error('图片必须大于 0 字节且不超过 100 MB。')
  const created = await window.desktop.createProject({ suggestedName: file.name.replace(/\.[^.]+$/, '') || '图片创作' })
  if (created.cancelled || created.bootstrap === null) return null
  const bootstrap = created.bootstrap
  const asset = await window.desktop.importAsset({
    projectId: bootstrap.projectId,
    name: file.name,
    mimeType: file.type,
    bytes: new Uint8Array(await file.arrayBuffer())
  })
  const size = canvasSizeFor(asset.width, asset.height)
  const clampedRatio = Math.min(10, Math.max(0.1, size.width / size.height))
  const ratio = parseAspectRatio(`${clampedRatio}:1`).value ?? { width: 1, height: 1 }
  const canvas = {
    ...bootstrap.scene.canvas,
    aspectWidth: ratio.width,
    aspectHeight: ratio.height,
    outputWidth: size.width,
    outputHeight: size.height,
    transparent: asset.hasAlpha
  }
  const base = createElementForTool('image', bootstrap.scene, asset.id)
  if (base?.type !== 'image') return bootstrap
  const layer: SceneElement = {
    ...base,
    name: asset.hasAlpha ? '图层 0' : '背景',
    transform: { x: 0, y: 0, width: 1, height: 1, rotation: 0 },
    fit: 'cover',
    ...(asset.hasAlpha ? {} : { semanticRole: 'background' as const, referenceRole: 'composition' as const })
  }
  const mutation = await window.desktop.executeSceneCommands({
    projectId: bootstrap.projectId,
    expectedSceneRevision: bootstrap.scene.revision,
    batch: {
      id: globalThis.crypto.randomUUID(),
      origin: 'user',
      summary: `打开“${file.name}”`,
      commands: [{ kind: 'scene.set-canvas', canvas }, { kind: 'element.add', element: layer }]
    }
  })
  if (!mutation.ok) throw new Error(mutation.error.message)
  return {
    ...bootstrap,
    scene: mutation.receipt.state.scene,
    sceneSequence: mutation.receipt.state.sequence,
    canUndo: mutation.receipt.state.canUndo,
    canRedo: mutation.receipt.state.canRedo
  }
}
