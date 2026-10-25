import { ELEMENT_SCHEMA_VERSION, parseAspectRatio, type Canvas, type SceneCommand, type SceneElement } from '../../../domain'
import type { WorkspaceBootstrap } from '../../../shared/project'
import { createElementForTool } from '../canvas/element-factory'

export const OPENABLE_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const
/** What the open dialogs accept: the images and Photoshop documents. */
export const OPENABLE_FILE_ACCEPT = [...OPENABLE_IMAGE_TYPES, '.psd'].join(',')
type OpenableImageType = (typeof OPENABLE_IMAGE_TYPES)[number]

const MAX_IMAGE_BYTES = 100 * 1024 * 1024
const MAX_PSD_BYTES = 1024 * 1024 * 1024
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

/** A canvas the size of the opened document, its ratio as close as a canvas ratio can be. */
function canvasFor(current: Canvas, width: number, height: number, transparent: boolean): Canvas {
  const size = canvasSizeFor(width, height)
  const clampedRatio = Math.min(10, Math.max(0.1, size.width / size.height))
  const ratio = parseAspectRatio(`${clampedRatio}:1`).value ?? { width: 1, height: 1 }
  return { ...current, aspectWidth: ratio.width, aspectHeight: ratio.height, outputWidth: size.width, outputHeight: size.height, transparent }
}

/** Main's error, without Electron's "Error invoking remote method" wrapping. */
function plainMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : fallback
}

/**
 * Opens an image the way Photoshop opens one: a new project named after the
 * file, whose canvas is the image's size, holding the image as its one
 * layer: 背景 when it is opaque, 图层 0 when it has transparency. The
 * project goes into the library without asking where. Returns the new
 * project's bootstrap, or null when creating it was cancelled.
 */
export async function createProjectFromImage(file: File): Promise<WorkspaceBootstrap | null> {
  if (!isOpenableImage(file.type)) throw new Error('请选择 PNG、JPEG、WebP 图片或 PSD。')
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
  const canvas = canvasFor(bootstrap.scene.canvas, asset.width, asset.height, asset.hasAlpha)
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

export function isPsdFile(file: File): boolean {
  return file.type === 'image/vnd.adobe.photoshop' || file.name.toLowerCase().endsWith('.psd')
}

export function isOpenableFile(file: File): boolean {
  return isPsdFile(file) || isOpenableImage(file.type)
}

export interface OpenedProject {
  readonly bootstrap: WorkspaceBootstrap
  /** What the person should know about how the file came over, or null. */
  readonly notice: string | null
}

/**
 * Opens a PSD as a project: the canvas is the document's size and every
 * pixel layer becomes an image layer at its place, bottom to top, with its
 * name, opacity, visibility, blend mode and layer mask, inside a group when
 * it was in one. When something could not be carried over as it was, Photoshop's own
 * flattened image is added on top, hidden, to compare against. Returns null
 * when creating the project was cancelled.
 */
export async function createProjectFromPsd(file: File): Promise<OpenedProject | null> {
  if (file.size <= 0 || file.size > MAX_PSD_BYTES) throw new Error('PSD 必须大于 0 字节且不超过 1 GB。')
  let document
  try {
    document = await window.desktop.readPsd(new Uint8Array(await file.arrayBuffer()))
  } catch (error) {
    throw new Error(plainMessage(error, `没有读出“${file.name}”。`), { cause: error })
  }
  const created = await window.desktop.createProject({ suggestedName: file.name.replace(/\.[^.]+$/, '') || 'PSD 创作' })
  if (created.cancelled || created.bootstrap === null) return null
  const bootstrap = created.bootstrap
  const projectId = bootstrap.projectId
  const commands: SceneCommand[] = [{ kind: 'scene.set-canvas', canvas: canvasFor(bootstrap.scene.canvas, document.width, document.height, !document.opaqueBackground) }]
  const groupMembers = document.groups.map((): string[] => [])
  const place = (layer: { left: number, top: number, width: number, height: number }): SceneElement['transform'] => ({
    x: layer.left / document.width,
    y: layer.top / document.height,
    width: layer.width / document.width,
    height: layer.height / document.height,
    rotation: 0
  })
  for (const [index, layer] of document.layers.entries()) {
    const asset = await window.desktop.importAsset({ projectId, name: `${layer.name}.png`, mimeType: 'image/png', bytes: layer.png })
    const base = createElementForTool('image', bootstrap.scene, asset.id)
    if (base?.type !== 'image') continue
    const background = index === 0 && document.opaqueBackground
    const mask = layer.mask === null ? null : await window.desktop.importAsset({ projectId, name: `${layer.name} 蒙版.png`, mimeType: 'image/png', bytes: layer.mask.png })
    const element: SceneElement = {
      ...base,
      name: layer.name,
      transform: place(layer),
      fit: 'cover',
      opacity: layer.opacity,
      visible: layer.visible,
      blendMode: layer.blendMode,
      ...(background ? { semanticRole: 'background' as const, referenceRole: 'composition' as const } : {}),
      ...(mask === null || layer.mask === null ? {} : { mask: { assetId: mask.id, enabled: layer.mask.enabled } })
    }
    commands.push({ kind: 'element.add', element })
    if (layer.groupIndex !== null) groupMembers[layer.groupIndex]?.push(element.id)
  }
  for (const [index, group] of document.groups.entries()) {
    const childIds = groupMembers[index]!
    if (childIds.length === 0) continue
    commands.push({
      kind: 'element.group',
      elementIds: childIds,
      group: {
        id: globalThis.crypto.randomUUID(), version: ELEMENT_SCHEMA_VERSION, type: 'group', name: group.name, description: '',
        transform: { x: 0, y: 0, width: 1, height: 1, rotation: 0 }, zIndex: 0, opacity: 1, blendMode: 'normal',
        visible: group.visible, locked: false, groupId: null, semanticRole: 'composition', referencePolicy: 'include', childIds
      }
    })
  }
  if (document.composite !== null) {
    const asset = await window.desktop.importAsset({ projectId, name: `${file.name} 合成图.png`, mimeType: 'image/png', bytes: document.composite })
    const base = createElementForTool('image', bootstrap.scene, asset.id)
    if (base?.type === 'image') {
      commands.push({ kind: 'element.add', element: {
        ...base, name: 'PSD 原样（对照用）', transform: { x: 0, y: 0, width: 1, height: 1, rotation: 0 }, fit: 'cover', visible: false, referencePolicy: 'exclude'
      } })
    }
  }
  const mutation = await window.desktop.executeSceneCommands({
    projectId,
    expectedSceneRevision: bootstrap.scene.revision,
    batch: { id: globalThis.crypto.randomUUID(), origin: 'user', summary: `打开“${file.name}”`, commands }
  })
  if (!mutation.ok) throw new Error(mutation.error.message)
  const changes = [...document.approximations, ...document.keptAsPictures]
  const notice = changes.length === 0
    ? null
    : `已打开“${file.name}”，${document.layers.length} 个图层。${changes.join('；')}。${document.composite === null ? '' : '最上面隐藏的「PSD 原样（对照用）」是 Photoshop 保存的样子，可以打开眼睛对照。'}`
  return {
    bootstrap: { ...bootstrap, scene: mutation.receipt.state.scene, sceneSequence: mutation.receipt.state.sequence, canUndo: mutation.receipt.state.canUndo, canRedo: mutation.receipt.state.canRedo },
    notice
  }
}

/** Opens a PSD or an image as a new project. */
export async function openFileAsProject(file: File): Promise<OpenedProject | null> {
  if (isPsdFile(file)) return createProjectFromPsd(file)
  const bootstrap = await createProjectFromImage(file)
  return bootstrap === null ? null : { bootstrap, notice: null }
}
