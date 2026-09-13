import {
  Check,
  ChevronDown,
  CloudOff,
  Download,
  FilePlus2,
  FolderOpen,
  ImagePlus,
  LayoutTemplate,
  Layers3,
  LayoutDashboard,
  Maximize2,
  Minus,
  MousePointer2,
  Plus,
  Redo2,
  Save,
  Settings2,
  MessageSquare,
  Undo2
} from 'lucide-react'
import { type CSSProperties, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createSceneInitializationCommands, type SceneElement } from '../../domain'
import type { DesktopApi, RuntimeInfo } from '../../shared/desktop-api'
import type { RecentProjectSummary, WorkspaceBootstrap } from '../../shared/project'
import appIconUrl from '../../../build/icon.png'
import { RuntimeAssetSynchronizer } from './assets/RuntimeAssetSynchronizer'
import { clearRuntimeAssets, markRuntimeAssetMissing, registerRuntimeAsset } from './assets/runtime-assets'
import { applyAppearanceSnapshot, defaultAppearanceSnapshot } from './appearance/apply-appearance'
import { LiquidGlassDefs } from './appearance/LiquidGlassDefs'
import { useCanvasStatusPlacement } from './islands/use-canvas-status-placement'
import { AgentRuntimeBridge } from './agent/AgentRuntimeBridge'
import { clearEphemeralAnnotation } from './agent/ephemeral-annotation-store'
import { CanvasStage, type CanvasStageHandle } from './canvas/CanvasStage'
import { ActionTrace } from './canvas/ActionTrace'
import { createElementForTool } from './canvas/element-factory'
import { CanvasToolbar } from './components/CanvasToolbar'
import { CanvasSizeControl } from './components/CanvasSizeControl'
import { CreationBar } from './components/CreationBar'
import { ConversationView } from './components/ConversationView'
import { GenerateView } from './components/GenerateView'
import { Inspector } from './components/Inspector'
import { ProviderSettingsSheet } from './components/ProviderSettingsSheet'
import { ProjectLibrary } from './components/ProjectLibrary'
import { WorkspaceRecoveryView } from './components/RendererErrorBoundary'
import { createVisualExampleScene, VISUAL_EXAMPLE_KEYS, visualExampleLabels, type VisualExampleKey } from './fixtures/visual-examples'
import { groupBoundsForChildTransforms, hydrateWorkspaceScene, useWorkspaceStore, type CanvasTool, type WorkspaceView } from './store/workspace-store'
import { GlassIsland } from './islands/GlassIsland'
import { resetAllGlassIslands } from './islands/island-events'
import { waitForWorkspaceStartup } from './startup/workspace-startup'
import { activeModal, canvasKeyboardBlocked, canvasPasteBlocked } from './interaction/keyboard-scope'
import { useModalScope } from './interaction/use-modal-scope'
import { flushProjectWorkContext, startProjectContextSync } from './store/project-context-sync'
import { projectContextWritable, projectGeneration, setProjectContextWritable } from './store/project-context-lifecycle'

const viewLabels: Record<WorkspaceView, string> = {
  conversation: '对话',
  canvas: '画布',
  generate: '生成'
}

function downloadDataUrl(dataUrl: string, filename: string): void {
  const anchor = document.createElement('a')
  anchor.href = dataUrl
  anchor.download = filename
  anchor.click()
}

function exportFilename(projectName: string, format: 'png' | 'jpeg' | 'webp'): string {
  const extension = format === 'jpeg' ? 'jpg' : format
  const safeName = projectName
    .trim()
    .replace(/[<>:"/\\|?*]/g, '-')
    .split('')
    .filter((character) => character.charCodeAt(0) >= 32)
    .join('')
    .replace(/[. ]+$/g, '')
    .slice(0, 96)
  return `${safeName || '未命名作品'}.${extension}`
}

async function hydrateRuntimeWorkspace(bootstrap: WorkspaceBootstrap): Promise<void> {
  setProjectContextWritable(!bootstrap.workContextProblem)
  clearRuntimeAssets()
  hydrateWorkspaceScene(bootstrap.scene, bootstrap.projectName, {
    sequence: bootstrap.sceneSequence, canUndo: bootstrap.canUndo, canRedo: bootstrap.canRedo
  }, bootstrap.workContext ?? null)
  if (bootstrap.workContextProblem) useWorkspaceStore.setState({ workContextProblem: bootstrap.workContextProblem })
  const generation = projectGeneration()
  const isCurrent = (): boolean => generation === projectGeneration() && useWorkspaceStore.getState().scene.projectId === bootstrap.scene.projectId
  const assetIds = [...new Set(bootstrap.scene.elements
    .filter((element): element is Extract<SceneElement, { type: 'image' }> => element.type === 'image')
    .map((element) => element.assetId))]
  await Promise.all(assetIds.map(async (assetId) => {
    try {
      const url = await window.desktop.readGenerationAsset(assetId, false, bootstrap.scene.projectId)
      if (isCurrent()) registerRuntimeAsset(assetId, url)
    } catch {
      if (isCurrent()) markRuntimeAssetMissing(assetId)
    }
  }))
}

function useRuntimeStatus(): { ready: boolean; detail: string } {
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null)
  useEffect(() => {
    let mounted = true
    window.desktop.getRuntimeInfo().then((value) => {
      if (mounted) setRuntime(value)
    }).catch(() => undefined)
    return () => {
      mounted = false
    }
  }, [])
  if (runtime === null) return { ready: false, detail: '正在检查本地运行时' }
  const ready = runtime.nativeModules.betterSqlite3 && runtime.nativeModules.sharp
  return {
    ready,
    detail: ready ? `本地就绪 · SQLite ${runtime.nativeModules.sqliteVersion ?? ''} · Sharp ${runtime.nativeModules.sharpVersion ?? ''}` : '本地图片服务未就绪'
  }
}

function WorkspaceHeader({
  onExport,
  onShowLibrary
}: {
  onExport?: ((format: 'png' | 'jpeg' | 'webp', jpegBackground: string) => void) | undefined
  onShowLibrary(): void
}): React.JSX.Element {
  const activeView = useWorkspaceStore((state) => state.activeView)
  const projectName = useWorkspaceStore((state) => state.projectName)
  const setActiveView = useWorkspaceStore((state) => state.setActiveView)
  const canUndo = useWorkspaceStore((state) => state.canUndo)
  const canRedo = useWorkspaceStore((state) => state.canRedo)
  const undo = useWorkspaceStore((state) => state.undo)
  const redo = useWorkspaceStore((state) => state.redo)
  const inspectorOpen = useWorkspaceStore((state) => state.inspectorOpen)
  const setInspectorOpen = useWorkspaceStore((state) => state.setInspectorOpen)
  const [format, setFormat] = useState<'png' | 'jpeg' | 'webp'>('png')
  const [jpegBackground, setJpegBackground] = useState('#F5F4F1')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsProviderId, setSettingsProviderId] = useState<'openai-compatible-llm' | 'image-provider' | null>(null)
  const [projectMenuOpen, setProjectMenuOpen] = useState(false)
  const [recentProjects, setRecentProjects] = useState<readonly RecentProjectSummary[]>([])
  const [projectBusy, setProjectBusy] = useState(false)
  const [projectProblem, setProjectProblem] = useState<string | null>(null)
  const [online, setOnline] = useState(() => navigator.onLine)
  const settingsButtonRef = useRef<HTMLButtonElement>(null)
  const projectImageInputRef = useRef<HTMLInputElement>(null)
  const closeSettings = useCallback((): void => {
    setSettingsOpen(false)
    window.setTimeout(() => settingsButtonRef.current?.focus(), 0)
  }, [])

  useEffect(() => {
    const markOnline = (): void => setOnline(true)
    const markOffline = (): void => setOnline(false)
    window.addEventListener('online', markOnline)
    window.addEventListener('offline', markOffline)
    return () => {
      window.removeEventListener('online', markOnline)
      window.removeEventListener('offline', markOffline)
    }
  }, [])

  useEffect(() => {
    const openProviderSettings = (event: Event): void => {
      const detail = (event as CustomEvent<{ providerId?: 'openai-compatible-llm' | 'image-provider' }>).detail
      setSettingsProviderId(detail?.providerId ?? null)
      setSettingsOpen(true)
    }
    window.addEventListener('ai-canvas:open-provider-settings', openProviderSettings)
    return () => window.removeEventListener('ai-canvas:open-provider-settings', openProviderSettings)
  }, [])

  useEffect(() => {
    if (!projectMenuOpen) return
    void window.desktop.listRecentProjects().then(setRecentProjects).catch(() => setRecentProjects([]))
  }, [projectMenuOpen])

  const applyProjectResult = async (result: Awaited<ReturnType<DesktopApi['createProject']>>): Promise<void> => {
    if (result.cancelled || result.bootstrap === null) return
    clearEphemeralAnnotation()
    await hydrateRuntimeWorkspace(result.bootstrap)
    setProjectMenuOpen(false)
  }

  const runProjectAction = async (action: () => Promise<Awaited<ReturnType<DesktopApi['createProject']>>>): Promise<void> => {
    if (projectBusy) return
    setProjectBusy(true)
    setProjectProblem(null)
    try {
      await flushProjectWorkContext()
      await applyProjectResult(await action())
    } catch (error) {
      setProjectProblem(error instanceof Error ? error.message : '项目操作没有完成。')
    } finally {
      setProjectBusy(false)
    }
  }

  const createExampleProject = async (key: VisualExampleKey): Promise<void> => {
    if (projectBusy) return
    setProjectBusy(true)
    setProjectProblem(null)
    try {
      const projectName = visualExampleLabels[key]
      await flushProjectWorkContext()
      const result = await window.desktop.createProject({ suggestedName: projectName })
      if (result.cancelled || result.bootstrap === null) return
      const exampleScene = createVisualExampleScene(key, {
        projectId: result.bootstrap.scene.projectId,
        sceneId: result.bootstrap.scene.id
      })
      const initialized = await window.desktop.executeSceneCommands({
        projectId: result.bootstrap.projectId,
        expectedSceneRevision: result.bootstrap.scene.revision,
        batch: {
          id: globalThis.crypto.randomUUID(),
          origin: 'system',
          summary: `载入示例作品：${projectName}`,
          commands: [...createSceneInitializationCommands(exampleScene)]
        }
      })
      if (!initialized.ok) throw new Error(initialized.error.message)
      await hydrateRuntimeWorkspace({ ...result.bootstrap, scene: initialized.receipt.state.scene,
        sceneSequence: initialized.receipt.state.sequence, canUndo: initialized.receipt.state.canUndo, canRedo: initialized.receipt.state.canRedo })
      setProjectMenuOpen(false)
    } catch (error) {
      setProjectProblem(error instanceof Error ? error.message : '示例项目没有创建成功。')
    } finally {
      setProjectBusy(false)
    }
  }

  const createFromImage = async (file: File): Promise<void> => {
    const suggestedName = file.name.replace(/\.[^.]+$/, '') || 'Image Project'
    setProjectBusy(true)
    setProjectProblem(null)
    try {
      await flushProjectWorkContext()
      const result = await window.desktop.createProject({ suggestedName })
      if (result.cancelled || result.bootstrap === null) return
      await hydrateRuntimeWorkspace(result.bootstrap)
      const projectId = result.bootstrap.scene.projectId
      const generation = projectGeneration()
      const isCurrent = (): boolean => generation === projectGeneration() && useWorkspaceStore.getState().scene.projectId === projectId
      const bytes = new Uint8Array(await file.arrayBuffer())
      if (!isCurrent()) return
      const asset = await window.desktop.importAsset({
        projectId,
        name: file.name,
        mimeType: file.type as 'image/png' | 'image/jpeg' | 'image/webp',
        bytes
      })
      if (!isCurrent()) return
      const url = await window.desktop.readGenerationAsset(asset.id, false, projectId)
      if (!isCurrent()) return
      registerRuntimeAsset(asset.id, url)
      const existing = useWorkspaceStore.getState().scene.elements.find((candidate) => candidate.type === 'image' && candidate.assetId === asset.id)
      if (existing !== undefined) {
        useWorkspaceStore.getState().setSelection([existing.id])
        setProjectProblem(`已重新关联“${file.name}”。`)
        setProjectMenuOpen(false)
        return
      }
      const element = createElementForTool('image', useWorkspaceStore.getState().scene, asset.id)
      if (element !== null) useWorkspaceStore.getState().addElement(element, `从“${file.name}”开始项目`)
      setProjectMenuOpen(false)
    } catch (error) {
      setProjectProblem(error instanceof Error ? error.message : '未能从图片创建项目。')
    } finally {
      setProjectBusy(false)
    }
  }

  return (
    <>
    <header className="workspace-header">
      <div className="brand-block">
        <button type="button" className="brand-home" aria-label="返回项目库" onClick={onShowLibrary}><img className="app-mark" src={appIconUrl} alt="AI Canvas" /></button>
        <div>
          <button type="button" className="project-menu-trigger" title={projectName} aria-label={`项目菜单：${projectName}`} aria-expanded={projectMenuOpen} onClick={() => setProjectMenuOpen((open) => !open)}>{projectName}<ChevronDown size={10} /></button>
          {!online && <span className="offline-badge" role="status"><CloudOff size={11} />离线可用</span>}
        </div>
      </div>
      <nav className="view-switcher" aria-label="工作视图">
        {(Object.keys(viewLabels) as WorkspaceView[]).map((view) => (
          <button key={view} type="button" className={activeView === view ? 'is-active' : ''} aria-current={activeView === view ? 'page' : undefined} onClick={() => setActiveView(view)}>{viewLabels[view]}</button>
        ))}
      </nav>
      <div className="header-actions">
        <button type="button" className="icon-button" aria-label="撤销" disabled={!canUndo} onClick={undo}><Undo2 size={17} /></button>
        <button type="button" className="icon-button" aria-label="重做" disabled={!canRedo} onClick={redo}><Redo2 size={17} /></button>
        <span className="header-divider" />
        {!inspectorOpen && <button type="button" className="icon-button" aria-label="打开图层检查器" onClick={() => setInspectorOpen(true)}><Layers3 size={17} /></button>}
        <button ref={settingsButtonRef} type="button" className="icon-button" data-testid="open-settings" aria-label="供应商设置" onClick={() => { setSettingsProviderId(null); setSettingsOpen(true) }}><Settings2 size={16} /></button>
        {onExport !== undefined && (
          <div className="export-control">
            <button type="button" onClick={() => onExport(format, jpegBackground)}><Download size={15} />导出</button>
            <label aria-label="导出格式">
              <select value={format} onChange={(event) => setFormat(event.currentTarget.value as typeof format)}>
                <option value="png">PNG</option>
                <option value="jpeg">JPEG</option>
                <option value="webp">WebP</option>
              </select>
              <ChevronDown size={12} aria-hidden="true" />
            </label>
            {format === 'jpeg' && (
              <label className="jpeg-background" title="JPEG 不支持透明背景，请选择填充色">
                <span className="visually-hidden">JPEG 背景色</span>
                <input type="color" aria-label="JPEG 背景色" value={jpegBackground} onChange={(event) => setJpegBackground(event.currentTarget.value)} />
              </label>
            )}
          </div>
        )}
      </div>
    </header>
    {projectMenuOpen && (
      <div className="project-menu glass-surface" role="menu" aria-label="项目菜单">
        <div className="project-menu-primary">
          <button type="button" role="menuitem" disabled={projectBusy} onClick={() => { clearEphemeralAnnotation(); void runProjectAction(() => window.desktop.createProject({ suggestedName: 'Untitled' })) }}><FilePlus2 size={14} /><span>新建空白项目</span></button>
          <button type="button" role="menuitem" disabled={projectBusy} onClick={() => projectImageInputRef.current?.click()}><ImagePlus size={14} /><span>从图片开始</span></button>
          <button type="button" role="menuitem" disabled={projectBusy} onClick={() => void runProjectAction(() => window.desktop.openProject())}><FolderOpen size={14} /><span>打开项目</span></button>
          <button type="button" role="menuitem" disabled={projectBusy} onClick={() => void runProjectAction(() => window.desktop.saveProjectAs({ suggestedName: projectName }))}><Save size={14} /><span>另存为</span></button>
        </div>
        <div className="example-projects" aria-label="示例作品">
          <span><LayoutTemplate size={12} />示例作品</span>
          {VISUAL_EXAMPLE_KEYS.map((key) => <button key={key} type="button" role="menuitem" disabled={projectBusy} onClick={() => void createExampleProject(key)}>{visualExampleLabels[key]}</button>)}
        </div>
        {recentProjects.length > 0 && <div className="recent-projects"><span>最近项目</span>{recentProjects.slice(0, 4).map((project) => <button key={project.id} type="button" role="menuitem" disabled={projectBusy || project.id === useWorkspaceStore.getState().scene.projectId} onClick={() => void runProjectAction(async () => ({ cancelled: false, bootstrap: await window.desktop.openRecentProject(project.id) }))}><strong>{project.name}</strong><small>{new Date(project.lastOpenedAt).toLocaleDateString()}</small></button>)}</div>}
        {projectProblem !== null && <p role="alert">{projectProblem}</p>}
      </div>
    )}
    <input ref={projectImageInputRef} className="visually-hidden" type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => {
      const file = event.currentTarget.files?.[0]
      event.currentTarget.value = ''
      if (file !== undefined) void createFromImage(file)
    }} />
    {settingsOpen && <ProviderSettingsSheet initialProviderId={settingsProviderId} onClose={closeSettings} />}
    </>
  )
}

function CanvasView({ onShowLibrary }: { readonly onShowLibrary: () => void }): React.JSX.Element {
  const stageRef = useRef<CanvasStageHandle>(null)
  const workspaceRef = useRef<HTMLElement>(null)
  const canvasStatusRef = useRef<HTMLDivElement>(null)
  const canvasSizeRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [importChooserOpen, setImportChooserOpen] = useState(false)
  const [pendingImportMode, setPendingImportMode] = useState<'element' | 'background'>('element')
  const [viewportPercentage, setViewportPercentage] = useState(100)
  const [toolProblem, setToolProblem] = useState<string | null>(null)
  const [focusMode, setFocusMode] = useState(false)
  const canvasUtilityStyles = useCanvasStatusPlacement(workspaceRef, canvasStatusRef, canvasSizeRef, focusMode)
  const importModalRef = useRef<HTMLDivElement>(null)
  const scene = useWorkspaceStore((state) => state.scene)
  const projectName = useWorkspaceStore((state) => state.projectName)
  const selectedIds = useWorkspaceStore((state) => state.selectedIds)
  const editingGroupId = useWorkspaceStore((state) => state.editingGroupId)
  const activeTool = useWorkspaceStore((state) => state.activeTool)
  const setActiveTool = useWorkspaceStore((state) => state.setActiveTool)
  useModalScope(importModalRef, () => { setImportChooserOpen(false); setActiveTool('select') }, { active: importChooserOpen })
  const addElement = useWorkspaceStore((state) => state.addElement)
  const deleteSelection = useWorkspaceStore((state) => state.deleteSelection)
  const duplicateSelection = useWorkspaceStore((state) => state.duplicateSelection)
  const copySelection = useWorkspaceStore((state) => state.copySelection)
  const cutSelection = useWorkspaceStore((state) => state.cutSelection)
  const pasteSelection = useWorkspaceStore((state) => state.pasteSelection)
  const reorderElement = useWorkspaceStore((state) => state.reorderElement)
  const setSelection = useWorkspaceStore((state) => state.setSelection)
  const undo = useWorkspaceStore((state) => state.undo)
  const redo = useWorkspaceStore((state) => state.redo)
  const groupSelection = useWorkspaceStore((state) => state.groupSelection)
  const ungroupSelection = useWorkspaceStore((state) => state.ungroupSelection)
  const enterGroupEditing = useWorkspaceStore((state) => state.enterGroupEditing)
  const exitGroupEditing = useWorkspaceStore((state) => state.exitGroupEditing)
  const inspectorOpen = useWorkspaceStore((state) => state.inspectorOpen)
  const runtime = useRuntimeStatus()

  const importFile = useCallback(async (file: File, mode: 'element' | 'background' = 'element'): Promise<void> => {
    const projectId = useWorkspaceStore.getState().scene.projectId
    const generation = projectGeneration()
    const isCurrent = (): boolean => generation === projectGeneration() && useWorkspaceStore.getState().scene.projectId === projectId
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      setToolProblem('仅支持 PNG、JPEG 与 WebP 图片。')
      return
    }
    if (file.size <= 0 || file.size > 100 * 1024 * 1024) {
      setToolProblem('图片必须大于 0 字节且不超过 100 MB。')
      return
    }
    setToolProblem(null)
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      if (!isCurrent()) return
      const asset = await window.desktop.importAsset({
        projectId,
        name: file.name,
        mimeType: file.type as 'image/png' | 'image/jpeg' | 'image/webp',
        bytes
      })
      if (!isCurrent()) return
      const url = await window.desktop.readGenerationAsset(asset.id, false, projectId)
      if (!isCurrent()) return
      registerRuntimeAsset(asset.id, url)
      const existing = useWorkspaceStore.getState().scene.elements.find(
        (candidate) => candidate.type === 'image' && candidate.assetId === asset.id
      )
      if (existing !== undefined) {
        useWorkspaceStore.getState().setSelection([existing.id])
        setToolProblem(`已重新关联“${file.name}”。`)
        return
      }
      const element = createElementForTool('image', useWorkspaceStore.getState().scene, asset.id)
      if (element?.type === 'image' && mode === 'background') {
        const current = useWorkspaceStore.getState()
        const background: SceneElement = {
          ...element,
          name: '背景图片',
          semanticRole: 'background',
          transform: { x: 0, y: 0, width: 1, height: 1, rotation: 0 },
          fit: 'cover',
          referenceRole: 'composition'
        }
        const success = await current.execute(`导入背景“${file.name}”`, [
          { kind: 'element.add', element: background },
          { kind: 'element.reorder', elementId: background.id, toIndex: Math.min(1, current.scene.elements.length) }
        ])
        if (success && isCurrent()) current.setSelection([background.id])
      } else if (element !== null) {
        await addElement(element, `导入“${file.name}”`)
      }
    } catch (error) {
      if (isCurrent()) setToolProblem(error instanceof Error ? error.message : '图片没有成功导入。')
    } finally {
      if (isCurrent()) setActiveTool('select')
    }
  }, [addElement, setActiveTool])

  const chooseTool = useCallback((tool: CanvasTool): void => {
    setToolProblem(null)
    if (tool === 'mask') {
      const target = scene.elements.find((element) => element.id === selectedIds[0])
      if (target?.type !== 'image') {
        setActiveTool('select')
        setToolProblem('请先选择需要局部修改的图片，再绘制蒙版。')
        return
      }
      setActiveTool('mask')
      return
    }
    setActiveTool(tool)
    if (tool === 'select' || tool === 'hand') return
    if (tool === 'sketch') return
    if (tool === 'image') {
      setImportChooserOpen(true)
      return
    }
    const element = createElementForTool(tool, scene)
    if (element !== null) addElement(element, `添加“${element.name}”`)
    setActiveTool('select')
  }, [addElement, scene, selectedIds, setActiveTool])

  useLayoutEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (canvasKeyboardBlocked(event)) return
      const command = event.ctrlKey || event.metaKey
      if ((event.key === 'Delete' || event.key === 'Backspace') && selectedIds.length > 0) {
        event.preventDefault()
        deleteSelection()
      } else if (command && event.key.toLowerCase() === 'c' && selectedIds.length > 0) {
        event.preventDefault()
        copySelection()
      } else if (command && event.key.toLowerCase() === 'x' && selectedIds.length > 0) {
        event.preventDefault()
        void cutSelection()
      } else if (command && event.key.toLowerCase() === 'j' && selectedIds.length > 0) {
        event.preventDefault()
        void duplicateSelection()
      } else if (command && event.key === '0') {
        event.preventDefault()
        stageRef.current?.viewFit()
      } else if (command && event.key === '1') {
        event.preventDefault()
        stageRef.current?.viewActualSize()
      } else if (command && (event.key === '+' || event.key === '=')) {
        event.preventDefault()
        stageRef.current?.zoomBy(1.15)
      } else if (command && (event.key === '-' || event.key === '_')) {
        event.preventDefault()
        stageRef.current?.zoomBy(1 / 1.15)
      } else if (command && (event.key === '[' || event.key === ']') && selectedIds.length === 1) {
        event.preventDefault()
        const selected = scene.elements.find((element) => element.id === selectedIds[0])
        if (selected !== undefined) {
          const currentIndex = scene.elements.findIndex((element) => element.id === selected.id)
          const target = event.key === ']'
            ? event.shiftKey ? scene.elements.length - 1 : Math.min(scene.elements.length - 1, currentIndex + 1)
            : event.shiftKey ? 0 : Math.max(0, currentIndex - 1)
          void reorderElement(selected.id, target)
        }
      } else if (command && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (event.shiftKey) redo()
        else undo()
      } else if (command && event.key.toLowerCase() === 'y') {
        event.preventDefault()
        redo()
      } else if (command && event.key.toLowerCase() === 'a') {
        event.preventDefault()
        setSelection(scene.elements.filter((element) => element.visible).map((element) => element.id))
      } else if (command && event.key.toLowerCase() === 'g') {
        event.preventDefault()
        if (event.shiftKey) ungroupSelection()
        else groupSelection()
      } else if (event.key === 'Enter' && editingGroupId === null && selectedIds.length === 1) {
        const selected = scene.elements.find((element) => element.id === selectedIds[0])
        if (selected?.type === 'group' && !selected.locked) {
          event.preventDefault()
          enterGroupEditing(selected.id)
        }
      } else if (event.key === 'Escape') {
        event.preventDefault()
        setActiveTool('select')
        if (editingGroupId !== null) exitGroupEditing()
        else setSelection([])
      } else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key) && selectedIds.length > 0) {
        event.preventDefault()
        const current = useWorkspaceStore.getState()
        const pixelStep = event.shiftKey ? 10 : 1
        const dx = event.key === 'ArrowLeft' ? -pixelStep / current.scene.canvas.outputWidth : event.key === 'ArrowRight' ? pixelStep / current.scene.canvas.outputWidth : 0
        const dy = event.key === 'ArrowUp' ? -pixelStep / current.scene.canvas.outputHeight : event.key === 'ArrowDown' ? pixelStep / current.scene.canvas.outputHeight : 0
        const ids = new Set<string>()
        for (const selectedId of current.selectedIds) {
          const selected = current.scene.elements.find((element) => element.id === selectedId)
          if (selected === undefined || selected.locked) continue
          ids.add(selected.id)
          if (selected.type === 'group') selected.childIds.forEach((id) => ids.add(id))
        }
        const transformOverrides = new Map<string, SceneElement['transform']>()
        const commands = [...ids].flatMap((id) => {
          const element = current.scene.elements.find((candidate) => candidate.id === id)
          if (element === undefined) return []
          const transform = { ...element.transform, x: element.transform.x + dx, y: element.transform.y + dy }
          transformOverrides.set(element.id, transform)
          return [{
            kind: 'element.update' as const,
            elementId: id,
            changes: { transform }
          }]
        })
        const affectedGroupIds = new Set(
          [...ids]
            .map((id) => current.scene.elements.find((element) => element.id === id)?.groupId)
            .filter((groupId): groupId is string => groupId !== null && groupId !== undefined && !ids.has(groupId))
        )
        for (const groupId of affectedGroupIds) {
          const transform = groupBoundsForChildTransforms(current.scene, groupId, transformOverrides)
          if (transform !== null) commands.push({ kind: 'element.update', elementId: groupId, changes: { transform } })
        }
        if (commands.length > 0) current.execute(`移动 ${current.selectedIds.length} 个元素`, commands)
      } else if (!command && event.key.toLowerCase() === 'v') {
        chooseTool('select')
      } else if (!command && event.key.toLowerCase() === 'h') {
        chooseTool('hand')
      } else if (!command && event.key.toLowerCase() === 'b') {
        chooseTool('sketch')
      } else if (!command && event.key.toLowerCase() === 't') {
        chooseTool('text')
      }
    }
    const handlePaste = (event: ClipboardEvent): void => {
      if (canvasPasteBlocked(event)) return
      const file = [...(event.clipboardData?.files ?? [])].find((candidate) => candidate.type.startsWith('image/'))
      if (file !== undefined) {
        event.preventDefault()
        void importFile(file)
      } else {
        event.preventDefault()
        void pasteSelection()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('paste', handlePaste)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('paste', handlePaste)
    }
  }, [chooseTool, copySelection, cutSelection, deleteSelection, duplicateSelection, editingGroupId, enterGroupEditing, exitGroupEditing, groupSelection, importFile, pasteSelection, redo, reorderElement, scene.elements, selectedIds, setActiveTool, setSelection, undo, ungroupSelection])

  const exportCanvas = (format: 'png' | 'jpeg' | 'webp', jpegBackground: string): void => {
    const dataUrl = stageRef.current?.exportDataUrl(format, jpegBackground)
    if (dataUrl !== null && dataUrl !== undefined) downloadDataUrl(dataUrl, exportFilename(projectName, format))
  }

  const editingGroup = editingGroupId === null
    ? undefined
    : scene.elements.find((element) => element.id === editingGroupId && element.type === 'group')

  return (
    <div className="canvas-view">
      <WorkspaceHeader onExport={exportCanvas} onShowLibrary={onShowLibrary} />
      <main
        ref={workspaceRef}
        className={`canvas-workspace${inspectorOpen ? '' : ' inspector-collapsed'}${focusMode ? ' is-focus-mode' : ''}`}
        onDragOver={(event) => {
          if ([...(event.dataTransfer?.items ?? [])].some((item) => item.kind === 'file')) event.preventDefault()
        }}
        onDrop={(event) => {
          if (activeModal() !== null) return
          event.preventDefault()
          const file = [...event.dataTransfer.files].find((candidate) => candidate.type.startsWith('image/'))
          if (file !== undefined) void importFile(file)
        }}
      >
        <GlassIsland id="tools" label="画布工具" icon={MousePointer2} containerRef={workspaceRef} status={activeTool === 'select' ? 'idle' : 'active'}>
          <CanvasToolbar activeTool={activeTool} onChoose={chooseTool} />
        </GlassIsland>
        {importChooserOpen && (
          <div ref={importModalRef} tabIndex={-1} className="import-chooser glass-surface" role="dialog" aria-modal="true" aria-label="选择图片用途">
            <strong>图片放在哪里？</strong>
            <p>不会自动覆盖当前背景。</p>
            <button type="button" onClick={() => { setPendingImportMode('element'); setImportChooserOpen(false); fileInputRef.current?.click() }}>作为普通元素</button>
            <button type="button" onClick={() => { setPendingImportMode('background'); setImportChooserOpen(false); fileInputRef.current?.click() }}>设为画布背景</button>
            <button type="button" className="quiet-choice" onClick={() => { setImportChooserOpen(false); setActiveTool('select') }}>取消</button>
          </div>
        )}
        <section
          className="canvas-center"
          aria-label="画布工作区"
          style={{ '--scene-reflection': scene.canvas.backgroundColor } as CSSProperties}
        >
          <CanvasStage ref={stageRef} onScaleChange={setViewportPercentage} focusMode={focusMode} />
          <ActionTrace />
          {editingGroup?.type === 'group' && (
            <div className="group-editing-path glass-surface" role="status" aria-label="组内编辑">
              <span>正在编辑：</span>
              <strong>{editingGroup.name}</strong>
              <button type="button" aria-label="退出组内编辑" onClick={exitGroupEditing}>完成</button>
            </div>
          )}
          {scene.elements.length === 0 && (
            <div className="canvas-empty-guide" aria-label="空白画布">
              <span className="empty-frame" aria-hidden="true"><ImagePlus size={20} /></span>
              <strong>空白画布</strong>
              <p>拖入图片、添加元素，或在下方描述你想创建的画面。</p>
            </div>
          )}
          <div className={`runtime-pill${runtime.ready ? ' is-ready' : ''}`} title={runtime.detail}><Check size={11} />本地</div>
        </section>
          <div ref={canvasSizeRef} className="canvas-size-float glass-surface" style={canvasUtilityStyles?.size}><CanvasSizeControl /></div>
          <div ref={canvasStatusRef} className="canvas-status glass-surface" style={canvasUtilityStyles?.status}>
            <div className="canvas-status-scale">
            <button type="button" aria-label="适合窗口" title="适合窗口（Ctrl+0）" onClick={() => stageRef.current?.viewFit()}><Maximize2 size={14} /></button>
            <span className="canvas-zoom-cluster" aria-label="画布缩放">
              <button type="button" aria-label="缩小画布" title="缩小（Ctrl+-）" onClick={() => stageRef.current?.zoomBy(1 / 1.15)}><Minus size={12} /></button>
              <input
                type="range"
                min="5"
                max="800"
                step="1"
                value={Math.min(800, Math.max(5, Math.round(viewportPercentage)))}
                aria-label="画布缩放比例"
                aria-valuetext={`${Math.round(viewportPercentage)}%`}
                onChange={(event) => stageRef.current?.viewScalePercentage(Number(event.currentTarget.value))}
              />
              <button type="button" aria-label="放大画布" title="放大（Ctrl++）" onClick={() => stageRef.current?.zoomBy(1.15)}><Plus size={12} /></button>
            </span>
            </div>
            <div className="canvas-status-meta">
            <button type="button" className="actual-size" data-testid="viewport-scale" title="点击回到 100%（Ctrl+1）" onClick={() => stageRef.current?.viewActualSize()}>{Math.round(viewportPercentage)}%</button>
            <span>{scene.elements.length} 个元素</span>
            <button type="button" className="focus-mode-toggle" aria-pressed={focusMode} onClick={() => setFocusMode((current) => !current)}>{focusMode ? '退出专注' : '进入专注'}</button>
            <button type="button" className="reset-islands-button" title="还原工具布局" aria-label="还原工具布局" onClick={resetAllGlassIslands}><LayoutDashboard size={14} /></button>
            </div>
          </div>
          {toolProblem !== null && <div className="canvas-tool-problem" role="alert">{toolProblem}</div>}
        <GlassIsland id="composer" label="Agent 创作" icon={MessageSquare} containerRef={workspaceRef} status="idle">
          <CreationBar />
        </GlassIsland>
        <GlassIsland id="inspector" label="图层与属性" icon={Layers3} containerRef={workspaceRef}>
          {({ collapse, layout }) => <Inspector onRequestCollapse={collapse} projection={layout.mode === 'docked-top' || layout.mode === 'docked-bottom' ? 'horizontal' : 'vertical'} />}
        </GlassIsland>
      </main>
      <input
        ref={fileInputRef}
        className="visually-hidden"
        type="file"
        accept="image/png,image/jpeg,image/webp"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0]
          event.currentTarget.value = ''
          if (file !== undefined) void importFile(file, pendingImportMode)
        }}
      />
    </div>
  )
}

export function App(): React.JSX.Element {
  const activeView = useWorkspaceStore((state) => state.activeView)
  const projectId = useWorkspaceStore((state) => state.scene.projectId)
  const projectSession = useWorkspaceStore((state) => state.projectSession)
  const workContextProblem = useWorkspaceStore((state) => state.workContextProblem)
  useEffect(() => startProjectContextSync(), [])
  const [screen, setScreen] = useState<'loading' | 'library' | 'workspace' | 'recovery'>('loading')
  const [runtimeInfo, setRuntimeInfo] = useState<RuntimeInfo | null>(null)
  const [startupAttempt, setStartupAttempt] = useState(0)
  useEffect(() => {
    const desktop = window.desktop as Partial<DesktopApi> | undefined
    applyAppearanceSnapshot(defaultAppearanceSnapshot())
    if (desktop?.getAppearanceSettings === undefined) return
    let mounted = true
    void desktop.getAppearanceSettings().then((snapshot) => {
      if (mounted) applyAppearanceSnapshot(snapshot)
    }).catch(() => undefined)
    const unsubscribe = desktop.onAppearanceChanged?.((snapshot) => applyAppearanceSnapshot(snapshot))
    return () => {
      mounted = false
      unsubscribe?.()
    }
  }, [])
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const reducedTransparency = window.matchMedia('(prefers-reduced-transparency: reduce)')
    const sync = (): void => {
      document.documentElement.dataset.reducedTransparency = reducedTransparency.matches ? 'true' : 'false'
    }
    sync()
    reducedTransparency.addEventListener('change', sync)
    return () => {
      reducedTransparency.removeEventListener('change', sync)
      delete document.documentElement.dataset.reducedTransparency
    }
  }, [])
  useEffect(() => {
    const desktop = window.desktop as Partial<DesktopApi> | undefined
    const getRuntimeInfo = desktop?.getRuntimeInfo
    const getWorkspaceBootstrap = desktop?.getWorkspaceBootstrap
    if (getRuntimeInfo === undefined) {
      queueMicrotask(() => setScreen('workspace'))
      return
    }
    let mounted = true
    void waitForWorkspaceStartup((async () => {
      const [runtime, bootstrap] = await Promise.all([
        getRuntimeInfo(),
        getWorkspaceBootstrap?.() ?? Promise.resolve(null)
      ])
      if (bootstrap !== null) await hydrateRuntimeWorkspace(bootstrap)
      return runtime
    })()).then((runtime) => {
      if (!mounted) return
      setRuntimeInfo(runtime)
      setScreen(runtime.startupRoute)
    }).catch(() => {
      if (!mounted) return
      setRuntimeInfo(null)
      setScreen('recovery')
    })
    return () => {
      mounted = false
    }
  }, [startupAttempt])

  const openWorkspace = useCallback(async (bootstrap: WorkspaceBootstrap): Promise<void> => {
    await hydrateRuntimeWorkspace(bootstrap)
    setScreen('workspace')
  }, [])
  const showLibrary = (): void => { void flushProjectWorkContext().then(() => setScreen('library')).catch((error: unknown) => {
    useWorkspaceStore.setState({ sceneProblem: error instanceof Error ? error.message : '工作状态尚未保存，请重试。' })
  }) }

  if (screen === 'loading') {
    return <><LiquidGlassDefs /><div className="app-shell app-loading"><span className="loading-orb"><img src={appIconUrl} alt="AI Canvas" /></span><p>正在整理你的创作空间…</p></div></>
  }

  if (screen === 'recovery') {
    return <><LiquidGlassDefs /><WorkspaceRecoveryView
      title="工作区暂时没有准备好"
      message="项目仍保留在本机。你可以重新检查工作区；这个操作不会自动生成图片、重试模型请求或增加费用。"
      actionLabel="重新检查工作区"
      onAction={() => {
        setScreen('loading')
        setStartupAttempt((attempt) => attempt + 1)
      }}
    /></>
  }

  return (
    <>
      <LiquidGlassDefs />
      <div className="app-shell">
        {workContextProblem !== null && <div className="workspace-save-problem" role="alert">
          <span>{workContextProblem}</span>
          {projectContextWritable() && <button type="button" onClick={() => { void flushProjectWorkContext().catch(() => undefined) }}>重试保存</button>}
        </div>}
        {screen === 'library' && runtimeInfo !== null
          ? <ProjectLibrary runtime={runtimeInfo} onOpen={openWorkspace} onActiveProjectChanged={hydrateRuntimeWorkspace} />
          : <>
            <RuntimeAssetSynchronizer />
            <AgentRuntimeBridge />
            {activeView === 'generate'
              ? <GenerateView key={`${projectId}:${projectSession}`} header={<WorkspaceHeader onShowLibrary={showLibrary} />} />
              : activeView === 'canvas'
                ? <CanvasView key={`${projectId}:${projectSession}`} onShowLibrary={showLibrary} />
                : <ConversationView key={`${projectId}:${projectSession}`} header={<WorkspaceHeader onShowLibrary={showLibrary} />} />}
          </>}
      </div>
    </>
  )
}
