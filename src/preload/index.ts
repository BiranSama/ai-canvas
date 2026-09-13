import { contextBridge, ipcRenderer } from 'electron'
import type { AppearanceSettingsSnapshot, AppearanceSettingsUpdate } from '../shared/appearance-settings'
import { DESKTOP_CHANNELS, DESKTOP_EVENTS, type DesktopApi, type RuntimeInfo } from '../shared/desktop-api'
import type { GenerationProfileRequest, GenerationRequest } from '../shared/generation'
import type { GenerationReferencePreviewInput } from '../shared/generation-reference'
import type { AgentRequest } from '../shared/agent'
import type { AcceptDesignReviewInput } from '../shared/design-capability'
import type { AgentEvent, AgentMode, AgentTaskDispatch, TaskRelation, TurnInputMode } from '../shared/agent-harness'
import type {
  CreateMemoryCandidateInput,
  CreateProjectDirectiveInput,
  CreateProjectMemoryInput,
  ResolveMemoryCandidateInput,
  SetOutboundPolicyInput,
  UpdateProjectDirectiveInput,
  UpdateProjectMemoryInput
} from '../shared/agent-context'
import type { CanvasGenerationInput } from '../shared/reference'
import type { CanvasEditInput } from '../shared/edit'
import type { GenerationResultFavoriteInput, PlaceGenerationResultInput } from '../shared/generation-workflow'
import type {
  ConfigurableProviderId,
  ProviderConnectionTestInput,
  ProviderExecutionPolicy,
  ProviderPublicConfig,
  ProviderSecretInput
} from '../shared/provider-settings'
import type { AssetImportInput, ProjectCreateInput, ProjectFavoriteInput, ProjectLibraryChangeMode } from '../shared/project'
import type { SceneChangedEvent, SceneExecuteInput, SceneHistoryInput } from '../shared/scene-authority'
import type { DesignDirectionSelectionInput } from '../shared/design-direction-selection'
import type { ProjectWorkContext } from '../shared/project-work-context'

const desktopApi: DesktopApi = Object.freeze({
  getRuntimeInfo: (): Promise<RuntimeInfo> => ipcRenderer.invoke(DESKTOP_CHANNELS.runtimeInfo),
  getAppearanceSettings: (): Promise<AppearanceSettingsSnapshot> => ipcRenderer.invoke(DESKTOP_CHANNELS.appearanceSettings),
  setAppearanceSettings: (input: AppearanceSettingsUpdate): Promise<AppearanceSettingsSnapshot> =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.appearanceSettingsSet, input),
  exportDiagnostics: () => ipcRenderer.invoke(DESKTOP_CHANNELS.diagnosticExport, {}),
  onAppearanceChanged: (listener: (snapshot: AppearanceSettingsSnapshot) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, value: AppearanceSettingsSnapshot): void => listener(value)
    ipcRenderer.on(DESKTOP_EVENTS.appearanceChanged, handler)
    return () => ipcRenderer.removeListener(DESKTOP_EVENTS.appearanceChanged, handler)
  },
  listGenerationProviders: () => ipcRenderer.invoke(DESKTOP_CHANNELS.generationProviders),
  listGenerationProfiles: () => ipcRenderer.invoke(DESKTOP_CHANNELS.generationProfiles),
  listGenerationJobs: () => ipcRenderer.invoke(DESKTOP_CHANNELS.generationJobs),
  enqueueGeneration: (request: GenerationRequest) => ipcRenderer.invoke(DESKTOP_CHANNELS.generationEnqueue, request),
  enqueueGenerationProfile: (request: GenerationProfileRequest) => ipcRenderer.invoke(DESKTOP_CHANNELS.generationProfileEnqueue, request),
  previewGenerationReference: (input: GenerationReferencePreviewInput) => ipcRenderer.invoke(DESKTOP_CHANNELS.generationReferencePreview, input),
  cancelGeneration: (jobId: string) => ipcRenderer.invoke(DESKTOP_CHANNELS.generationCancel, jobId),
  retryGeneration: (jobId: string, overrides: { readonly providerId?: string; readonly model?: string } = {}) =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.generationRetry, { jobId, overrides }),
  listGenerationResultFamilies: () => ipcRenderer.invoke(DESKTOP_CHANNELS.generationResultFamilies),
  setGenerationResultFavorite: (input: GenerationResultFavoriteInput) => ipcRenderer.invoke(DESKTOP_CHANNELS.generationResultFavorite, input),
  placeGenerationResult: (input: PlaceGenerationResultInput) => ipcRenderer.invoke(DESKTOP_CHANNELS.generationResultPlace, input),
  readGenerationAsset: (assetId: string, thumbnail = true, projectId?: string) =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.generationAsset, { assetId, thumbnail, projectId }),
  generateFromCanvas: (input: CanvasGenerationInput) => ipcRenderer.invoke(DESKTOP_CHANNELS.canvasGeneration, input),
  editFromCanvas: (input: CanvasEditInput) => ipcRenderer.invoke(DESKTOP_CHANNELS.canvasEdit, input),
  getProviderSettings: () => ipcRenderer.invoke(DESKTOP_CHANNELS.providerSettings),
  validateProviderConnection: (input: ProviderConnectionTestInput) => ipcRenderer.invoke(DESKTOP_CHANNELS.providerConnectionTest, input),
  setProviderConfig: (input: ProviderPublicConfig) => ipcRenderer.invoke(DESKTOP_CHANNELS.providerConfigSet, input),
  setProviderExecutionPolicy: (input: ProviderExecutionPolicy) => ipcRenderer.invoke(DESKTOP_CHANNELS.providerExecutionPolicySet, input),
  setProviderSecret: (input: ProviderSecretInput) => ipcRenderer.invoke(DESKTOP_CHANNELS.providerSecretSet, input),
  deleteProviderSecret: (providerId: ConfigurableProviderId) => ipcRenderer.invoke(DESKTOP_CHANNELS.providerSecretDelete, providerId),
  listRecentProjects: () => ipcRenderer.invoke(DESKTOP_CHANNELS.projectRecent),
  createProject: (input: ProjectCreateInput) => ipcRenderer.invoke(DESKTOP_CHANNELS.projectCreate, input),
  openProject: () => ipcRenderer.invoke(DESKTOP_CHANNELS.projectOpen),
  openRecentProject: (projectId: string) => ipcRenderer.invoke(DESKTOP_CHANNELS.projectOpenRecent, projectId),
  relocateRecentProject: (projectId: string) => ipcRenderer.invoke(DESKTOP_CHANNELS.projectRelocateRecent, projectId),
  deleteRecentProject: (projectId: string) => ipcRenderer.invoke(DESKTOP_CHANNELS.projectDeleteRecent, projectId),
  setProjectFavorite: (input: ProjectFavoriteInput) => ipcRenderer.invoke(DESKTOP_CHANNELS.projectFavoriteSet, input),
  changeProjectLibraryLocation: (mode: ProjectLibraryChangeMode) => ipcRenderer.invoke(DESKTOP_CHANNELS.projectLibraryChange, mode),
  saveProjectAs: (input: ProjectCreateInput) => ipcRenderer.invoke(DESKTOP_CHANNELS.projectSaveAs, input),
  importAsset: (input: AssetImportInput) => ipcRenderer.invoke(DESKTOP_CHANNELS.assetImport, input),
  getWorkspaceBootstrap: () => ipcRenderer.invoke(DESKTOP_CHANNELS.workspaceBootstrap),
  saveProjectWorkContext: (context: ProjectWorkContext) => ipcRenderer.invoke(DESKTOP_CHANNELS.projectWorkContextSave, context),
  onWindowClosing: (listener: () => Promise<void>) => {
    const handler = (_event: Electron.IpcRendererEvent, requestId: string): void => {
      void Promise.resolve().then(listener).then(
        () => ipcRenderer.send(DESKTOP_CHANNELS.windowCloseReceipt, { requestId, saved: true }),
        () => ipcRenderer.send(DESKTOP_CHANNELS.windowCloseReceipt, { requestId, saved: false })
      )
    }
    ipcRenderer.on(DESKTOP_EVENTS.windowClosing, handler)
    ipcRenderer.send(DESKTOP_CHANNELS.windowCloseReady, true)
    return () => { ipcRenderer.removeListener(DESKTOP_EVENTS.windowClosing, handler); ipcRenderer.send(DESKTOP_CHANNELS.windowCloseReady, false) }
  },
  executeSceneCommands: (input: SceneExecuteInput) => ipcRenderer.invoke(DESKTOP_CHANNELS.sceneExecute, input),
  undoScene: (input: SceneHistoryInput) => ipcRenderer.invoke(DESKTOP_CHANNELS.sceneUndo, input),
  redoScene: (input: SceneHistoryInput) => ipcRenderer.invoke(DESKTOP_CHANNELS.sceneRedo, input),
  selectDesignDirection: (input: DesignDirectionSelectionInput) => ipcRenderer.invoke(DESKTOP_CHANNELS.designDirectionSelect, input),
  acceptDesignReview: (input: AcceptDesignReviewInput) => ipcRenderer.invoke(DESKTOP_CHANNELS.designReviewAccept, input),
  onSceneChanged: (listener: (event: SceneChangedEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, value: SceneChangedEvent): void => listener(value)
    ipcRenderer.on(DESKTOP_EVENTS.sceneChanged, handler)
    return () => ipcRenderer.removeListener(DESKTOP_EVENTS.sceneChanged, handler)
  },
  getConversationSnapshot: () => ipcRenderer.invoke(DESKTOP_CHANNELS.conversationSnapshot),
  getAgentHarnessSnapshot: () => ipcRenderer.invoke(DESKTOP_CHANNELS.agentHarnessSnapshot),
  getProjectKnowledge: () => ipcRenderer.invoke(DESKTOP_CHANNELS.agentKnowledge),
  createProjectDirective: (input: CreateProjectDirectiveInput) => ipcRenderer.invoke(DESKTOP_CHANNELS.agentDirectiveCreate, input),
  updateProjectDirective: (input: UpdateProjectDirectiveInput) => ipcRenderer.invoke(DESKTOP_CHANNELS.agentDirectiveUpdate, input),
  createProjectMemory: (input: CreateProjectMemoryInput) => ipcRenderer.invoke(DESKTOP_CHANNELS.agentMemoryCreate, input),
  updateProjectMemory: (input: UpdateProjectMemoryInput) => ipcRenderer.invoke(DESKTOP_CHANNELS.agentMemoryUpdate, input),
  createMemoryCandidate: (input: CreateMemoryCandidateInput) => ipcRenderer.invoke(DESKTOP_CHANNELS.agentMemoryCandidateCreate, input),
  resolveMemoryCandidate: (input: ResolveMemoryCandidateInput) => ipcRenderer.invoke(DESKTOP_CHANNELS.agentMemoryCandidateResolve, input),
  setOutboundPolicy: (input: SetOutboundPolicyInput) => ipcRenderer.invoke(DESKTOP_CHANNELS.agentOutboundPolicySet, input),
  replayAgentEvents: (afterSequence: number, limit = 1_000) =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.agentEventReplay, { afterSequence, limit }),
  startAgentRun: (request: AgentRequest, mode: AgentMode = 'collaboration', taskRelation?: TaskRelation) =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.agentStart, { request, mode, ...(taskRelation === undefined ? {} : { taskRelation }) }),
  inputAgentRun: (request: AgentRequest, semantics: TurnInputMode | AgentTaskDispatch) =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.agentInput, typeof semantics === 'string' ? { request, mode: semantics } : { request, ...semantics }),
  resolveTemporaryAgentTurn: (turnId: string, resolution: 'accept' | 'reject') =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.agentTemporaryResolve, { turnId, resolution }),
  resumeAgentQueue: () => ipcRenderer.invoke(DESKTOP_CHANNELS.agentQueueResume),
  onAgentEvent: (listener: (event: AgentEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, value: AgentEvent): void => listener(value)
    ipcRenderer.on(DESKTOP_EVENTS.agentEvent, handler)
    return () => ipcRenderer.removeListener(DESKTOP_EVENTS.agentEvent, handler)
  },
  confirmAgentRun: (runId: string, optionId?: string) => ipcRenderer.invoke(DESKTOP_CHANNELS.agentConfirm, { runId, optionId }),
  cancelAgentRun: (runId: string) => ipcRenderer.invoke(DESKTOP_CHANNELS.agentCancel, runId),
  markActivityBatchUndone: (batchId: string) => ipcRenderer.invoke(DESKTOP_CHANNELS.activityBatchUndone, batchId)
})

contextBridge.exposeInMainWorld('desktop', desktopApi)
