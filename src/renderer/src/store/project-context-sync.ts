import { generationWorkContextFields, projectWorkContextSchema, type ProjectWorkContext } from '../../../shared/project-work-context'
import { useWorkspaceStore } from './workspace-store'
import { useGenerationDraftStore } from './generation-draft-store'
import { useCreationSessionStore } from './creation-session-store'
import { projectContextWritable, projectGeneration, projectHydrating } from './project-context-lifecycle'

let timer: ReturnType<typeof setTimeout> | undefined
let chain = Promise.resolve()

export function captureProjectWorkContext(): ProjectWorkContext | null {
  const workspace = useWorkspaceStore.getState()
  const draft = useGenerationDraftStore.getState()
  const creation = useCreationSessionStore.getState()
  if (draft.projectId !== workspace.scene.projectId || creation.projectId !== draft.projectId) return null
  const generation = generationWorkContextFields.strip().parse(draft)
  return projectWorkContextSchema.parse({ version: 1, projectId: draft.projectId, generation, conversationDraft: creation.draft,
    workspace: { activeView: workspace.activeView, selectedIds: workspace.selectedIds, zoom: workspace.zoom, pan: workspace.pan,
      inspectorOpen: workspace.inspectorOpen, inspectorTab: workspace.inspectorTab,
      transformRatioLocked: workspace.transformRatioLocked, geometryUnit: workspace.geometryUnit } })
}

export async function flushProjectWorkContext(): Promise<void> {
  const focused = document.activeElement
  if (focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement) focused.blur()
  return saveProjectWorkContext()
}

// Background persistence must never end an active edit or IME composition.
// Explicit navigation/close flushes still blur first to commit local field drafts.
async function saveProjectWorkContext(): Promise<void> {
  clearTimeout(timer)
  if (!projectContextWritable()) return chain
  const context = captureProjectWorkContext()
  const generation = projectGeneration()
  if (context === null || window.desktop?.saveProjectWorkContext === undefined) return chain
  const save = async (): Promise<void> => {
    await window.desktop.saveProjectWorkContext(context)
    if (projectGeneration() === generation && useWorkspaceStore.getState().scene.projectId === context.projectId) useWorkspaceStore.setState({ workContextProblem: null })
  }
  const result = chain.then(save, save)
  chain = result.catch(() => undefined)
  return result
}

export function startProjectContextSync(): () => void {
  let previous = ''
  let reporting = false
  const reportProblem = (error: unknown): void => {
    if (reporting) return
    reporting = true
    try { useWorkspaceStore.setState({ workContextProblem: error instanceof Error && error.name === 'ZodError'
      ? '工作状态未保存：文字草稿最多 8000 字，比例最多 40 字。请调整后重试。'
      : '工作状态未保存。请保留窗口，稍后重试保存；你的画布仍可查看。' }) } finally { reporting = false }
  }
  const changed = (): void => {
    if (reporting || projectHydrating() || !projectContextWritable()) return
    let context: ProjectWorkContext | null
    try { context = captureProjectWorkContext() } catch (error) { reportProblem(error); return }
    const serialized = JSON.stringify(context)
    if (serialized === previous) return
    previous = serialized
    clearTimeout(timer)
    timer = setTimeout(() => { void saveProjectWorkContext().catch(reportProblem) }, 150)
  }
  const flush = (): void => { void flushProjectWorkContext().catch(reportProblem) }
  const unsubscribeClose = window.desktop?.onWindowClosing?.(async () => {
    try { await flushProjectWorkContext() } catch (error) { reportProblem(error); throw error }
  })
  const unsubscribers = [useGenerationDraftStore.subscribe(changed), useCreationSessionStore.subscribe(changed), useWorkspaceStore.subscribe(changed)]
  window.addEventListener('blur', flush)
  return () => { unsubscribers.forEach((unsubscribe) => unsubscribe()); unsubscribeClose?.(); window.removeEventListener('blur', flush); clearTimeout(timer) }
}
