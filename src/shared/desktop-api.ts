import type { AgentRequest, AgentRun, ConversationSnapshot } from './agent'
import type { AcceptDesignReviewInput } from './design-capability'
import type { AppearanceSettingsSnapshot, AppearanceSettingsUpdate } from './appearance-settings'
import type { AgentEvent, AgentHarnessSnapshot, AgentMode, AgentTaskDispatch, TaskRelation, TurnInputMode } from './agent-harness'
import type {
  CreateMemoryCandidateInput,
  CreateProjectDirectiveInput,
  CreateProjectMemoryInput,
  ProjectKnowledgeSnapshot,
  ResolveMemoryCandidateInput,
  SetOutboundPolicyInput,
  UpdateProjectDirectiveInput,
  UpdateProjectMemoryInput
} from './agent-context'
import type { GenerationJob, GenerationProfileRequest, GenerationProfileSnapshot, GenerationRequest, ProviderCapabilities } from './generation'
import type { CanvasGenerationInput, CanvasGenerationResult } from './reference'
import type { CanvasEditInput, CanvasEditResult } from './edit'
import type {
  GenerationResultFamily,
  GenerationResultFavoriteInput,
  PlaceGenerationResultInput,
  PlaceGenerationResultReceipt
} from './generation-workflow'
import type {
  ConfigurableProviderId,
  ProviderConnectionTestInput,
  ProviderConnectionTestResult,
  ProviderExecutionPolicy,
  ProviderPublicConfig,
  ProviderSecretInput,
  ProviderSettingsSnapshot
} from './provider-settings'
import type {
  AssetImportInput,
  ImportedAsset,
  ProjectActionResult,
  ProjectCreateInput,
  ProjectDeleteResult,
  ProjectFavoriteInput,
  ProjectLibraryChangeMode,
  ProjectLibraryLocationResult,
  RecentProjectSummary,
  WorkspaceBootstrap
} from './project'
import type {
  SceneChangedEvent,
  SceneExecuteInput,
  SceneHistoryInput,
  SceneMutationResult
} from './scene-authority'
import type { DesignDirectionSelectionInput, DesignDirectionSelectionResult } from './design-direction-selection'
import type { DiagnosticExportResult } from './diagnostics'
import type { ProjectWorkContext } from './project-work-context'
import type { GenerationReferencePreviewInput, GenerationReferencePreview } from './generation-reference'

export const DESKTOP_CHANNELS = {
  runtimeInfo: 'desktop:runtime-info',
  appearanceSettings: 'appearance:settings',
  appearanceSettingsSet: 'appearance:settings-set',
  diagnosticExport: 'diagnostic:export',
  generationProviders: 'generation:providers',
  generationProfiles: 'generation:profiles',
  generationJobs: 'generation:jobs',
  generationEnqueue: 'generation:enqueue',
  generationProfileEnqueue: 'generation:profile-enqueue',
  generationReferencePreview: 'generation:reference-preview',
  generationCancel: 'generation:cancel',
  generationRetry: 'generation:retry',
  generationResultFamilies: 'generation:result-families',
  generationResultFavorite: 'generation:result-favorite',
  generationResultPlace: 'generation:result-place',
  generationAsset: 'generation:asset',
  canvasGeneration: 'generation:canvas',
  canvasEdit: 'generation:edit',
  providerSettings: 'provider:settings',
  providerConnectionTest: 'provider:connection-test',
  providerConfigSet: 'provider:config-set',
  providerExecutionPolicySet: 'provider:execution-policy-set',
  providerSecretSet: 'provider:secret-set',
  providerSecretDelete: 'provider:secret-delete',
  projectRecent: 'project:recent',
  projectCreate: 'project:create',
  projectOpen: 'project:open',
  projectOpenRecent: 'project:open-recent',
  projectRelocateRecent: 'project:relocate-recent',
  projectDeleteRecent: 'project:delete-recent',
  projectFavoriteSet: 'project:favorite-set',
  projectLibraryChange: 'project:library-change',
  projectSaveAs: 'project:save-as',
  assetImport: 'asset:import',
  workspaceBootstrap: 'workspace:bootstrap',
  projectWorkContextSave: 'project:work-context-save',
  windowCloseReady: 'window:close-ready',
  windowCloseReceipt: 'window:close-receipt',
  sceneExecute: 'scene:execute',
  sceneUndo: 'scene:undo',
  sceneRedo: 'scene:redo',
  designDirectionSelect: 'agent:design-direction-select',
  designReviewAccept: 'agent:design-review-accept',
  conversationSnapshot: 'agent:conversation-snapshot',
  agentHarnessSnapshot: 'agent:harness-snapshot',
  agentKnowledge: 'agent:knowledge',
  agentDirectiveCreate: 'agent:directive-create',
  agentDirectiveUpdate: 'agent:directive-update',
  agentMemoryCreate: 'agent:memory-create',
  agentMemoryUpdate: 'agent:memory-update',
  agentMemoryCandidateCreate: 'agent:memory-candidate-create',
  agentMemoryCandidateResolve: 'agent:memory-candidate-resolve',
  agentOutboundPolicySet: 'agent:outbound-policy-set',
  agentEventReplay: 'agent:event-replay',
  agentStart: 'agent:start',
  agentInput: 'agent:input',
  agentTemporaryResolve: 'agent:temporary-resolve',
  agentQueueResume: 'agent:queue-resume',
  agentConfirm: 'agent:confirm',
  agentCancel: 'agent:cancel',
  activityBatchUndone: 'activity:batch-undone'
} as const

export const DESKTOP_EVENTS = {
  windowClosing: 'window:closing',
  sceneChanged: 'scene:changed',
  agentEvent: 'agent:event',
  appearanceChanged: 'appearance:changed'
} as const

export type DesktopPlatform =
  | 'aix'
  | 'android'
  | 'cygwin'
  | 'darwin'
  | 'freebsd'
  | 'haiku'
  | 'linux'
  | 'netbsd'
  | 'openbsd'
  | 'sunos'
  | 'win32'

export interface NativeModuleHealth {
  readonly betterSqlite3: boolean
  readonly sharp: boolean
  readonly sqliteVersion: string | null
  readonly sharpVersion: string | null
}

export interface RuntimeInfo {
  readonly appVersion: string
  readonly electronVersion: string
  readonly platform: DesktopPlatform
  readonly systemTheme: 'light' | 'dark'
  readonly backgroundMaterial: 'mica' | 'solid'
  readonly startupRoute: 'library' | 'workspace'
  readonly projectLibraryPath: string
  readonly nativeModules: NativeModuleHealth
}

export interface GenerationProviderInfo {
  readonly id: string
  readonly label: string
  readonly capabilities: ProviderCapabilities
  readonly models: readonly {
    readonly id: string
    readonly label: string
    readonly behavior: string
  }[]
}

export interface DesktopApi {
  onWindowClosing(listener: () => Promise<void>): () => void
  getRuntimeInfo(): Promise<RuntimeInfo>
  getAppearanceSettings(): Promise<AppearanceSettingsSnapshot>
  setAppearanceSettings(input: AppearanceSettingsUpdate): Promise<AppearanceSettingsSnapshot>
  exportDiagnostics(): Promise<DiagnosticExportResult>
  onAppearanceChanged(listener: (snapshot: AppearanceSettingsSnapshot) => void): () => void
  listGenerationProviders(): Promise<readonly GenerationProviderInfo[]>
  listGenerationProfiles(): Promise<GenerationProfileSnapshot>
  listGenerationJobs(): Promise<readonly GenerationJob[]>
  enqueueGeneration(request: GenerationRequest): Promise<GenerationJob>
  enqueueGenerationProfile(request: GenerationProfileRequest): Promise<GenerationJob>
  previewGenerationReference(input: GenerationReferencePreviewInput): Promise<GenerationReferencePreview>
  cancelGeneration(jobId: string): Promise<GenerationJob>
  retryGeneration(jobId: string, overrides?: { readonly providerId?: string; readonly model?: string }): Promise<GenerationJob>
  listGenerationResultFamilies(): Promise<readonly GenerationResultFamily[]>
  setGenerationResultFavorite(input: GenerationResultFavoriteInput): Promise<readonly GenerationResultFamily[]>
  placeGenerationResult(input: PlaceGenerationResultInput): Promise<PlaceGenerationResultReceipt>
  readGenerationAsset(assetId: string, thumbnail?: boolean, projectId?: string): Promise<string>
  generateFromCanvas(input: CanvasGenerationInput): Promise<CanvasGenerationResult>
  editFromCanvas(input: CanvasEditInput): Promise<CanvasEditResult>
  getProviderSettings(): Promise<ProviderSettingsSnapshot>
  validateProviderConnection(input: ProviderConnectionTestInput): Promise<ProviderConnectionTestResult>
  setProviderConfig(input: ProviderPublicConfig): Promise<ProviderSettingsSnapshot>
  setProviderExecutionPolicy(input: ProviderExecutionPolicy): Promise<ProviderSettingsSnapshot>
  setProviderSecret(input: ProviderSecretInput): Promise<ProviderSettingsSnapshot>
  deleteProviderSecret(providerId: ConfigurableProviderId): Promise<ProviderSettingsSnapshot>
  listRecentProjects(): Promise<readonly RecentProjectSummary[]>
  createProject(input: ProjectCreateInput): Promise<ProjectActionResult>
  openProject(): Promise<ProjectActionResult>
  openRecentProject(projectId: string): Promise<WorkspaceBootstrap>
  relocateRecentProject(projectId: string): Promise<ProjectActionResult>
  deleteRecentProject(projectId: string): Promise<ProjectDeleteResult>
  setProjectFavorite(input: ProjectFavoriteInput): Promise<readonly RecentProjectSummary[]>
  changeProjectLibraryLocation(mode: ProjectLibraryChangeMode): Promise<ProjectLibraryLocationResult>
  saveProjectAs(input: ProjectCreateInput): Promise<ProjectActionResult>
  importAsset(input: AssetImportInput): Promise<ImportedAsset>
  getWorkspaceBootstrap(): Promise<WorkspaceBootstrap>
  saveProjectWorkContext(context: ProjectWorkContext): Promise<void>
  executeSceneCommands(input: SceneExecuteInput): Promise<SceneMutationResult>
  undoScene(input: SceneHistoryInput): Promise<SceneMutationResult>
  redoScene(input: SceneHistoryInput): Promise<SceneMutationResult>
  selectDesignDirection(input: DesignDirectionSelectionInput): Promise<DesignDirectionSelectionResult>
  onSceneChanged(listener: (event: SceneChangedEvent) => void): () => void
  getConversationSnapshot(): Promise<ConversationSnapshot>
  acceptDesignReview(input: AcceptDesignReviewInput): Promise<ConversationSnapshot>
  getAgentHarnessSnapshot(): Promise<AgentHarnessSnapshot>
  getProjectKnowledge(): Promise<ProjectKnowledgeSnapshot>
  createProjectDirective(input: CreateProjectDirectiveInput): Promise<ProjectKnowledgeSnapshot>
  updateProjectDirective(input: UpdateProjectDirectiveInput): Promise<ProjectKnowledgeSnapshot>
  createProjectMemory(input: CreateProjectMemoryInput): Promise<ProjectKnowledgeSnapshot>
  updateProjectMemory(input: UpdateProjectMemoryInput): Promise<ProjectKnowledgeSnapshot>
  createMemoryCandidate(input: CreateMemoryCandidateInput): Promise<ProjectKnowledgeSnapshot>
  resolveMemoryCandidate(input: ResolveMemoryCandidateInput): Promise<ProjectKnowledgeSnapshot>
  setOutboundPolicy(input: SetOutboundPolicyInput): Promise<ProjectKnowledgeSnapshot>
  replayAgentEvents(afterSequence: number, limit?: number): Promise<readonly AgentEvent[]>
  startAgentRun(request: AgentRequest, mode?: AgentMode, taskRelation?: TaskRelation): Promise<AgentRun>
  inputAgentRun(request: AgentRequest, semantics: TurnInputMode | AgentTaskDispatch): Promise<AgentRun>
  resolveTemporaryAgentTurn(turnId: string, resolution: 'accept' | 'reject'): Promise<AgentHarnessSnapshot>
  resumeAgentQueue(): Promise<number>
  onAgentEvent(listener: (event: AgentEvent) => void): () => void
  confirmAgentRun(runId: string, optionId?: string): Promise<AgentRun>
  cancelAgentRun(runId: string): Promise<AgentRun>
  markActivityBatchUndone(batchId: string): Promise<void>
}
