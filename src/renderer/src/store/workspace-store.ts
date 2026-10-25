import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import {
  ELEMENT_SCHEMA_VERSION,
  type CommandBatchInput,
  type Scene,
  type SceneCommand,
  type SceneElement
} from '../../../domain'
import type { DesktopApi } from '../../../shared/desktop-api'
import type {
  SceneAuthorityState,
  SceneChangedEvent,
  SceneExecuteInput,
  SceneHistoryInput,
  SceneMutationResult
} from '../../../shared/scene-authority'
import { clearEphemeralAnnotation } from '../agent/ephemeral-annotation-store'
import { createBlankScene } from '../scene/create-blank-scene'
import { useCreationSessionStore } from './creation-session-store'
import { useGenerationDraftStore } from './generation-draft-store'
import { defaultProjectWorkContext, type ProjectWorkContext } from '../../../shared/project-work-context'
import { beginProjectHydration, endProjectHydration, projectGeneration } from './project-context-lifecycle'

export type WorkspaceView = 'conversation' | 'canvas' | 'generate'
export type CanvasTool = 'select' | 'hand' | 'image' | 'text' | 'sketch' | 'shape' | 'placeholder' | 'light' | 'mask' | 'eyedropper' | 'brush' | 'eraser' | 'bucket' | 'gradient'
  | 'marquee-rect' | 'marquee-ellipse' | 'lasso' | 'lasso-polygon' | 'object-select' | 'magic-wand'

export type PaintTool = 'brush' | 'eraser' | 'bucket' | 'gradient'
export type SelectionTool = 'marquee-rect' | 'marquee-ellipse' | 'lasso' | 'lasso-polygon' | 'object-select' | 'magic-wand'

export function isPaintTool(tool: CanvasTool): tool is PaintTool {
  return tool === 'brush' || tool === 'eraser' || tool === 'bucket' || tool === 'gradient'
}

export function isSelectionTool(tool: CanvasTool): tool is SelectionTool {
  return tool === 'marquee-rect' || tool === 'marquee-ellipse' || tool === 'lasso' || tool === 'lasso-polygon' || tool === 'object-select' || tool === 'magic-wand'
}

/** The tool each shared toolbar slot last held, which its key or slot brings back. */
export interface ToolMemory {
  readonly fill: 'bucket' | 'gradient'
  readonly annotate: 'sketch' | 'placeholder' | 'light' | 'mask'
  readonly marquee: 'marquee-rect' | 'marquee-ellipse'
  readonly lasso: 'lasso' | 'lasso-polygon'
  readonly wand: 'object-select' | 'magic-wand'
}

const TOOL_SLOTS: ReadonlyArray<readonly [keyof ToolMemory, readonly CanvasTool[]]> = [
  ['fill', ['bucket', 'gradient']],
  ['annotate', ['sketch', 'placeholder', 'light', 'mask']],
  ['marquee', ['marquee-rect', 'marquee-ellipse']],
  ['lasso', ['lasso', 'lasso-polygon']],
  ['wand', ['object-select', 'magic-wand']]
]

function rememberTool(memory: ToolMemory, tool: CanvasTool): ToolMemory {
  const slot = TOOL_SLOTS.find(([, tools]) => tools.includes(tool))
  return slot === undefined ? memory : { ...memory, [slot[0]]: tool }
}

/*
 * What Ctrl+Z steps back through, in order: scene batches, which Main keeps,
 * and selection changes, which stay in the Renderer, as Photoshop's history
 * holds both. A step is noted when it happens; undo takes the newest.
 */
type HistoryStep = 'scene' | 'selection'
const undoSteps: HistoryStep[] = []
const redoSteps: HistoryStep[] = []
/** Batches this window sent, so their change events are not counted twice. */
const ownBatchIds = new Set<string>()
const MAX_HISTORY_STEPS = 500
let selectionHistory: { undo(): boolean; redo(): boolean } | null = null

export function registerSelectionHistory(history: { undo(): boolean; redo(): boolean } | null): void {
  selectionHistory = history
}

/** Whether the next undo or redo is a selection step, which Main's history cannot know of, for the buttons. */
function showHistorySteps(): void {
  const selectionUndo = undoSteps.at(-1) === 'selection'
  const selectionRedo = redoSteps.at(-1) === 'selection'
  const state = useWorkspaceStore.getState()
  if (state.selectionUndo !== selectionUndo || state.selectionRedo !== selectionRedo) useWorkspaceStore.setState({ selectionUndo, selectionRedo })
}

function noteStep(step: HistoryStep): void {
  undoSteps.push(step)
  if (undoSteps.length > MAX_HISTORY_STEPS) undoSteps.splice(0, undoSteps.length - MAX_HISTORY_STEPS)
  redoSteps.length = 0
  showHistorySteps()
}

/** A selection change went into the selection's own history; Ctrl+Z reaches it in turn. */
export function noteSelectionStep(): void {
  noteStep('selection')
}

/** The selection's history was dropped, with the canvas it was made on. */
export function forgetSelectionSteps(): void {
  for (const steps of [undoSteps, redoSteps]) {
    const kept = steps.filter((step) => step !== 'selection')
    steps.splice(0, steps.length, ...kept)
  }
  showHistorySteps()
}

function clearHistorySteps(): void {
  undoSteps.length = 0
  redoSteps.length = 0
  showHistorySteps()
}

/** Each painting tool keeps its own options, as in Photoshop. Sizes are in canvas pixels. */
export interface PaintSettings {
  readonly brush: { readonly size: number; readonly hardness: number; readonly opacity: number; readonly flow: number }
  readonly eraser: { readonly size: number; readonly hardness: number; readonly opacity: number; readonly flow: number }
  readonly bucket: { readonly tolerance: number; readonly contiguous: boolean; readonly opacity: number }
  readonly gradient: { readonly shape: 'linear' | 'radial'; readonly opacity: number }
}

export const DEFAULT_PAINT_SETTINGS: PaintSettings = {
  brush: { size: 24, hardness: 0.8, opacity: 1, flow: 1 },
  eraser: { size: 40, hardness: 0.8, opacity: 1, flow: 1 },
  bucket: { tolerance: 32, contiguous: true, opacity: 1 },
  gradient: { shape: 'linear', opacity: 1 }
}

/** Photoshop's defaults, which D restores. */
export const DEFAULT_FOREGROUND_COLOR = '#000000'
export const DEFAULT_BACKGROUND_COLOR = '#FFFFFF'

export interface WorkspaceSceneClient {
  execute(input: SceneExecuteInput): Promise<SceneMutationResult>
  undo(input: SceneHistoryInput): Promise<SceneMutationResult>
  redo(input: SceneHistoryInput): Promise<SceneMutationResult>
  markBatchUndone(batchId: string): Promise<void>
}

interface WorkspaceState {
  projectSession: number
  scene: Scene
  sceneSequence: number
  projectName: string
  selectedIds: string[]
  editingGroupId: string | null
  activeView: WorkspaceView
  activeTool: CanvasTool
  /** The foreground and background colours, as in Photoshop: the eyedropper sets them and Alt or Ctrl+Backspace fills with them. */
  foregroundColor: string
  backgroundColor: string
  paintSettings: PaintSettings
  toolMemory: ToolMemory
  inspectorOpen: boolean
  inspectorTab: 'layers' | 'properties'
  zoom: number
  pan: { x: number; y: number }
  transformRatioLocked: boolean
  geometryUnit: 'px' | 'percent'
  canUndo: boolean
  canRedo: boolean
  /** The next undo or redo is a selection change, so the button is on whatever Main's history holds. */
  selectionUndo: boolean
  selectionRedo: boolean
  mutationPending: boolean
  sceneProblem: string | null
  workContextProblem: string | null
  setActiveView(view: WorkspaceView): void
  setProjectName(name: string): void
  setActiveTool(tool: CanvasTool): void
  setForegroundColor(color: string): void
  setBackgroundColor(color: string): void
  swapColors(): void
  resetColors(): void
  setPaintSettings<Tool extends PaintTool>(tool: Tool, changes: Partial<PaintSettings[Tool]>): void
  setInspectorOpen(open: boolean): void
  setInspectorTab(tab: 'layers' | 'properties'): void
  enterGroupEditing(groupId: string): void
  exitGroupEditing(): void
  select(id: string | null, additive?: boolean): void
  setSelection(ids: readonly string[]): void
  setViewport(zoom: number, pan: { x: number; y: number }): void
  setTransformRatioLocked(locked: boolean): void
  setGeometryUnit(unit: 'px' | 'percent'): void
  fitViewport(): void
  /**
   * Sends one batch after the changes queued before it. Commands that
   * depend on those changes are worked out from the scene as it is then;
   * null sends nothing.
   */
  execute(summary: string, commands: readonly SceneCommand[] | ((scene: Scene) => readonly SceneCommand[] | null)): Promise<boolean>
  updateElement(id: string, changes: Record<string, unknown>, summary?: string): Promise<boolean>
  deleteSelection(): Promise<boolean>
  /** Copies the selected layers in place, each directly above its source, or moved by offset (Alt+drag). */
  duplicateSelection(offset?: { readonly x: number; readonly y: number }): Promise<boolean>
  copySelection(): boolean
  cutSelection(): Promise<boolean>
  pasteSelection(): Promise<boolean>
  reorderElement(id: string, toIndex: number): Promise<boolean>
  groupSelection(): Promise<boolean>
  ungroupSelection(): Promise<boolean>
  alignSelection(axis: 'left' | 'center-x' | 'right' | 'top' | 'center-y' | 'bottom'): Promise<boolean>
  distributeSelection(axis: 'horizontal' | 'vertical'): Promise<boolean>
  addElement(element: SceneElement, summary: string): Promise<boolean>
  undo(): Promise<void>
  undoBatch(batchId: string): Promise<boolean>
  redo(): Promise<void>
}

let sceneClientOverride: WorkspaceSceneClient | null = null
let mutationChain: Promise<void> = Promise.resolve()
let unsubscribeSceneEvents: (() => void) | null = null
let workspaceClipboard: SceneElement[] = []

function createId(): string {
  return globalThis.crypto.randomUUID()
}

function cloneElementForClipboard(element: SceneElement, idMap: ReadonlyMap<string, string>, sceneLength: number, index: number): SceneElement {
  const clone = structuredClone(element)
  clone.id = idMap.get(element.id) ?? createId()
  clone.name = `${element.name} 副本`
  clone.groupId = element.groupId === null ? null : idMap.get(element.groupId) ?? null
  clone.transform = { ...element.transform, x: element.transform.x + 0.02, y: element.transform.y + 0.02 }
  clone.zIndex = sceneLength + index
  if (clone.type === 'sketch') clone.strokes = clone.strokes.map((stroke) => ({ ...stroke, id: createId() }))
  if (clone.type === 'mask') {
    clone.paths = clone.paths.map((path) => ({ ...path, id: createId() }))
    clone.targetElementId = idMap.get(clone.targetElementId) ?? clone.targetElementId
  }
  if (clone.type === 'light') clone.targetElementIds = clone.targetElementIds.map((id) => idMap.get(id) ?? id)
  if (clone.type === 'group') clone.childIds = clone.childIds.map((id) => idMap.get(id) ?? id)
  return clone
}

function copyableSelection(scene: Scene, selectedIds: readonly string[]): SceneElement[] {
  const included = new Set<string>()
  for (const id of selectedIds) {
    const element = scene.elements.find((candidate) => candidate.id === id)
    if (element === undefined || element.locked) continue
    included.add(element.id)
    if (element.type === 'group') element.childIds.forEach((childId) => included.add(childId))
  }
  return scene.elements.filter((element) => included.has(element.id)).map((element) => {
    const clone = structuredClone(element)
    if (clone.groupId !== null && !included.has(clone.groupId)) clone.groupId = null
    return clone
  })
}

function desktopClient(): WorkspaceSceneClient | null {
  if (sceneClientOverride !== null) return sceneClientOverride
  const desktop = window.desktop as Partial<DesktopApi> | undefined
  if (
    desktop?.executeSceneCommands === undefined
    || desktop.undoScene === undefined
    || desktop.redoScene === undefined
  ) return null
  return {
    execute: (input) => desktop.executeSceneCommands!(input),
    undo: (input) => desktop.undoScene!(input),
    redo: (input) => desktop.redoScene!(input),
    markBatchUndone: async (batchId) => {
      await desktop.markActivityBatchUndone?.(batchId)
    }
  }
}

function enqueueMutation<T>(operation: (isCurrent: () => boolean) => Promise<T>): Promise<T | false> {
  const owner = useWorkspaceStore.getState().scene.projectId
  const generation = projectGeneration()
  const isCurrent = (): boolean => projectGeneration() === generation && useWorkspaceStore.getState().scene.projectId === owner
  const scopedOperation = (): Promise<T | false> => isCurrent() ? operation(isCurrent) : Promise.resolve(false)
  const result = mutationChain.then(scopedOperation, scopedOperation)
  mutationChain = result.then(() => undefined, () => undefined)
  return result
}

export function groupBoundsForChildTransforms(
  scene: Scene,
  groupId: string,
  transformOverrides: ReadonlyMap<string, SceneElement['transform']>
): SceneElement['transform'] | null {
  const group = scene.elements.find((element) => element.id === groupId)
  if (group?.type !== 'group') return null
  const children = group.childIds
    .map((id) => scene.elements.find((element) => element.id === id))
    .filter((element): element is SceneElement => element !== undefined)
  if (children.length === 0) return null
  const transforms = children.map((element) => transformOverrides.get(element.id) ?? element.transform)
  const left = Math.min(...transforms.map((transform) => transform.x))
  const top = Math.min(...transforms.map((transform) => transform.y))
  const right = Math.max(...transforms.map((transform) => transform.x + transform.width))
  const bottom = Math.max(...transforms.map((transform) => transform.y + transform.height))
  return { x: left, y: top, width: right - left, height: bottom - top, rotation: 0 }
}

function groupBoundsAfterChildTransform(
  scene: Scene,
  groupId: string,
  childId: string,
  childTransform: SceneElement['transform']
): SceneElement['transform'] | null {
  return groupBoundsForChildTransforms(scene, groupId, new Map([[childId, childTransform]]))
}

function applyAuthorityState(state: SceneAuthorityState): void {
  if (state.scene.projectId !== useWorkspaceStore.getState().scene.projectId) return
  useWorkspaceStore.setState((current) => ({
    ...current,
    scene: state.scene,
    sceneSequence: Math.max(current.sceneSequence, state.sequence),
    selectedIds: current.selectedIds.filter((id) => state.scene.elements.some((element) => element.id === id)),
    editingGroupId: state.scene.elements.some((element) => element.id === current.editingGroupId && element.type === 'group')
      ? current.editingGroupId
      : null,
    canUndo: state.canUndo,
    canRedo: state.canRedo
  }))
}

function applyMutationResult(result: SceneMutationResult): boolean {
  const scene = result.ok ? result.receipt.state.scene : result.state.scene
  if (scene.projectId !== useWorkspaceStore.getState().scene.projectId) return false
  if (result.ok) {
    applyAuthorityState(result.receipt.state)
    useWorkspaceStore.setState({ sceneProblem: null })
    return true
  }
  applyAuthorityState(result.state)
  useWorkspaceStore.setState({ sceneProblem: result.error.message })
  return false
}

function bindSceneEvents(): void {
  unsubscribeSceneEvents?.()
  unsubscribeSceneEvents = null
  const desktop = window.desktop as Partial<DesktopApi> | undefined
  if (desktop?.onSceneChanged === undefined) return
  unsubscribeSceneEvents = desktop.onSceneChanged((event: SceneChangedEvent) => {
    const current = useWorkspaceStore.getState()
    if (event.projectId !== current.scene.projectId || event.state.sequence <= current.sceneSequence) return
    // A batch made elsewhere (the Agent, a placed result) is the newest step for Ctrl+Z; this window's own are noted when they return.
    if (event.action === 'execute' && event.batch !== null && !ownBatchIds.has(event.batch.id)) noteStep('scene')
    applyAuthorityState(event.state)
  })
}

export const useWorkspaceStore = create<WorkspaceState>()(
  immer((set, get) => ({
    projectSession: 0,
    scene: createBlankScene(),
    sceneSequence: 0,
    projectName: 'Untitled',
    selectedIds: [],
    editingGroupId: null,
    activeView: 'canvas',
    activeTool: 'select',
    foregroundColor: DEFAULT_FOREGROUND_COLOR,
    backgroundColor: DEFAULT_BACKGROUND_COLOR,
    paintSettings: DEFAULT_PAINT_SETTINGS,
    toolMemory: { fill: 'bucket', annotate: 'sketch', marquee: 'marquee-rect', lasso: 'lasso', wand: 'object-select' },
    inspectorOpen: true,
    inspectorTab: 'layers',
    zoom: 1,
    pan: { x: 0, y: 0 },
    transformRatioLocked: false,
    geometryUnit: 'px',
    canUndo: false,
    canRedo: false,
    selectionUndo: false,
    selectionRedo: false,
    mutationPending: false,
    sceneProblem: null,
    workContextProblem: null,
    setActiveView: (activeView) => set({ activeView }),
    setProjectName: (projectName) => set({ projectName }),
    setActiveTool: (activeTool) => set((state) => ({ activeTool, toolMemory: rememberTool(state.toolMemory, activeTool) })),
    setForegroundColor: (foregroundColor) => set({ foregroundColor }),
    setBackgroundColor: (backgroundColor) => set({ backgroundColor }),
    swapColors: () => set((state) => ({ foregroundColor: state.backgroundColor, backgroundColor: state.foregroundColor })),
    resetColors: () => set({ foregroundColor: DEFAULT_FOREGROUND_COLOR, backgroundColor: DEFAULT_BACKGROUND_COLOR }),
    setPaintSettings: (tool, changes) => set((state) => ({ paintSettings: { ...state.paintSettings, [tool]: { ...state.paintSettings[tool], ...changes } } })),
    setInspectorOpen: (inspectorOpen) => set({ inspectorOpen }),
    setInspectorTab: (inspectorTab) => set({ inspectorTab }),
    enterGroupEditing: (groupId) => set((state) => {
      const group = state.scene.elements.find((element) => element.id === groupId)
      if (group?.type !== 'group' || group.locked) return
      state.editingGroupId = group.id
    }),
    exitGroupEditing: () => set((state) => {
      const groupId = state.editingGroupId
      state.editingGroupId = null
      state.selectedIds = groupId !== null && state.scene.elements.some((element) => element.id === groupId && element.type === 'group')
        ? [groupId]
        : []
    }),
    select: (id, additive = false) =>
      set((state) => {
        if (id === null) {
          state.selectedIds = []
          return
        }
        const element = state.scene.elements.find((candidate) => candidate.id === id)
        if (element?.groupId !== null && element?.groupId !== undefined) {
          const group = state.scene.elements.find((candidate) => candidate.id === element.groupId)
          if (group?.type === 'group' && !group.locked) state.editingGroupId = group.id
        } else if (element?.type !== 'group' || element.id !== state.editingGroupId) {
          state.editingGroupId = null
        }
        if (!additive) {
          state.selectedIds = [id]
          return
        }
        const index = state.selectedIds.indexOf(id)
        if (index === -1) state.selectedIds.push(id)
        else state.selectedIds.splice(index, 1)
      }),
    setSelection: (ids) => set((state) => {
      state.selectedIds = [...ids]
      const selected = ids.map((id) => state.scene.elements.find((element) => element.id === id)).filter((element): element is SceneElement => element !== undefined)
      const groupIds = [...new Set(selected.map((element) => element.groupId).filter((groupId): groupId is string => groupId !== null))]
      state.editingGroupId = groupIds.length === 1 && selected.every((element) => element.groupId === groupIds[0]) ? groupIds[0]! : null
    }),
    setViewport: (zoom, pan) => set({ zoom: Math.min(32, Math.max(0.05, zoom)), pan }),
    setTransformRatioLocked: (transformRatioLocked) => set({ transformRatioLocked }),
    setGeometryUnit: (geometryUnit) => set({ geometryUnit }),
    fitViewport: () => set({ zoom: 1, pan: { x: 0, y: 0 } }),
    execute: (summary, commands) => enqueueMutation(async (isCurrent) => {
      const client = desktopClient()
      if (client === null) {
        set({ sceneProblem: 'Main SceneService 不可用，画布未修改。' })
        return false
      }
      const current = get().scene
      const list = typeof commands === 'function' ? commands(current) : commands
      if (list === null) return false
      set({ mutationPending: true })
      try {
        const batch: CommandBatchInput = {
          id: createId(),
          origin: 'user',
          summary,
          commands: [...list]
        }
        ownBatchIds.add(batch.id)
        if (ownBatchIds.size > MAX_HISTORY_STEPS) ownBatchIds.delete(ownBatchIds.values().next().value!)
        const result = await client.execute({ projectId: current.projectId, expectedSceneRevision: current.revision, batch })
        const applied = isCurrent() && applyMutationResult(result)
        if (applied) noteStep('scene')
        return applied
      } catch (error) {
        if (isCurrent()) set({ sceneProblem: error instanceof Error ? error.message : '画布修改没有完成。' })
        return false
      } finally {
        if (isCurrent()) set({ mutationPending: false })
      }
    }),
    updateElement: (id, changes, summary = '调整元素') => {
      const scene = get().scene
      const element = scene.elements.find((candidate) => candidate.id === id)
      const transformChanges = typeof changes.transform === 'object' && changes.transform !== null
        ? changes.transform as Partial<SceneElement['transform']>
        : null
      if (element?.groupId !== null && element?.groupId !== undefined && transformChanges !== null) {
        const childTransform = { ...element.transform, ...transformChanges }
        const groupTransform = groupBoundsAfterChildTransform(scene, element.groupId, element.id, childTransform)
        if (groupTransform !== null) {
          return get().execute(summary, [
            { kind: 'element.update', elementId: id, changes },
            { kind: 'element.update', elementId: element.groupId, changes: { transform: groupTransform } }
          ])
        }
      }
      return get().execute(summary, [{ kind: 'element.update', elementId: id, changes }])
    },
    deleteSelection: async () => {
      const ids = get().selectedIds
      if (ids.length === 0) return false
      const scene = get().scene
      const selected = new Set(ids)
      const groupChildren = new Set(
        scene.elements
          .filter((element) => element.type === 'group' && selected.has(element.id))
          .flatMap((element) => (element.type === 'group' ? element.childIds : []))
      )
      const roots = ids.filter((id) => !groupChildren.has(id))
      return get().execute(`删除 ${roots.length} 个元素`, roots.map((elementId) => ({ kind: 'element.remove', elementId })))
    },
    duplicateSelection: async (offset = { x: 0, y: 0 }) => {
      const scene = get().scene
      const roots = get().selectedIds
        .map((id) => scene.elements.find((element) => element.id === id))
        .filter((element): element is SceneElement => element !== undefined && element.groupId === null && !element.locked)
      if (roots.length === 0) return false
      const commands: SceneCommand[] = []
      const newRootIds: string[] = []
      const placements: { readonly cloneId: string; readonly sourceIndex: number }[] = []
      const cloneOf = (source: SceneElement): SceneElement => {
        const clone = structuredClone(source)
        clone.id = createId()
        clone.name = `${source.name} 副本`
        clone.groupId = null
        clone.transform = { ...clone.transform, x: clone.transform.x + offset.x, y: clone.transform.y + offset.y }
        clone.zIndex = scene.elements.length + commands.length
        if (clone.type === 'sketch') clone.strokes = clone.strokes.map((stroke) => ({ ...stroke, id: createId() }))
        if (clone.type === 'mask') clone.paths = clone.paths.map((path) => ({ ...path, id: createId() }))
        return clone
      }
      for (const root of roots) {
        if (root.type === 'group') {
          const groupId = createId()
          const childIds: string[] = []
          for (const childId of root.childIds) {
            const child = scene.elements.find((element) => element.id === childId)
            if (child === undefined) continue
            const clone = cloneOf(child)
            childIds.push(clone.id)
            commands.push({ kind: 'element.add', element: clone })
          }
          if (childIds.length > 0) {
            commands.push({
              kind: 'element.group',
              elementIds: childIds,
              group: { ...structuredClone(root), id: groupId, name: `${root.name} 副本`, childIds, groupId: null, zIndex: 0 }
            })
            newRootIds.push(groupId)
          }
          continue
        }
        const clone = cloneOf(root)
        commands.push({ kind: 'element.add', element: clone })
        newRootIds.push(clone.id)
        placements.push({ cloneId: clone.id, sourceIndex: root.zIndex })
      }
      // As in Photoshop each copy sits directly above its source. Going from the
      // highest source down keeps the lower sources' indices valid.
      for (const { cloneId, sourceIndex } of [...placements].sort((left, right) => right.sourceIndex - left.sourceIndex)) {
        commands.push({ kind: 'element.reorder', elementId: cloneId, toIndex: sourceIndex + 1 })
      }
      if (commands.length === 0 || !await get().execute(`复制 ${newRootIds.length} 个元素`, commands)) return false
      get().setSelection(newRootIds)
      return true
    },
    copySelection: () => {
      const copied = copyableSelection(get().scene, get().selectedIds)
      if (copied.length === 0) return false
      workspaceClipboard = copied
      return true
    },
    cutSelection: async () => {
      if (!get().copySelection()) return false
      return get().deleteSelection()
    },
    pasteSelection: async () => {
      if (workspaceClipboard.length === 0) return false
      const scene = get().scene
      const idMap = new Map(workspaceClipboard.map((element) => [element.id, createId()]))
      const clones = workspaceClipboard.map((element, index) => cloneElementForClipboard(element, idMap, scene.elements.length, index))
      const commands: SceneCommand[] = []
      const newRootIds: string[] = []
      for (const clone of clones.filter((element) => element.type !== 'group')) {
        const original = workspaceClipboard.find((element) => idMap.get(element.id) === clone.id)
        if (original?.groupId === null) newRootIds.push(clone.id)
        commands.push({ kind: 'element.add', element: { ...clone, groupId: null } })
      }
      for (const group of clones.filter((element): element is Extract<SceneElement, { type: 'group' }> => element.type === 'group')) {
        commands.push({
          kind: 'element.group',
          elementIds: [...group.childIds],
          group: { ...group, groupId: null }
        })
        newRootIds.push(group.id)
      }
      if (commands.length === 0 || !await get().execute(`粘贴 ${newRootIds.length} 个元素`, commands)) return false
      get().setSelection(newRootIds)
      return true
    },
    reorderElement: (id, toIndex) => get().execute('调整图层顺序', [{ kind: 'element.reorder', elementId: id, toIndex }]),
    groupSelection: async () => {
      const scene = get().scene
      const ids = get().selectedIds.filter((id) => {
        const element = scene.elements.find((candidate) => candidate.id === id)
        return element !== undefined && element.type !== 'group' && !element.locked && element.groupId === null
      })
      if (ids.length < 2) return false
      const groupId = createId()
      const group: SceneElement = {
        id: groupId,
        version: ELEMENT_SCHEMA_VERSION,
        type: 'group',
        name: '组合',
        description: '',
        transform: { x: 0, y: 0, width: 1, height: 1, rotation: 0 },
        zIndex: 0,
        opacity: 1,
        blendMode: 'normal',
        visible: true,
        locked: false,
        groupId: null,
        semanticRole: 'composition',
        referencePolicy: 'include',
        childIds: [...ids]
      }
      const success = await get().execute('组合元素', [{ kind: 'element.group', group, elementIds: [...ids] }])
      if (success) get().setSelection([groupId])
      return success
    },
    ungroupSelection: async () => {
      const group = get().scene.elements.find(
        (element) => get().selectedIds.includes(element.id) && element.type === 'group'
      )
      if (group?.type !== 'group') return false
      const childIds = [...group.childIds]
      const success = await get().execute('取消组合', [{ kind: 'element.ungroup', groupId: group.id }])
      if (success) get().setSelection(childIds)
      return success
    },
    alignSelection: async (axis) => {
      const elements = get().scene.elements.filter(
        (element) => get().selectedIds.includes(element.id) && element.type !== 'group' && !element.locked
      )
      if (elements.length < 2) return false
      const left = Math.min(...elements.map((element) => element.transform.x))
      const right = Math.max(...elements.map((element) => element.transform.x + element.transform.width))
      const top = Math.min(...elements.map((element) => element.transform.y))
      const bottom = Math.max(...elements.map((element) => element.transform.y + element.transform.height))
      const commands: SceneCommand[] = elements.map((element) => {
        const transform = { ...element.transform }
        if (axis === 'left') transform.x = left
        if (axis === 'center-x') transform.x = (left + right - transform.width) / 2
        if (axis === 'right') transform.x = right - transform.width
        if (axis === 'top') transform.y = top
        if (axis === 'center-y') transform.y = (top + bottom - transform.height) / 2
        if (axis === 'bottom') transform.y = bottom - transform.height
        return { kind: 'element.update', elementId: element.id, changes: { transform } }
      })
      return get().execute('对齐元素', commands)
    },
    distributeSelection: async (axis) => {
      const elements = get().scene.elements
        .filter((element) => get().selectedIds.includes(element.id) && element.type !== 'group' && !element.locked)
        .sort((a, b) =>
          axis === 'horizontal'
            ? a.transform.x + a.transform.width / 2 - (b.transform.x + b.transform.width / 2)
            : a.transform.y + a.transform.height / 2 - (b.transform.y + b.transform.height / 2)
        )
      if (elements.length < 3) return false
      const first = elements[0]
      const last = elements.at(-1)
      if (first === undefined || last === undefined) return false
      const firstCenter = axis === 'horizontal'
        ? first.transform.x + first.transform.width / 2
        : first.transform.y + first.transform.height / 2
      const lastCenter = axis === 'horizontal'
        ? last.transform.x + last.transform.width / 2
        : last.transform.y + last.transform.height / 2
      const step = (lastCenter - firstCenter) / (elements.length - 1)
      const commands: SceneCommand[] = elements.slice(1, -1).map((element, index) => {
        const transform = { ...element.transform }
        const center = firstCenter + step * (index + 1)
        if (axis === 'horizontal') transform.x = center - transform.width / 2
        else transform.y = center - transform.height / 2
        return { kind: 'element.update', elementId: element.id, changes: { transform } }
      })
      return get().execute('分布元素', commands)
    },
    addElement: async (element, summary) => {
      const success = await get().execute(summary, [{ kind: 'element.add', element }])
      if (success) get().setSelection([element.id])
      return success
    },
    undo: async () => { await enqueueMutation(async (isCurrent) => {
      if (undoSteps.at(-1) === 'selection') {
        undoSteps.pop()
        if (selectionHistory?.undo() === true) redoSteps.push('selection')
        showHistorySteps()
        return
      }
      const client = desktopClient()
      if (client === null) return
      set({ mutationPending: true })
      try {
        const result = await client.undo({ projectId: get().scene.projectId, expectedSceneRevision: get().scene.revision, batchId: null })
        const applied = isCurrent() && applyMutationResult(result)
        if (applied && result.ok) {
          if (undoSteps.at(-1) === 'scene') undoSteps.pop()
          redoSteps.push('scene')
          showHistorySteps()
        }
        if (applied && result.ok && result.receipt.affectedBatchId !== null) {
          await client.markBatchUndone(result.receipt.affectedBatchId).catch(() => undefined)
        }
      } finally {
        if (isCurrent()) set({ mutationPending: false })
      }
    }) },
    undoBatch: (batchId) => enqueueMutation(async (isCurrent) => {
      const client = desktopClient()
      if (client === null) return false
      set({ mutationPending: true })
      try {
        const result = await client.undo({ projectId: get().scene.projectId, expectedSceneRevision: get().scene.revision, batchId })
        const success = isCurrent() && applyMutationResult(result)
        if (success) await client.markBatchUndone(batchId).catch(() => undefined)
        return success
      } finally {
        if (isCurrent()) set({ mutationPending: false })
      }
    }),
    redo: async () => { await enqueueMutation(async (isCurrent) => {
      if (redoSteps.at(-1) === 'selection') {
        redoSteps.pop()
        if (selectionHistory?.redo() === true) undoSteps.push('selection')
        showHistorySteps()
        return
      }
      const client = desktopClient()
      if (client === null) return
      set({ mutationPending: true })
      try {
        const result = await client.redo({ projectId: get().scene.projectId, expectedSceneRevision: get().scene.revision, batchId: null })
        if (isCurrent() && applyMutationResult(result) && result.ok) {
          if (redoSteps.at(-1) === 'scene') redoSteps.pop()
          undoSteps.push('scene')
          showHistorySteps()
        }
      } finally {
        if (isCurrent()) set({ mutationPending: false })
      }
    }) }
  }))
)

export function setWorkspaceSceneClientForTests(client: WorkspaceSceneClient | null): void {
  sceneClientOverride = client
}

export function resetWorkspace(scene: Scene = createBlankScene()): void {
  beginProjectHydration()
  clearEphemeralAnnotation()
  clearHistorySteps()
  mutationChain = Promise.resolve()
  workspaceClipboard = []
  useWorkspaceStore.setState({
    projectSession: projectGeneration(),
    scene,
    sceneSequence: 0,
    projectName: 'Untitled',
    selectedIds: [],
    editingGroupId: null,
    activeView: 'canvas',
    activeTool: 'select',
    inspectorOpen: true,
    inspectorTab: 'layers',
    zoom: 1,
    pan: { x: 0, y: 0 },
    transformRatioLocked: false,
    geometryUnit: 'px',
    canUndo: false,
    canRedo: false,
    mutationPending: false,
    sceneProblem: null,
    workContextProblem: null
  })
  endProjectHydration()
}

export function hydrateWorkspaceScene(
  scene: Scene,
  projectName = 'Untitled',
  authority: Pick<SceneAuthorityState, 'sequence' | 'canUndo' | 'canRedo'> = { sequence: 0, canUndo: false, canRedo: false },
  savedContext?: ProjectWorkContext | null
): void {
  beginProjectHydration()
  const sameProject = useWorkspaceStore.getState().scene.projectId === scene.projectId
  const context = savedContext?.projectId === scene.projectId ? savedContext : defaultProjectWorkContext(scene.projectId, `${scene.canvas.aspectWidth}:${scene.canvas.aspectHeight}`)
  clearEphemeralAnnotation()
  if (!sameProject) clearHistorySteps()
  workspaceClipboard = []
  useCreationSessionStore.getState().bindProject(scene.projectId, sameProject && savedContext === undefined ? undefined : context.conversationDraft)
  useGenerationDraftStore.getState().bindProject(scene.projectId, sameProject && savedContext === undefined ? undefined : context.generation)
  mutationChain = Promise.resolve()
  useWorkspaceStore.setState((state) => ({
    ...state,
    projectSession: projectGeneration(),
    scene,
    sceneSequence: authority.sequence,
    projectName,
    ...((sameProject && savedContext === undefined) ? {} : context.workspace),
    selectedIds: (sameProject && savedContext === undefined ? state.selectedIds : context.workspace.selectedIds).filter((id) => scene.elements.some((element) => element.id === id)),
    editingGroupId: null,
    activeTool: 'select',
    canUndo: authority.canUndo,
    canRedo: authority.canRedo,
    mutationPending: false,
    sceneProblem: null,
    workContextProblem: null
  }))
  endProjectHydration()
  bindSceneEvents()
}
