import {
  ArrowUpRight,
  AlertTriangle,
  Clock3,
  FolderOpen,
  ImagePlus,
  MoreHorizontal,
  Plus,
  Settings2,
  Star,
  Trash2
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { RuntimeInfo } from '../../../shared/desktop-api'
import type { RecentProjectSummary, WorkspaceBootstrap } from '../../../shared/project'
import appIconUrl from '../../../../build/icon.png'
import { createElementForTool } from '../canvas/element-factory'
import { projectLibraryLocationLabel } from './project-library-label'
import { ProviderSettingsSheet } from './ProviderSettingsSheet'
import { useModalScope } from '../interaction/use-modal-scope'
import { flushProjectWorkContext } from '../store/project-context-sync'

interface ProjectLibraryProps {
  readonly runtime: RuntimeInfo
  onOpen(bootstrap: WorkspaceBootstrap): Promise<void>
  onActiveProjectChanged(bootstrap: WorkspaceBootstrap): Promise<void>
}

function relativeDate(iso: string): string {
  const timestamp = Date.parse(iso)
  if (!Number.isFinite(timestamp)) return '最近编辑'
  const difference = Date.now() - timestamp
  const minutes = Math.max(1, Math.round(difference / 60_000))
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.round(hours / 24)
  if (days < 8) return `${days} 天前`
  return new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric' }).format(new Date(timestamp))
}

function artVariant(id: string, index: number): number {
  return ([...id].reduce((total, character) => total + character.charCodeAt(0), index) % 4) + 1
}

export function ProjectLibrary({ runtime, onOpen, onActiveProjectChanged }: ProjectLibraryProps): React.JSX.Element {
  const [projects, setProjects] = useState<readonly RecentProjectSummary[]>([])
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [filter, setFilter] = useState<'recent' | 'favorite'>('recent')
  const [menuProjectId, setMenuProjectId] = useState<string | null>(null)
  const [deleteCandidate, setDeleteCandidate] = useState<RecentProjectSummary | null>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const deleteCancelRef = useRef<HTMLButtonElement>(null)
  const deleteModalRef = useRef<HTMLElement>(null)
  const deleteReturnRef = useRef<HTMLButtonElement>(null)
  useModalScope(deleteModalRef, () => { if (!busy) setDeleteCandidate(null) }, { active: deleteCandidate !== null, initialFocus: deleteCancelRef, returnFocus: deleteReturnRef })
  const sortedProjects = useMemo(
    () => [...projects]
      .filter((project) => filter === 'recent' || project.favorite)
      .sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt)),
    [filter, projects]
  )

  useEffect(() => {
    let mounted = true
    void window.desktop.listRecentProjects()
      .then((value) => { if (mounted) setProjects(value) })
      .catch(() => { if (mounted) setProjects([]) })
    return () => { mounted = false }
  }, [])

  useEffect(() => {
    if (menuProjectId === null) return
    const closeOnPointer = (event: PointerEvent): void => {
      if (event.target instanceof Element && event.target.closest('[data-project-card-menu]') !== null) return
      setMenuProjectId(null)
    }
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMenuProjectId(null)
    }
    window.addEventListener('pointerdown', closeOnPointer)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('pointerdown', closeOnPointer)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [menuProjectId])

  const run = async (action: () => Promise<WorkspaceBootstrap | null>): Promise<void> => {
    if (busy) return
    setBusy(true)
    setProblem(null)
    setNotice(null)
    try {
      await flushProjectWorkContext()
      const bootstrap = await action()
      if (bootstrap !== null) await onOpen(bootstrap)
    } catch (error) {
      setProblem(error instanceof Error ? error.message : '项目没有成功打开。')
    } finally {
      setBusy(false)
    }
  }

  const createBlank = (): void => {
    void run(async () => {
      const result = await window.desktop.createProject({ suggestedName: '未命名创作' })
      return result.cancelled ? null : result.bootstrap
    })
  }

  const openExternal = (): void => {
    void run(async () => {
      const result = await window.desktop.openProject()
      return result.cancelled ? null : result.bootstrap
    })
  }

  const relocate = (project: RecentProjectSummary): void => {
    void run(async () => {
      const result = await window.desktop.relocateRecentProject(project.id)
      return result.cancelled ? null : result.bootstrap
    })
  }

  const toggleFavorite = (project: RecentProjectSummary): void => {
    if (busy) return
    setBusy(true)
    setProblem(null)
    void window.desktop.setProjectFavorite({ projectId: project.id, favorite: !project.favorite })
      .then(setProjects)
      .catch((error: unknown) => setProblem(error instanceof Error ? error.message : '收藏状态没有保存。'))
      .finally(() => setBusy(false))
  }

  const deleteProject = (): void => {
    const project = deleteCandidate
    if (project === null || busy) return
    setBusy(true)
    setProblem(null)
    setNotice(null)
    void window.desktop.deleteRecentProject(project.id)
      .then(async (result) => {
        setProjects(result.projects)
        setDeleteCandidate(null)
        if (result.replacementBootstrap !== null) await onActiveProjectChanged(result.replacementBootstrap)
        setNotice(result.disposition === 'trashed' ? '项目已移到系统回收站。' : '项目已从最近列表移除，原文件未删除。')
      })
      .catch((error: unknown) => setProblem(error instanceof Error ? error.message : '项目没有删除。'))
      .finally(() => setBusy(false))
  }

  const createFromImage = (file: File): void => {
    void run(async () => {
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
        throw new Error('请选择 PNG、JPEG 或 WebP 图片。')
      }
      const result = await window.desktop.createProject({ suggestedName: file.name.replace(/\.[^.]+$/, '') || '图片创作' })
      if (result.cancelled || result.bootstrap === null) return null
      const asset = await window.desktop.importAsset({
        projectId: result.bootstrap.projectId,
        name: file.name,
        mimeType: file.type as 'image/png' | 'image/jpeg' | 'image/webp',
        bytes: new Uint8Array(await file.arrayBuffer())
      })
      // The opened project's hydrator loads assets after switching Renderer identity.
      const element = createElementForTool('image', result.bootstrap.scene, asset.id)
      if (element === null) return result.bootstrap
      const mutation = await window.desktop.executeSceneCommands({
        projectId: result.bootstrap.projectId,
        expectedSceneRevision: result.bootstrap.scene.revision,
        batch: {
          id: globalThis.crypto.randomUUID(),
          origin: 'user',
          summary: `从“${file.name}”开始项目`,
          commands: [{ kind: 'element.add', element }]
        }
      })
      if (!mutation.ok) throw new Error(mutation.error.message)
      return {
        ...result.bootstrap,
        scene: mutation.receipt.state.scene,
        sceneSequence: mutation.receipt.state.sequence,
        canUndo: mutation.receipt.state.canUndo,
        canRedo: mutation.receipt.state.canRedo
      }
    })
  }

  return (
    <div
      className="project-library"
      onDragOver={(event) => {
        if ([...(event.dataTransfer?.items ?? [])].some((item) => item.kind === 'file')) event.preventDefault()
      }}
      onDrop={(event) => {
        event.preventDefault()
        const file = [...event.dataTransfer.files].find((candidate) => candidate.type.startsWith('image/'))
        if (file !== undefined) createFromImage(file)
      }}
    >
      <header className="library-titlebar">
        <div className="library-brand"><img src={appIconUrl} alt="AI Canvas" /><span>AI Canvas</span></div>
        <button type="button" className="library-settings-button" aria-label="打开设置" onClick={() => setSettingsOpen(true)}><Settings2 size={18} /></button>
      </header>

      <main className="library-main">
        <div className="library-heading">
          <div>
            <h1>项目</h1>
            <p>从最近的作品继续，或安静地开始一张新画布。</p>
          </div>
          <div className="library-filter glass-surface" role="group" aria-label="项目筛选">
            <button type="button" className={filter === 'recent' ? 'is-active' : ''} onClick={() => setFilter('recent')}>最近</button>
            <button type="button" className={filter === 'favorite' ? 'is-active' : ''} onClick={() => setFilter('favorite')}>收藏</button>
          </div>
        </div>

        <section className={`project-gallery${sortedProjects.length > 0 && sortedProjects.length <= 2 ? ' is-sparse' : ''}`} aria-label="项目库">
          <article className="project-new-card glass-surface">
            <button type="button" className="new-project-main" disabled={busy} onClick={createBlank}>
              <span className="new-project-orb"><Plus size={28} /></span>
              <strong>新建项目</strong>
              <small>直接创建，不再选择保存路径</small>
            </button>
            <div className="project-start-actions">
              <button type="button" disabled={busy} onClick={createBlank}><span className="start-icon"><Plus size={17} /></span>空白画布</button>
              <button type="button" disabled={busy} onClick={() => imageInputRef.current?.click()}><span className="start-icon"><ImagePlus size={17} /></span>从图片开始</button>
            </div>
          </article>

          {sortedProjects.map((project, index) => (
            <article key={project.id} data-project-id={project.id} className={`project-card is-${project.status}`}>
              <button
                type="button"
                className="project-card-open"
                disabled={busy}
                aria-label={`打开项目：${project.name}`}
                onClick={() => project.status === 'missing' || project.status === 'damaged'
                  ? relocate(project)
                  : void run(() => window.desktop.openRecentProject(project.id))}
              >
                <span
                  className={`project-card-art art-${artVariant(project.id, index)}${project.coverDataUrl === null ? '' : ' has-cover'}`}
                  style={project.coverDataUrl === null ? undefined : { backgroundImage: `url(${project.coverDataUrl})` }}
                  aria-hidden="true"
                >
                  <span className="art-line line-a" /><span className="art-line line-b" /><span className="art-glow" />
                  {project.coverDataUrl === null && <strong>{project.name.slice(0, 18)}</strong>}
                  {(project.status === 'missing' || project.status === 'damaged') && <span className="project-card-state"><AlertTriangle size={15} />{project.status === 'missing' ? '项目已移动' : '项目需要检查'}</span>}
                  {project.status === 'asset-missing' && <span className="project-card-state"><AlertTriangle size={15} />有素材待重连</span>}
                </span>
                <span className="project-card-meta glass-surface">
                  <span><strong>{project.name}</strong><small><Clock3 size={10} />{relativeDate(project.lastOpenedAt)} · {project.aspectLabel}</small></span>
                </span>
              </button>
              <div className="project-card-actions" data-project-card-menu>
                <button
                  type="button"
                  className={`project-favorite${project.favorite ? ' is-active' : ''}`}
                  aria-label={project.favorite ? `取消收藏：${project.name}` : `收藏项目：${project.name}`}
                  aria-pressed={project.favorite}
                  disabled={busy}
                  onClick={() => toggleFavorite(project)}
                ><Star size={15} fill={project.favorite ? 'currentColor' : 'none'} /></button>
                <button
                  type="button"
                  className="project-more"
                  aria-label={`更多项目操作：${project.name}`}
                  aria-haspopup="menu"
                  aria-expanded={menuProjectId === project.id}
                  disabled={busy}
                  onClick={(event) => { deleteReturnRef.current = event.currentTarget; setMenuProjectId((current) => current === project.id ? null : project.id) }}
                ><MoreHorizontal size={16} /></button>
                {menuProjectId === project.id && (
                  <div className="project-card-menu glass-surface" role="menu" aria-label={`${project.name} 项目操作`}>
                    <button type="button" role="menuitem" onClick={() => { setMenuProjectId(null); void run(() => window.desktop.openRecentProject(project.id)) }}>打开项目</button>
                    <button type="button" role="menuitem" onClick={() => { setMenuProjectId(null); toggleFavorite(project) }}>{project.favorite ? '取消收藏' : '加入收藏'}</button>
                    {(project.status === 'missing' || project.status === 'damaged') && <button type="button" role="menuitem" onClick={() => { setMenuProjectId(null); relocate(project) }}>重新定位</button>}
                    <button type="button" role="menuitem" className="project-delete-action" onClick={() => { setMenuProjectId(null); setDeleteCandidate(project) }}><Trash2 size={13} />{project.deleteMode === 'trash' ? '删除项目…' : '从列表移除…'}</button>
                  </div>
                )}
              </div>
              {(project.status === 'missing' || project.status === 'damaged') && <button type="button" className="project-relocate" disabled={busy} onClick={() => relocate(project)}>重新定位</button>}
            </article>
          ))}

          {sortedProjects.length === 0 && filter === 'recent' && (
            <div className="library-first-run">
              <span className="first-run-line" />
              <p>你的第一个作品会出现在这里。可以从空白画布开始，也可以直接拖入一张图片。</p>
            </div>
          )}
          {sortedProjects.length === 0 && filter === 'favorite' && <div className="library-first-run"><Star size={18} /><p>收藏的项目会留在这里，方便下一次直接继续。</p></div>}
        </section>
      </main>

      <footer className="library-footer glass-surface">
        <span><FolderOpen size={15} /><span><small>本机项目库</small><strong>{projectLibraryLocationLabel(runtime.projectLibraryPath)}</strong></span></span>
        <button type="button" disabled={busy} onClick={openExternal}>打开外部项目 <ArrowUpRight size={13} /></button>
      </footer>
      {problem !== null && <div className="library-problem glass-surface" role="alert">{problem}</div>}
      {notice !== null && <div className="library-notice glass-surface" role="status">{notice}</div>}
      <input ref={imageInputRef} className="visually-hidden" type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => {
        const file = event.currentTarget.files?.[0]
        event.currentTarget.value = ''
        if (file !== undefined) createFromImage(file)
      }} />
      {settingsOpen && <ProviderSettingsSheet onClose={() => setSettingsOpen(false)} />}
      {deleteCandidate !== null && (
        <div className="project-delete-backdrop" onPointerDown={(event) => {
          if (event.target === event.currentTarget && !busy) setDeleteCandidate(null)
        }}>
          <section ref={deleteModalRef} tabIndex={-1} className="project-delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby="project-delete-title" aria-describedby="project-delete-description">
            <span className="project-delete-symbol" aria-hidden="true"><Trash2 size={20} /></span>
            <div>
              <h2 id="project-delete-title">{deleteCandidate.deleteMode === 'trash' ? `将“${deleteCandidate.name}”移到回收站？` : `从列表移除“${deleteCandidate.name}”？`}</h2>
              <p id="project-delete-description">{deleteCandidate.deleteMode === 'trash'
                ? '项目文件、素材与创作历史会一起进入系统回收站，之后仍可从回收站恢复。'
                : deleteCandidate.status === 'missing'
                  ? 'AI Canvas 已找不到这个项目文件，只会清理最近项目卡片。'
                  : '这个项目不在当前项目库中，只会从最近列表移除；外部项目文件不会被删除。'}</p>
            </div>
            <div className="project-delete-actions">
              <button ref={deleteCancelRef} type="button" disabled={busy} onClick={() => setDeleteCandidate(null)}>取消</button>
              <button type="button" className="is-danger" disabled={busy} onClick={deleteProject}>{busy ? '正在处理…' : deleteCandidate.deleteMode === 'trash' ? '移到回收站' : '从列表移除'}</button>
            </div>
          </section>
        </div>
      )}
    </div>
  )
}
