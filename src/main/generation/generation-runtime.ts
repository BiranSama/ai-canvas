import { createHash, randomUUID } from 'node:crypto'
import { summarizeGenerationCosts } from '../../shared/generation-cost'
import { generationReferencePreviewInputSchema, type GenerationReferencePreviewInput, type GenerationReferencePreview, type GenerationReferenceSource } from '../../shared/generation-reference'
import { resolveGenerationReference } from '../reference/generation-reference-source'
import { acceptDesignReviewInputSchema, type AcceptDesignReviewInput } from '../../shared/design-capability'
import { lstat, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path'
import type { AgentPlan, AgentRequest, AgentRun, AgentToolOutcome, AgentToolPlan, ConversationSnapshot, SceneSummary } from '../../shared/agent'
import { ephemeralAnnotationSchema, type EphemeralAnnotation } from '../../shared/agent'
import { ELEMENT_SCHEMA_VERSION, type Scene, type SceneElement } from '../../domain'
import type { AgentSceneToolCommitReceipt } from '../../shared/agent-tools'
import type { AgentEvent, AgentHarnessSnapshot, AgentMode, AgentTaskDispatch, TaskRelation, TurnInputMode } from '../../shared/agent-harness'
import type {
  CreateMemoryCandidateInput,
  CreateProjectDirectiveInput,
  CreateProjectMemoryInput,
  ProjectKnowledgeSnapshot,
  ResolveMemoryCandidateInput,
  SetOutboundPolicyInput,
  UpdateProjectDirectiveInput,
  UpdateProjectMemoryInput
} from '../../shared/agent-context'
import type { OutboundContextRecord } from '../../shared/agent-context'
import type {
  SceneChangedEvent,
  SceneExecuteInput,
  SceneHistoryInput,
  SceneMutationResult
} from '../../shared/scene-authority'
import {
  imageTaskRequestSchema,
  type GenerationJob,
  type GenerationProfileRequest,
  type GenerationProfileSnapshot,
  type GenerationRequest,
  type ImageTaskRequest
} from '../../shared/generation'
import {
  generationResultFavoriteInputSchema,
  placeGenerationResultInputSchema,
  placeGenerationResultReceiptSchema,
  type GenerationResultFamily,
  type GenerationResultFavoriteInput,
  type GenerationWorkflowOperation,
  type PlaceGenerationResultInput,
  type PlaceGenerationResultReceipt
} from '../../shared/generation-workflow'
import { canvasEditInputSchema, canvasEditResultSchema, type CanvasEditInput, type CanvasEditResult } from '../../shared/edit'
import {
  canvasGenerationInputSchema,
  canvasGenerationResultSchema,
  type CanvasGenerationInput,
  type CanvasGenerationResult
} from '../../shared/reference'
import {
  AgentRuntime,
  AgentContextRepository,
  AgentHarnessRepository,
  ActivityLedgerRepository,
  AgentToolCallRepository,
  AgentToolExecutorError,
  AgentToolExecutorShadow,
  ArkAgentPlanner,
  ConfiguredAgentPlanner,
  ConversationRepository,
  createConfiguredLlmProtocol,
  DeterministicMockPlanner,
  GenerationPolicy,
  OutboundContextService
} from '../agent'
import type { AgentLoopToolContext } from '../agent'
import { projectWorkContextSchema, type ProjectWorkContext } from '../../shared/project-work-context'
import { blendModeCommandViolation, compileAtomicSceneCommands, isAtomicSceneWriteTool } from '../agent/atomic-scene-tools'
import { compileDesignDirectionSelection } from '../agent/design-direction-selection'
import { EditMaskCompiler } from '../edit'
import { buildTransientAnnotationMasks } from '../../shared/ephemeral-annotation'
import { ProviderSettingsService } from '../security/provider-settings-service'
import { FileProviderConfigStore } from '../security/provider-config-store'
import { FileRedactedLogger } from '../security/file-redacted-logger'
import { ElectronSecretVault } from '../security/secret-vault'
import { ImageExecutionBindings, executionInputHash, executionRequestHash, type ImageExecutionBinding } from '../security/image-execution-bindings'
import { ArkHttpClient } from '../security/ark-http-client'
import { KrillHttpTransport } from '../security/krill-http-transport'
import { ProviderUsageLedger } from '../security/provider-usage-ledger'
import { ProviderConnectionValidator } from '../security/provider-connection-validator'
import { DEFAULT_PROVIDER_EXECUTION_POLICY, resolveImageProtocolEndpoint } from '../../shared/provider-settings'
import type {
  ConfigurableProviderId,
  ProviderExecutionPolicy,
  ProviderConfigFile,
  ProviderConnectionTestInput,
  ProviderConnectionTestResult,
  ProviderPublicConfig,
  ProviderSecretInput,
  ProviderSettingsSnapshot
} from '../../shared/provider-settings'
import type {
  AssetImportInput,
  ImportedAsset,
  ProjectDeleteResult,
  ProjectLibraryChangeMode,
  ProjectLibraryLocationResult,
  ProjectLibrarySettings,
  RecentProjectSummary,
  WorkspaceBootstrap
} from '../../shared/project'
import { ReferenceCompiler } from '../reference'
import { SceneService } from '../scene'
import { ProjectWorkspace, type OpenProjectResult } from '../storage/project-workspace'
import { RecentProjectsStore } from '../storage/recent-projects-store'
import {
  allocateProjectDirectory,
  inspectProjectPackage,
  LibrarySettingsStore,
  migrateProjectLibrary,
  projectPackageStatus,
  rebuildProjectCover
} from '../storage/project-library'
import { GenerationJobRepository } from './generation-job-repository'
import { GenerationWorkflowCoordinator } from './generation-workflow-coordinator'
import { GenerationWorkflowRepository } from './generation-workflow-repository'
import { GenerationProfileRegistry } from './generation-profiles'
import { GenerationQueue } from './generation-queue'
import { ArkSeedreamImageProvider } from './ark-seedream-provider'
import { ARK_SEEDREAM_CAPABILITIES, ArkSeedreamProtocol } from './ark-seedream-protocol'
import { KrillImageProvider } from './krill-image-provider'
import { OPENAI_IMAGES_CAPABILITIES, OpenAiImagesProtocol } from './openai-images-protocol'
import { OpenAiImagesProvider } from './openai-images-provider'
import { TASK_IMAGES_CAPABILITIES, TaskImagesProtocol } from './task-images-protocol'
import { MockImageProvider } from './mock-image-provider'
import { ProviderError, ProviderRegistry, type ImageProvider } from './provider'
import type { ProviderCapabilities } from '../../shared/generation'
import { measureOutboundImagePayload } from './outbound-image-audit'
import type { AppearanceSettingsSnapshot } from '../../shared/appearance-settings'
import { diagnosticExportResultSchema, type DiagnosticExportResult } from '../../shared/diagnostics'
import { parseAgentObservableEvent } from '../../shared/agent-observability'
import {
  DiagnosticExportService,
  type DiagnosticExportSourceSnapshot
} from '../diagnostics/diagnostic-export-service'
import {
  designDirectionSelectionInputSchema,
  designDirectionSelectionResultSchema,
  type DesignDirectionSelectionInput,
  type DesignDirectionSelectionResult
} from '../../shared/design-direction-selection'

export interface GenerationProviderInfo {
  readonly id: string
  readonly label: string
  readonly capabilities: ReturnType<ProviderRegistry['list']>[number]['capabilities']
  readonly models: readonly { readonly id: string; readonly label: string; readonly behavior: string }[]
}

export interface GenerationRuntimeOptions {
  readonly projectLibraryDirectory?: string
}

type ImageProviderConfig = Extract<ProviderPublicConfig, { kind: 'image' }>
type AgentGenerationAuthority = Pick<AgentLoopToolContext, 'projectId' | 'threadId' | 'turnId' | 'toolCallItemId'>

interface WorkflowMetadata {
  readonly agentScope?: AgentGenerationAuthority
  readonly operation: GenerationWorkflowOperation
  readonly sourceSceneRevision: number | null
  readonly promptPackage: unknown | null
  readonly deferActivation?: boolean
  readonly parentJobId?: string | null
  readonly idempotencyKey?: string
  readonly retryExecution?: ImageExecutionBinding
}

function workflowIdentity(request: Pick<ImageTaskRequest, 'parameters' | 'sourceMessageId' | 'prompt' | 'negativePrompt'
  | 'aspectWidth' | 'aspectHeight' | 'outputWidth' | 'outputHeight' | 'count' | 'references' | 'parentResultId'>,
  metadata: Pick<WorkflowMetadata, 'operation' | 'sourceSceneRevision' | 'idempotencyKey'>): string {
  const explicitKey = request.parameters.workflowIdempotencyKey
  const invocationId = request.parameters.workflowInvocationId
  return metadata.idempotencyKey ?? (typeof explicitKey === 'string' && explicitKey.trim().length > 0 ? explicitKey
    : typeof invocationId === 'string' && invocationId.trim().length > 0 ? `tool:${invocationId}`
      : request.sourceMessageId === null ? `manual:${randomUUID()}`
        : `message:${request.sourceMessageId}:${createHash('sha256').update(JSON.stringify({
            operation: metadata.operation, prompt: request.prompt, negativePrompt: request.negativePrompt,
            aspect: [request.aspectWidth, request.aspectHeight], output: [request.outputWidth, request.outputHeight],
            count: request.count, references: request.references, parentResultId: request.parentResultId,
            sourceSceneRevision: metadata.sourceSceneRevision
          })).digest('hex')}`)
}

function configuredImageCapabilities(
  image: ImageProviderConfig,
  protocol: ProviderCapabilities,
  policy: ProviderExecutionPolicy
): ProviderCapabilities {
  return {
    textToImage: protocol.textToImage && image.capabilities.textToImage,
    imageReferences: protocol.imageReferences && image.capabilities.imageReferences,
    maskEditing: protocol.maskEditing && image.capabilities.maskEditing,
    multipleReferences: protocol.multipleReferences && image.capabilities.multipleReferences,
    transparentOutput: protocol.transparentOutput && image.capabilities.transparentOutput,
    maxImages: Math.max(1, Math.min(protocol.maxImages, policy.maxImagesPerJob, 4)),
    supportedRatios: protocol.supportedRatios,
    supportedFormats: protocol.supportedFormats
  }
}

class ProductGenerationPolicy extends GenerationPolicy {
  readonly #policy: () => ProviderExecutionPolicy

  constructor(policy: () => ProviderExecutionPolicy) {
    super()
    this.#policy = policy
  }

  override requiresConfirmation(request: AgentRequest, plan: AgentPlan): boolean {
    const hasRealGeneration = plan.tools.some((tool) => {
      if (tool.kind === 'generation') return tool.request.providerId !== 'mock'
      if (tool.kind === 'canvas_generation' || tool.kind === 'canvas_edit') return tool.providerId !== 'mock'
      return false
    })
    const policy = this.#policy()
    if (hasRealGeneration && policy.approvalMode === 'confirm_each') return true
    if (hasRealGeneration && request.autoGenerate && !policy.autoGenerate) return true
    return super.requiresConfirmation(request, plan)
  }
}

async function openDefaultProject(projectDirectory: string): Promise<OpenProjectResult> {
  try {
    await stat(join(projectDirectory, 'project.db'))
    return ProjectWorkspace.open(projectDirectory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return ProjectWorkspace.create(projectDirectory, 'Untitled')
  }
}

function mimeFor(format: 'png' | 'jpeg' | 'webp'): string {
  if (format === 'jpeg') return 'image/jpeg'
  return `image/${format}`
}

function summarizeScene(scene: Scene): SceneSummary {
  return {
    revision: scene.revision,
    canvas: {
      aspectWidth: scene.canvas.aspectWidth,
      aspectHeight: scene.canvas.aspectHeight,
      outputWidth: scene.canvas.outputWidth,
      outputHeight: scene.canvas.outputHeight,
      globalStyle: scene.canvas.globalStyle
    },
    elementCount: scene.elements.length,
    relationCount: scene.relations.length,
    creativeBrief: scene.creativeContext?.brief ?? null,
    creativeContext: scene.creativeContext,
    elements: scene.elements.map((element) => ({
      id: element.id,
      type: element.type,
      name: element.name,
      description: element.description,
      semanticRole: element.semanticRole,
      zIndex: element.zIndex,
      groupId: element.groupId,
      ...(element.type === 'group' ? { childIds: [...element.childIds] } : {}),
      locked: element.locked,
      visible: element.visible,
      referencePolicy: element.referencePolicy,
      ...(element.controlIntent === undefined ? {} : { controlIntent: element.controlIntent }),
      ...(element.provenance === undefined ? {} : { provenance: element.provenance }),
      ...(element.type === 'text' ? {
        content: element.content,
        fontSize: element.fontSize,
        fontFamily: element.fontFamily,
        fontWeight: element.fontWeight,
        align: element.align,
        fill: element.fill,
        accuracy: element.accuracy,
        visualWeight: element.visualWeight ?? 'secondary',
        renderStrategy: element.renderStrategy,
        resultAssetId: element.resultAssetId
      } : {}),
      ...(element.type === 'image' ? {
        assetId: element.assetId,
        hasEditMask: scene.elements.some((mask) => mask.type === 'mask' && mask.targetElementId === element.id && mask.mode === 'edit' && mask.visible)
      } : {}),
      ...(element.type === 'placeholder' ? { subject: element.subject, visualKind: element.visualKind ?? 'generic' } : {}),
      ...(element.type === 'shape' ? { shapeRole: element.role, fill: element.fill } : {}),
      ...(element.type === 'light' ? { lightIntensity: element.intensity } : {}),
      transform: { ...element.transform }
    }))
  }
}

export class GenerationRuntime {
  #project!: OpenProjectResult
  #repository!: GenerationJobRepository
  #queue!: GenerationQueue
  #workflowCoordinator!: GenerationWorkflowCoordinator
  readonly #providers: ProviderRegistry
  readonly #profiles: GenerationProfileRegistry
  #agent!: AgentRuntime
  #referenceCompiler!: ReferenceCompiler
  #editMaskCompiler!: EditMaskCompiler
  readonly #providerSettings: ProviderSettingsService
  readonly #providerConfig: FileProviderConfigStore
  readonly #secrets: ElectronSecretVault
  readonly #executionBindings: ImageExecutionBindings
  readonly #providerUsage: ProviderUsageLedger
  readonly #providerConnection: ProviderConnectionValidator
  #configuredImage: ImageProviderConfig | null = null
  #executionPolicy: ProviderExecutionPolicy = DEFAULT_PROVIDER_EXECUTION_POLICY
  readonly #userDataDirectory: string
  #projectLibraryDirectory: string
  readonly #librarySettings: LibrarySettingsStore
  readonly #recentProjects: RecentProjectsStore
  readonly #diagnosticLog: FileRedactedLogger
  readonly #sceneListeners = new Set<(event: SceneChangedEvent) => void>()
  readonly #agentListeners = new Set<(event: AgentEvent) => void>()
  #sceneService!: SceneService
  #unsubscribeAgentEvents: (() => void) | null = null
  #activityProjectionChain = Promise.resolve()
  #closed = false
  #closingProject = false
  readonly #assetImports = new Set<Promise<ImportedAsset>>()
  #projectLifecycle: Promise<unknown> | null = null
  #closePromise: Promise<void> | null = null

  #runProjectLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#projectLifecycle !== null || this.#closePromise !== null || this.#closed) return Promise.reject(new Error('PROJECT_OPERATION_BUSY: 另一个项目操作尚未完成，请稍后重试。'))
    const sourceDirectory = this.#project.workspace.directory
    const pending = Promise.resolve().then(operation).catch(async (error: unknown) => {
      if (this.#closingProject && !this.#closed) await this.#restoreProject(sourceDirectory)
      throw error
    })
    this.#projectLifecycle = pending
    return pending.finally(() => { if (this.#projectLifecycle === pending) this.#projectLifecycle = null })
  }

  private constructor(
    userDataDirectory: string,
    projectLibraryDirectory: string,
    providers: ProviderRegistry,
    providerSettings: ProviderSettingsService,
    providerConfig: FileProviderConfigStore,
    secrets: ElectronSecretVault,
    providerUsage: ProviderUsageLedger
  ) {
    this.#userDataDirectory = userDataDirectory
    this.#projectLibraryDirectory = projectLibraryDirectory
    this.#librarySettings = new LibrarySettingsStore(
      join(userDataDirectory, 'state', 'library-settings.json'),
      projectLibraryDirectory
    )
    this.#providers = providers
    this.#profiles = new GenerationProfileRegistry(providers, {
      mock: ['mock-balanced', 'mock-slow', 'mock-failure', 'mock-timeout']
    })
    this.#providerSettings = providerSettings
    this.#providerConfig = providerConfig
    this.#secrets = secrets
    this.#executionBindings = new ImageExecutionBindings(join(userDataDirectory, 'security', 'image-executions'))
    this.#providerUsage = providerUsage
    this.#providerConnection = new ProviderConnectionValidator({
      config: providerConfig,
      secrets,
      authorization: providerUsage
    })
    this.#recentProjects = new RecentProjectsStore(join(userDataDirectory, 'state', 'recent-projects.json'))
    this.#diagnosticLog = new FileRedactedLogger(join(userDataDirectory, 'logs', 'diagnostic.jsonl'))
  }

  static async create(userDataDirectory: string, options: GenerationRuntimeOptions = {}): Promise<GenerationRuntime> {
    const defaultProjectLibraryDirectory = options.projectLibraryDirectory ?? join(userDataDirectory, 'projects')
    const librarySettings = new LibrarySettingsStore(
      join(userDataDirectory, 'state', 'library-settings.json'),
      defaultProjectLibraryDirectory
    )
    const projectLibraryDirectory = (await librarySettings.get()).rootDirectory
    const projectDirectory = join(userDataDirectory, 'projects', 'Untitled.aicanvas')
    const recentProjects = new RecentProjectsStore(join(userDataDirectory, 'state', 'recent-projects.json'))
    const mostRecent = (await recentProjects.list())[0]
    let project: OpenProjectResult
    let openedRecent = false
    if (mostRecent === undefined) {
      project = await openDefaultProject(projectDirectory)
    } else {
      try {
        project = await ProjectWorkspace.open(mostRecent.path)
        openedRecent = true
      } catch {
        project = await openDefaultProject(projectDirectory)
      }
    }
    const secrets = new ElectronSecretVault(join(userDataDirectory, 'security', 'provider-secrets.json'))
    const providerConfig = new FileProviderConfigStore(join(userDataDirectory, 'security', 'provider-settings.json'))
    const providerUsage = new ProviderUsageLedger(join(userDataDirectory, 'security', 'provider-usage.json'), providerConfig)
    const providers = new ProviderRegistry([
      new MockImageProvider(join(userDataDirectory, 'generation-staging'))
    ])
    const providerSettings = new ProviderSettingsService(
      secrets,
      providerConfig,
      { realCallsAuthorized: true }
    )
    const runtime = new GenerationRuntime(
      userDataDirectory,
      projectLibraryDirectory,
      providers,
      providerSettings,
      providerConfig,
      secrets,
      providerUsage
    )
    await runtime.#refreshConfiguredImageProvider()
    await runtime.#activate(project, openedRecent)
    return runtime
  }

  async #refreshConfiguredImageProvider(): Promise<void> {
    return this.#providerSettings.withStableConfiguration(async (config) => {
    this.#executionPolicy = config.executionPolicy
    const image = config.providers.find((provider): provider is ImageProviderConfig => provider.kind === 'image') ?? null
    this.#configuredImage = image
    this.#providers.remove('image-provider')
    this.#profiles.setProviderModels('image-provider', [])
    if (image === null) return
    const provider = this.#makeImageProvider(image, config.executionPolicy)
    if (provider === null) return
    this.#providers.replace(provider)
    this.#profiles.setProviderModels(provider.id, [image.defaultModel])
    })
  }

  #makeImageProvider(image: ImageProviderConfig, executionPolicy: ProviderExecutionPolicy,
    secrets: { get(id: string): Promise<string | null>; startRequest?(id: string, send: (secret: string) => Promise<Response>): Promise<Response> } = this.#secrets,
    authorizationScopeId?: string): ImageProvider | null {
    if (image.baseUrl === '' || image.defaultModel === '' || image.protocol === 'unconfigured') return null
    const authorization = { reserve: (input: Parameters<ProviderUsageLedger['reserve']>[0]) => this.#providerUsage.reserve({
      ...input, scopeId: authorizationScopeId ?? input.scopeId
    }, executionPolicy) }

    if (image.protocol === 'task-images') {
      // A generic asynchronous job needs one POST, at least one status GET and
      // potentially one pinned content GET. Do not accept paid work when the
      // saved request boundary cannot finish that minimum lifecycle.
      if (executionPolicy.maxRequestsPerJob < 3) return null
      const capabilities = configuredImageCapabilities(image, TASK_IMAGES_CAPABILITIES, executionPolicy)
      const provider = new KrillImageProvider({
        id: 'image-provider',
        label: image.label,
        capabilities,
        allowArbitraryModels: true,
        protocol: new TaskImagesProtocol({
          baseUrl: image.baseUrl,
          allowedModels: [image.defaultModel]
        }),
        transport: new KrillHttpTransport({
          secrets,
          authorization: {
            reserve: (input) => authorization.reserve({
              scopeId: input.scopeId,
              providerId: input.providerId,
              requests: input.requests,
              images: input.expectedImages,
              costCeilingCny: input.costCeilingCny
            }).then(() => undefined)
          },
          timeoutMs: image.timeoutMs,
          baseUrl: image.baseUrl,
          submissionCostCeilingCny: executionPolicy.maxCostCnyPerJob,
          providerLabel: image.label
        }),
        stagingDirectory: join(this.#userDataDirectory, 'generation-staging'),
        maxPollRequests: Math.max(1, Math.min(40, executionPolicy.maxRequestsPerJob - 2))
      })
      return provider
    }

    if (image.protocol === 'openai-images') {
      const capabilities = configuredImageCapabilities(image, OPENAI_IMAGES_CAPABILITIES, executionPolicy)
      const provider = new OpenAiImagesProvider({
        label: image.label,
        capabilities,
        protocol: new OpenAiImagesProtocol({ baseUrl: image.baseUrl, allowedModels: [image.defaultModel] }),
        http: new ArkHttpClient({
          secrets,
          authorization,
          allowedBaseUrls: [
            resolveImageProtocolEndpoint(image.baseUrl, image.protocol, 'generate'),
            resolveImageProtocolEndpoint(image.baseUrl, image.protocol, 'edit')
          ]
        }),
        stagingDirectory: join(this.#userDataDirectory, 'generation-staging'),
        timeoutMs: image.timeoutMs,
        costCeilingCny: executionPolicy.maxCostCnyPerJob
      })
      return provider
    }

    const capabilities = configuredImageCapabilities(image, ARK_SEEDREAM_CAPABILITIES, executionPolicy)
    const provider = new ArkSeedreamImageProvider({
      label: image.label,
      capabilities,
      protocol: new ArkSeedreamProtocol({ baseUrl: image.baseUrl }),
      http: new ArkHttpClient({
        secrets,
        authorization,
        allowedBaseUrls: [image.baseUrl]
      }),
      stagingDirectory: join(this.#userDataDirectory, 'generation-staging'),
      timeoutMs: image.timeoutMs,
      allowedModels: [image.defaultModel]
    })
    return provider
  }

  async #resolveImageExecution(job: GenerationJob): Promise<ImageProvider> {
    if (job.copiedFromProjectId) throw new Error('Copied execution records cannot activate a Provider.')
    if (job.providerId === 'mock') return this.#providers.get('mock')
    if (!job.executionIdentityId) throw new Error('Legacy request lacks a verified execution identity.')
    const binding = await this.#executionBindings.read(job.executionIdentityId)
    if (binding.projectId !== job.projectId || binding.model !== job.model || job.providerId !== binding.image.id
      || binding.requestHash !== executionRequestHash(job.request)
      || binding.invocationKey !== job.request.parameters.workflowIdempotencyKey
      || binding.operation !== ('kind' in job.request && job.request.kind === 'edit' ? 'edit' : 'generate')
      || job.effectiveTimeoutMs !== binding.image.timeoutMs
      || !await this.#secrets.hasReference('image-provider', binding.credentialReference)) {
      throw new Error('The original image execution identity is unavailable or mismatched.')
    }
    const provider = this.#makeImageProvider(binding.image, binding.policy, {
      get: async (id) => {
        const secret = await this.#secrets.getByReference(id, binding.credentialReference)
        if (secret === null) throw new ProviderError('REQUEST_IDENTITY_UNAVAILABLE', '原凭据版本已撤销，请核对原任务。', 'validating')
        return secret
      },
      startRequest: (id, send) => this.#secrets.startBoundRequest(id, binding.credentialReference, send)
    }, `image-binding:${binding.id}`)
    if (provider === null) throw new Error('The original image protocol is unavailable.')
    return provider
  }

  async #activate(project: OpenProjectResult, recordRecent = true): Promise<void> {
    const projectDirectory = project.workspace.directory
    const projectDatabasePath = join(projectDirectory, 'project.db')
    await project.workspace.assets.detectMissingAssets()
    const repository = new GenerationJobRepository(projectDatabasePath)
    const workflowRepository = new GenerationWorkflowRepository(projectDatabasePath)
    const activityLedger = new ActivityLedgerRepository(projectDatabasePath)
    this.#activityProjectionChain = Promise.resolve()
    const queue = new GenerationQueue({
      projectId: project.workspace.metadata.id,
      repository,
      assetStore: project.workspace.assets,
      providers: this.#providers,
      resolveExecution: (job) => {
        workflowRepository.assertJobBudget(job)
        return this.#resolveImageExecution(job)
      },
      startPaused: true,
      logger: this.#diagnosticLog
    })
    const workflowCoordinator = new GenerationWorkflowCoordinator({
      repository: workflowRepository,
      queue: {
        enqueue: (request) => queue.enqueue(request),
        prepare: (request, identity) => queue.prepare(request, identity),
        prepareRetry: (parentJobId, request, identity) => queue.prepareRetry(parentJobId, request, identity),
        activate: (jobId) => queue.activate(jobId),
        listJobs: () => repository.listJobs(project.workspace.metadata.id),
        cancel: (jobId) => queue.cancel(jobId)
      }
    })
    let agentObserver: AgentRuntime | null = null
    queue.subscribe((job) => {
      this.#activityProjectionChain = this.#activityProjectionChain
        .then(async () => {
          await activityLedger.upsertGeneration(job)
          await agentObserver?.observeGenerationJob(job)
        })
        .catch((error: unknown) => {
          this.#diagnosticLog.write('warn', 'activity.generation-projection-failed', {
            message: error instanceof Error ? error.message : 'Generation activity could not be projected.'
          }, job.id)
        })
    })
    await queue.initialize({ activate: false })
    await this.#activityProjectionChain
    for (const job of await repository.listJobs(project.workspace.metadata.id)) await activityLedger.upsertGeneration(job)
    const conversationRepository = new ConversationRepository(projectDatabasePath)
    const harnessRepository = new AgentHarnessRepository(projectDatabasePath)
    const contextRepository = new AgentContextRepository(projectDatabasePath)
    const outboundContextService = new OutboundContextService(contextRepository)
    const toolExecutor = new AgentToolExecutorShadow({
      repository: new AgentToolCallRepository(projectDatabasePath)
    })
    const sceneService = new SceneService(project.scene, {
      save: (scene, batch, reason) => project.workspace.saveScene(scene, reason, batch),
      afterCommit: (event) => this.#afterSceneCommit(project, event),
      history: project.history
    })
    const fallbackPlanner = new DeterministicMockPlanner()
    const planner = new ConfiguredAgentPlanner({
      secrets: this.#secrets,
      config: this.#providerConfig,
      fallback: fallbackPlanner,
      createLive: (llm, image, maxImages, imageGenerationAvailable) => new ArkAgentPlanner({
        protocol: createConfiguredLlmProtocol(llm),
        http: new ArkHttpClient({
          secrets: this.#secrets,
          authorization: this.#providerUsage,
          allowedBaseUrls: [llm.baseUrl]
        }),
        assets: project.workspace.assets,
        timeoutMs: llm.timeoutMs,
        transport: llm.transport,
        protocolId: llm.protocol,
        model: llm.defaultModel,
        maxOutputTokens: llm.maxOutputTokens,
        llmProviderLabel: llm.label,
        imageProviderId: 'image-provider',
        imageModel: image.defaultModel,
        maxImages,
        imageGenerationAvailable
      })
    })
    const agent = new AgentRuntime({
      projectId: project.workspace.metadata.id,
      repository: conversationRepository,
      planner,
      generationPolicy: new ProductGenerationPolicy(() => this.#executionPolicy),
      logger: this.#diagnosticLog,
      activityLedger,
      toolExecutor,
      harnessRepository,
      contextRepository,
      generationWorkflowRepository: workflowRepository,
      loadGenerationJob: (jobId) => repository.getJob(jobId),
      activateGenerationJob: (jobId) => workflowCoordinator.activate(jobId),
      executePersistentTool: (tool, context) => this.#executePersistentAgentTool(tool, context, toolExecutor, sceneService, outboundContextService),
      refreshPersistentRequest: async (request) => {
        const generationResults = (await repository.listJobs(project.workspace.metadata.id))
          .flatMap((job) => job.results.map((result) => ({
            resultId: result.id,
            jobId: job.id,
            assetId: result.assetId,
            providerId: job.providerId,
            model: job.model,
            width: job.request.outputWidth,
            height: job.request.outputHeight
          })))
          .slice(-40)
        return {
          ...request,
          sceneSummary: summarizeScene(sceneService.state().scene),
          selectedElements: sceneService.state().scene.elements.filter((element) => request.selectedIds.includes(element.id)),
          generationResults
        }
      }
    })
    this.#unsubscribeAgentEvents?.()
    let lastDiagnosticSequence = 0
    this.#unsubscribeAgentEvents = agent.subscribeHarness((event) => {
      const observable = parseAgentObservableEvent(event.type, event.payload)
      if (observable !== null && event.sequence > lastDiagnosticSequence) {
        lastDiagnosticSequence = event.sequence
        const payload = observable.payload as { readonly requestCorrelationId?: string | null }
        this.#diagnosticLog.write(
          event.type.endsWith('.failed') || event.type.endsWith('.exhausted') ? 'warn' : 'info',
          event.type,
          observable.payload,
          payload.requestCorrelationId ?? undefined
        )
      }
      for (const listener of this.#agentListeners) listener(event)
    })
    this.#project = project
    this.#repository = repository
    this.#queue = queue
    this.#workflowCoordinator = workflowCoordinator
    this.#agent = agent
    this.#sceneService = sceneService
    this.#closingProject = false
    this.#referenceCompiler = new ReferenceCompiler({
      assetStore: project.workspace.assets,
      repository: project.workspace.repository,
      stagingDirectory: join(this.#userDataDirectory, 'reference-staging')
    })
    this.#editMaskCompiler = new EditMaskCompiler({
      assetStore: project.workspace.assets,
      stagingDirectory: join(this.#userDataDirectory, 'mask-staging')
    })
    // Install the owning project and reconcile Agent state before any queued
    // work can run. Projection writes share one chain, including startup replay.
    await agent.initialize()
    agentObserver = agent
    this.#activityProjectionChain = this.#activityProjectionChain.then(async () => {
      for (const job of await repository.listJobs(project.workspace.metadata.id)) await agent.observeGenerationJob(job)
    })
    await this.#activityProjectionChain
    queue.start()
    if (recordRecent) {
      await this.#recentProjects.record({
        id: project.workspace.metadata.id,
        name: project.workspace.metadata.name,
        path: project.workspace.directory,
        lastOpenedAt: new Date().toISOString(),
        aspectLabel: `${project.scene.canvas.aspectWidth}:${project.scene.canvas.aspectHeight}`
      }).catch((error: unknown) => {
        this.#diagnosticLog.write('warn', 'project.recent-index-failed', {
          message: error instanceof Error ? error.message : 'Recent project index could not be updated.'
        }, project.workspace.metadata.id)
      })
    }
  }

  async #prepareProjectClose(): Promise<void> {
    this.#closingProject = true
    await Promise.allSettled([...this.#assetImports])
    await this.#sceneService.flush()
    await this.#queue.close()
    await this.#activityProjectionChain
    this.#unsubscribeAgentEvents?.()
    this.#unsubscribeAgentEvents = null
    await this.#agent.close()
    await this.#repository.close()
  }

  async #closeProject(cleanShutdown: boolean): Promise<void> {
    await this.#prepareProjectClose()
    await this.#project.workspace.close(cleanShutdown)
  }

  async #replaceProject(project: OpenProjectResult): Promise<void> {
    const previousDirectory = this.#project.workspace.directory
    try {
      await this.#closeProject(true)
      await this.#activate(project)
    } catch (error) {
      await project.workspace.close(false).catch(() => undefined)
      await this.#restoreProject(previousDirectory)
      throw error
    }
  }

  async #restoreProject(directory: string): Promise<void> {
    // The failed preparation may have closed only part of the runtime. Dispose
    // each remaining connection before reopening the captured source.
    await this.#queue.close().catch(() => undefined)
    await this.#activityProjectionChain.catch(() => undefined)
    this.#unsubscribeAgentEvents?.()
    this.#unsubscribeAgentEvents = null
    await this.#agent.close().catch(() => undefined)
    await this.#repository.close().catch(() => undefined)
    await this.#project.workspace.close(false).catch(() => undefined)
    await this.#activate(await ProjectWorkspace.open(directory))
  }

  getWorkspaceBootstrap(): WorkspaceBootstrap {
    const authority = this.#sceneService.state()
    let workContext: ProjectWorkContext | null = null
    let workContextProblem: string | null = null
    try { workContext = this.#project.workspace.repository.getWorkContext(authority.scene.projectId) } catch {
      workContextProblem = '上次的界面位置或草稿格式无法读取，原记录仍保留。画布与已有结果可以继续查看。'
    }
    return {
      workContext,
      workContextProblem,
      projectId: this.#project.workspace.metadata.id,
      projectName: this.#project.workspace.metadata.name,
      scene: authority.scene,
      sceneSequence: authority.sequence,
      canUndo: authority.canUndo,
      canRedo: authority.canRedo
    }
  }

  saveProjectWorkContext(value: ProjectWorkContext): void {
    const context = projectWorkContextSchema.parse(value)
    if (this.#closed || this.#closingProject || context.projectId !== this.#project.workspace.metadata.id) {
      throw new Error('项目已切换，旧工作上下文没有写入当前作品。')
    }
    this.#project.workspace.repository.saveWorkContext(context)
  }

  async listRecentProjects(): Promise<readonly RecentProjectSummary[]> {
    const summaries: RecentProjectSummary[] = []
    for (const recent of await this.#recentProjects.list()) {
      const packageStatus = await projectPackageStatus(recent.path)
      const deleteMode = this.#recentProjectDeleteMode(recent.path, packageStatus)
      if (packageStatus !== 'ready') {
        summaries.push({
          id: recent.id,
          name: recent.name,
          lastOpenedAt: recent.lastOpenedAt,
          aspectLabel: recent.aspectLabel,
          favorite: recent.favorite,
          status: packageStatus,
          coverSource: recent.coverSource,
          coverDataUrl: null,
          deleteMode
        })
        continue
      }
      try {
        const inspection = await inspectProjectPackage(recent.path)
        const cover = await rebuildProjectCover(
          recent.path,
          inspection.scene,
          inspection.assets,
          inspection.preferredAssetId,
          inspection.preferredAssetId !== null && recent.coverSource !== 'generated'
        )
        const aspectLabel = `${inspection.scene.canvas.aspectWidth}:${inspection.scene.canvas.aspectHeight}`
        const coverSource = cover.source === 'scene' && recent.coverSource === 'generated' ? 'generated' : cover.source
        if (aspectLabel !== recent.aspectLabel || coverSource !== recent.coverSource || inspection.name !== recent.name) {
          await this.#recentProjects.update(recent.id, { aspectLabel, coverSource, name: inspection.name })
        }
        summaries.push({
          id: recent.id,
          name: inspection.name,
          lastOpenedAt: recent.lastOpenedAt,
          aspectLabel,
          favorite: recent.favorite,
          status: inspection.hasMissingAssets ? 'asset-missing' : inspection.scene.elements.length === 0 ? 'empty' : 'ready',
          coverSource,
          coverDataUrl: cover.dataUrl,
          deleteMode
        })
      } catch {
        summaries.push({
          id: recent.id,
          name: recent.name,
          lastOpenedAt: recent.lastOpenedAt,
          aspectLabel: recent.aspectLabel,
          favorite: recent.favorite,
          status: 'damaged',
          coverSource: recent.coverSource,
          coverDataUrl: null,
          deleteMode
        })
      }
    }
    return summaries
  }

  #recentProjectDeleteMode(projectPath: string, packageStatus: Awaited<ReturnType<typeof projectPackageStatus>>): 'trash' | 'remove' {
    const libraryDirectory = resolve(this.#projectLibraryDirectory)
    const targetDirectory = resolve(projectPath)
    const targetRelative = relative(libraryDirectory, targetDirectory)
    const belongsToLibrary = targetRelative !== '' && !targetRelative.startsWith('..') && !isAbsolute(targetRelative)
    return packageStatus !== 'missing' && belongsToLibrary && extname(targetDirectory).toLowerCase() === '.aicanvas'
      ? 'trash'
      : 'remove'
  }

  getProjectLibraryDirectory(): string {
    return this.#projectLibraryDirectory
  }

  async exportDiagnosticPackage(
    destinationPath: string,
    runtime: DiagnosticExportSourceSnapshot['runtime'],
    appearance: AppearanceSettingsSnapshot
  ): Promise<DiagnosticExportResult> {
    try {
      await this.#diagnosticLog.flush()
      const settings = await this.#providerSettings.snapshot()
      const jobs = await this.#repository.listJobs(this.#project.workspace.metadata.id)
      const scene = this.#sceneService.state().scene
      const source: DiagnosticExportSourceSnapshot = {
        runtime,
        appearance,
        providers: settings.providers.map((provider) => ({
          id: provider.id,
          kind: provider.kind,
          protocol: provider.protocol,
          configured: provider.configured,
          capabilities: provider.capabilities
        })),
        executionPolicy: settings.executionPolicy,
        usage: await this.#providerUsage.listSnapshots(),
        generationCosts: summarizeGenerationCosts(jobs),
        project: {
          projectId: this.#project.workspace.metadata.id,
          schemaVersion: this.#project.workspace.metadata.schemaVersion,
          sceneRevision: scene.revision,
          elementCount: scene.elements.length,
          jobCount: jobs.length,
          resultCount: jobs.reduce((count, job) => count + job.results.length, 0),
          recovered: this.#project.recovered,
          recoveredFromOlderSnapshot: this.#project.recoveredFromOlderSnapshot,
          migration: {
            fromVersion: this.#project.workspace.repository.migrationResult.fromVersion,
            toVersion: this.#project.workspace.repository.migrationResult.toVersion
          }
        }
      }
      const service = new DiagnosticExportService({
        logFilePath: join(this.#userDataDirectory, 'logs', 'diagnostic.jsonl')
      })
      await service.exportTo(destinationPath, source)
      return diagnosticExportResultSchema.parse({
        status: 'saved',
        fileName: basename(destinationPath),
        correlationId: null,
        message: '脱敏诊断包已保存；软件没有上传或打开该文件。'
      })
    } catch (error) {
      const correlationId = this.#diagnosticLog.write('error', 'diagnostic.export-failed', {
        message: error instanceof Error ? error.message : 'Diagnostic export failed.'
      })
      return diagnosticExportResultSchema.parse({
        status: 'failed',
        fileName: null,
        correlationId,
        message: '诊断包没有写入。请检查保存位置是否可写，然后手动重试。'
      })
    }
  }

  async getProjectLibrarySettings(): Promise<ProjectLibrarySettings> {
    return this.#librarySettings.get()
  }

  async changeProjectLibraryLocation(directory: string, mode: ProjectLibraryChangeMode): Promise<ProjectLibraryLocationResult> {
    return this.#runProjectLifecycle(() => this.#changeProjectLibraryLocation(directory, mode))
  }

  async #changeProjectLibraryLocation(directory: string, mode: ProjectLibraryChangeMode): Promise<ProjectLibraryLocationResult> {
    if (mode === 'future') {
      const settings = await this.#librarySettings.set(directory)
      this.#projectLibraryDirectory = settings.rootDirectory
      await mkdir(settings.rootDirectory, { recursive: true })
      return { cancelled: false, settings, migration: null }
    }
    const sourceDirectory = this.#projectLibraryDirectory
    const activeDirectory = this.#project.workspace.directory
    await this.#closeProject(true)
    let migration
    try {
      migration = await migrateProjectLibrary(sourceDirectory, directory)
    } catch (error) {
      await this.#activate(await ProjectWorkspace.open(activeDirectory), false)
      throw error
    }
    let settings = await this.#librarySettings.get()
    if (migration.switched) {
      settings = await this.#librarySettings.set(directory)
      this.#projectLibraryDirectory = settings.rootDirectory
      const relocations = new Map(
        migration.items
          .filter((item) => item.status === 'copied')
          .map((item) => [join(sourceDirectory, item.projectName), join(settings.rootDirectory, item.projectName)] as const)
      )
      await this.#recentProjects.relocatePaths(relocations)
    }
    const activeRelative = relative(sourceDirectory, activeDirectory)
    const activeBelongsToLibrary = activeRelative !== '' && !activeRelative.startsWith('..') && !isAbsolute(activeRelative)
    const activeTarget = migration.switched && activeBelongsToLibrary
      ? join(settings.rootDirectory, activeRelative)
      : activeDirectory
    try {
      await this.#activate(await ProjectWorkspace.open(activeTarget), false)
    } catch (error) {
      await this.#activate(await ProjectWorkspace.open(activeDirectory), false).catch(() => undefined)
      throw error
    }
    return { cancelled: false, settings, migration }
  }

  async setProjectFavorite(projectId: string, favorite: boolean): Promise<readonly RecentProjectSummary[]> {
    await this.#recentProjects.setFavorite(projectId, favorite)
    return this.listRecentProjects()
  }

  async deleteRecentProject(projectId: string, trashItem: (targetPath: string) => Promise<void>): Promise<ProjectDeleteResult> {
    return this.#runProjectLifecycle(() => this.#deleteRecentProject(projectId, trashItem))
  }

  async #deleteRecentProject(projectId: string, trashItem: (targetPath: string) => Promise<void>): Promise<ProjectDeleteResult> {
    const recent = (await this.#recentProjects.list()).find((project) => project.id === projectId)
    if (recent === undefined) throw new Error('这个项目已经不在最近项目列表中。')
    const packageStatus = await projectPackageStatus(recent.path)
    const deleteMode = this.#recentProjectDeleteMode(recent.path, packageStatus)
    if (deleteMode === 'remove') {
      await this.#recentProjects.remove(projectId)
      return {
        projectId,
        disposition: 'removed',
        projects: await this.listRecentProjects(),
        replacementBootstrap: null
      }
    }

    const targetDirectory = resolve(recent.path)
    const targetStat = await lstat(targetDirectory)
    if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) {
      throw new Error('为保护项目文件，只能删除项目库中的真实 .aicanvas 项目包。')
    }
    const activeDirectory = resolve(this.#project.workspace.directory)
    const deletingActiveProject = recent.id === this.#project.workspace.metadata.id || targetDirectory === activeDirectory
    let replacementBootstrap: WorkspaceBootstrap | null = null

    if (deletingActiveProject) {
      const fallback = await openDefaultProject(join(this.#userDataDirectory, 'session', 'Empty.aicanvas'))
      try {
        await this.#closeProject(true)
        await this.#activate(fallback, false)
        replacementBootstrap = this.getWorkspaceBootstrap()
      } catch (error) {
        await fallback.workspace.close(false).catch(() => undefined)
        await this.#activate(await ProjectWorkspace.open(targetDirectory), false).catch(() => undefined)
        throw error
      }
    }

    await this.#recentProjects.remove(projectId)
    try {
      await trashItem(targetDirectory)
    } catch (error) {
      await this.#recentProjects.record(recent).catch(() => undefined)
      if (deletingActiveProject) {
        await this.#closeProject(true).catch(() => undefined)
        await this.#activate(await ProjectWorkspace.open(targetDirectory), false).catch(() => undefined)
      }
      throw new Error(`项目没有移到回收站：${error instanceof Error ? error.message : '系统拒绝了此操作。'}`, { cause: error })
    }

    return {
      projectId,
      disposition: 'trashed',
      projects: await this.listRecentProjects(),
      replacementBootstrap
    }
  }

  async relocateRecentProject(projectId: string, directory: string): Promise<WorkspaceBootstrap> {
    return this.#runProjectLifecycle(async () => {
    const recent = (await this.#recentProjects.list()).find((project) => project.id === projectId)
    if (recent === undefined) throw new Error('The selected recent project is no longer indexed.')
    const inspection = await inspectProjectPackage(directory)
    if (inspection.id !== projectId) throw new Error('所选项目与缺失卡片不是同一个项目。')
    await this.#recentProjects.update(projectId, {
      path: directory,
      name: inspection.name,
      aspectLabel: `${inspection.scene.canvas.aspectWidth}:${inspection.scene.canvas.aspectHeight}`
    })
    const project = await ProjectWorkspace.open(directory)
    await this.#replaceProject(project)
    return this.getWorkspaceBootstrap()
    })
  }

  async createProjectInLibrary(suggestedName: string): Promise<WorkspaceBootstrap> {
    const target = await allocateProjectDirectory(this.#projectLibraryDirectory, suggestedName)
    return this.createProject(target.directory, target.name)
  }

  async createProject(directory: string, name: string): Promise<WorkspaceBootstrap> {
    return this.#runProjectLifecycle(async () => {
    const project = await ProjectWorkspace.create(directory, name)
    await this.#replaceProject(project)
    return this.getWorkspaceBootstrap()
    })
  }

  async openProject(directory: string): Promise<WorkspaceBootstrap> {
    return this.#runProjectLifecycle(async () => {
    const project = await ProjectWorkspace.open(directory)
    await this.#replaceProject(project)
    return this.getWorkspaceBootstrap()
    })
  }

  async openRecentProject(projectId: string): Promise<WorkspaceBootstrap> {
    const recent = (await this.#recentProjects.list()).find((project) => project.id === projectId)
    if (recent === undefined) throw new Error('The selected recent project is no longer available.')
    return this.openProject(recent.path)
  }

  async saveProjectAs(directory: string): Promise<WorkspaceBootstrap> {
    return this.#runProjectLifecycle(async () => {
    const originalDirectory = this.#project.workspace.directory
    try {
      await this.#prepareProjectClose()
      const project = await this.#project.workspace.saveAs(directory)
      await this.#activate(project)
      return this.getWorkspaceBootstrap()
    } catch (error) {
      await this.#restoreProject(originalDirectory)
      throw error
    }
    })
  }

  async importAsset(input: AssetImportInput): Promise<ImportedAsset> {
    this.#assertRequestedProject(input.projectId)
    const operation = this.#importAssetOwned(input, this.#project)
    this.#assetImports.add(operation)
    try { return await operation } finally { this.#assetImports.delete(operation) }
  }

  async #importAssetOwned(input: AssetImportInput, owner: OpenProjectResult): Promise<ImportedAsset> {
    const extension = input.mimeType === 'image/jpeg' ? 'jpg' : input.mimeType.slice('image/'.length)
    const stagingDirectory = join(this.#userDataDirectory, 'import-staging')
    await mkdir(stagingDirectory, { recursive: true })
    const stagingPath = join(stagingDirectory, `${randomUUID()}.${extension}`)
    await writeFile(stagingPath, input.bytes, { flag: 'wx' })
    try {
      this.#assertGenerationProject(owner)
      const asset = await owner.workspace.assets.importImage({ sourcePath: stagingPath, sourceType: 'imported' })
      return { id: asset.id, width: asset.width, height: asset.height, format: asset.format, hasAlpha: asset.hasAlpha }
    } finally {
      await rm(stagingPath, { force: true })
    }
  }

  getSceneAuthorityState(): ReturnType<SceneService['state']> {
    return this.#sceneService.state()
  }

  executeSceneCommands(input: SceneExecuteInput): Promise<SceneMutationResult> {
    this.#assertRequestedProject(input.projectId)
    return this.#sceneService.execute(input)
  }

  undoScene(input: SceneHistoryInput): Promise<SceneMutationResult> {
    this.#assertRequestedProject(input.projectId)
    return this.#sceneService.undo(input)
  }

  redoScene(input: SceneHistoryInput): Promise<SceneMutationResult> {
    this.#assertRequestedProject(input.projectId)
    return this.#sceneService.redo(input)
  }

  async selectDesignDirection(inputValue: DesignDirectionSelectionInput): Promise<DesignDirectionSelectionResult> {
    const input = designDirectionSelectionInputSchema.parse(inputValue)
    const current = this.#sceneService.state().scene
    const compiled = compileDesignDirectionSelection(current, input, randomUUID)
    if (compiled.status === 'unchanged') {
      return designDirectionSelectionResultSchema.parse({
        status: 'unchanged',
        directionId: compiled.directionId,
        sceneRevision: current.revision,
        batchId: null,
        affectedElementIds: [],
        message: compiled.message
      })
    }
    if (compiled.status === 'conflict') {
      return designDirectionSelectionResultSchema.parse({
        ...compiled,
        sceneRevision: current.revision
      })
    }
    if (compiled.status === 'rejected') {
      return designDirectionSelectionResultSchema.parse({
        ...compiled,
        sceneRevision: current.revision
      })
    }
    const batchId = randomUUID()
    const mutation = await this.#sceneService.execute({
      expectedSceneRevision: input.expectedSceneRevision,
      batch: {
        id: batchId,
        origin: 'agent',
        summary: compiled.summary,
        commands: compiled.commands
      }
    })
    if (!mutation.ok) {
      if (mutation.error.code === 'SCENE_REVISION_STALE') {
        return designDirectionSelectionResultSchema.parse({
          status: 'conflict',
          code: 'SCENE_REVISION_CHANGED',
          directionId: compiled.directionId,
          sceneRevision: mutation.state.scene.revision,
          message: '画布在方向切换前又发生了变化，系统没有覆盖新内容。',
          canReplaceAgentStructure: true,
          canRetryAfterUndo: true,
          canTryTemporarily: true
        })
      }
      return designDirectionSelectionResultSchema.parse({
        status: 'rejected',
        code: mutation.error.code === 'SCENE_PERSIST_FAILED' ? 'SCENE_PERSIST_FAILED' : 'SCENE_COMMAND_REJECTED',
        directionId: compiled.directionId,
        sceneRevision: mutation.state.scene.revision,
        message: mutation.error.code === 'SCENE_PERSIST_FAILED'
          ? '方向切换没有保存，画布已恢复到操作前。'
          : '方向切换未通过画布校验，没有产生部分修改。'
      })
    }
    const directionTitle = compiled.creativeContext.directions?.find((direction) => direction.id === compiled.directionId)?.title ?? '所选方向'
    await this.#agent.recordDesignDirectionSelection({
      sourceRunId: input.sourceRunId,
      directionTitle,
      batchId,
      affectedElementIds: compiled.affectedElementIds
    }).catch((error: unknown) => {
      this.#diagnosticLog.write('warn', 'agent.direction-projection-failed', {
        message: error instanceof Error ? error.message : 'Direction selection activity could not be projected.'
      }, batchId)
    })
    return designDirectionSelectionResultSchema.parse({
      status: 'applied',
      directionId: compiled.directionId,
      sceneRevision: mutation.receipt.state.scene.revision,
      batchId,
      affectedElementIds: compiled.affectedElementIds,
      message: `已切换到“${directionTitle}”，可使用撤销恢复。`
    })
  }

  subscribeScene(listener: (event: SceneChangedEvent) => void): () => void {
    this.#sceneListeners.add(listener)
    return () => this.#sceneListeners.delete(listener)
  }

  async #afterSceneCommit(project: OpenProjectResult, event: SceneChangedEvent): Promise<void> {
    const scene = event.state.scene
    if (this.#project !== project) return
    await rm(join(this.#project.workspace.directory, 'preview', 'cover.webp'), { force: true }).catch(() => undefined)
    await this.#recentProjects.update(this.#project.workspace.metadata.id, {
      lastOpenedAt: new Date().toISOString(),
      aspectLabel: `${scene.canvas.aspectWidth}:${scene.canvas.aspectHeight}`,
      coverSource: 'none'
    }).catch(() => undefined)
    for (const listener of this.#sceneListeners) listener(event)
  }

  listProviders(): readonly GenerationProviderInfo[] {
    return this.#providers.list().map((provider) => ({
      id: provider.id,
      label: provider.label,
      capabilities: provider.capabilities,
      models: provider.id === 'mock'
        ? [
            { id: 'mock-balanced', label: '标准', behavior: '本地确定性预览，不联网、不计费' },
            ...(process.env.AI_CANVAS_E2E === undefined ? [] : [
              { id: 'mock-slow', label: '慢速状态验证', behavior: '仅用于离线测试长任务状态' },
              { id: 'mock-failure', label: '失败状态验证', behavior: '仅用于离线测试失败恢复' },
              { id: 'mock-timeout', label: '超时状态验证', behavior: '仅用于离线测试超时恢复' }
            ])
          ]
        : provider.id === 'image-provider' && this.#configuredImage !== null
          ? [{
              id: this.#configuredImage.defaultModel,
              label: this.#configuredImage.defaultModel,
              behavior: `当前图片模块 · ${this.#configuredImage.protocol} · 实际能力与价格以供应商为准`
            }]
          : []
    }))
  }

  listProfiles(): GenerationProfileSnapshot {
    return this.#profiles.snapshot()
  }

  async previewGenerationReference(inputValue: GenerationReferencePreviewInput): Promise<GenerationReferencePreview> {
    const input = generationReferencePreviewInputSchema.parse(inputValue)
    this.#assertRequestedProject(input.projectId)
    const owner = this.#project
    return this.#providerSettings.withStableConfiguration(async (config) => {
      const preview = await this.#resolveReference(input, config, owner, true)
      this.#assertGenerationProject(owner)
      return preview
    })
  }

  async #resolveReference(input: GenerationReferencePreviewInput, config: ProviderConfigFile, owner: OpenProjectResult, thumbnails = false) {
    this.#assertGenerationProject(owner)
    const { profiles, providers } = await this.#profileEnvironment(config)
    const profile = profiles.snapshot().profiles.find((entry) => entry.profile.id === input.profileId && entry.status === 'available')?.profile
    if (profile === undefined) throw new ProviderError('PROFILE_NOT_FOUND', '请先选择可用的生成方式。', 'validating')
    const provider = providers.get(profile.providerId)
    const preview = await resolveGenerationReference(input, {
      workspace: owner.workspace, scene: this.#sceneService.state().scene,
      jobs: await this.#repository.listJobs(owner.workspace.metadata.id), capabilities: provider.capabilities, thumbnails,
      configurationIdentity: { profile, capabilities: provider.capabilities,
        image: profile.providerId === 'mock' ? null : config.providers.find((entry) => entry.kind === 'image') }
    })
    this.#assertGenerationProject(owner)
    return preview
  }

  getProviderSettings(): Promise<ProviderSettingsSnapshot> {
    return this.#providerSettings.snapshot()
  }

  validateProviderConnection(input: ProviderConnectionTestInput): Promise<ProviderConnectionTestResult> {
    return this.#providerConnection.validate(input)
  }

  setProviderSecret(input: ProviderSecretInput): Promise<ProviderSettingsSnapshot> {
    return this.#providerSettings.setSecret(input)
  }

  async setProviderConfig(input: ProviderPublicConfig): Promise<ProviderSettingsSnapshot> {
    const snapshot = await this.#providerSettings.setConfig(input)
    await this.#refreshConfiguredImageProvider()
    return snapshot
  }

  async setProviderExecutionPolicy(input: ProviderExecutionPolicy): Promise<ProviderSettingsSnapshot> {
    const snapshot = await this.#providerSettings.setExecutionPolicy(input)
    await this.#refreshConfiguredImageProvider()
    return snapshot
  }

  deleteProviderSecret(providerId: ConfigurableProviderId): Promise<ProviderSettingsSnapshot> {
    return this.#providerSettings.deleteSecret(providerId)
  }

  listJobs(): Promise<readonly GenerationJob[]> {
    return this.#repository.listJobs(this.#project.workspace.metadata.id)
  }

  #profileId(
    providerId: string,
    operation: GenerationProfileRequest['operation'],
    preferredTier: 'draft' | 'final' = 'draft',
    profiles = this.#profiles
  ): string {
    if (providerId === 'mock') return 'local-sketch'
    const candidates = profiles.snapshot().profiles
      .filter((entry) => entry.status === 'available'
        && entry.profile.providerId === providerId
        && entry.profile.supportedOperations.includes(operation))
      .map((entry) => entry.profile)
    const selected = candidates.find((profile) => profile.tier === preferredTier) ?? candidates[0]
    if (selected === undefined) {
      throw new ProviderError('PROFILE_NOT_FOUND', '当前图片 Provider 没有支持本次操作的可用生成档。', 'validating')
    }
    return selected.id
  }

  async enqueue(request: GenerationRequest): Promise<GenerationJob> {
    const owner = this.#project
    return this.#providerSettings.withStableConfiguration(async (config) => {
    this.#assertGenerationProject(owner)
    const operation = request.references.length === 0 ? 'generate' : 'reference'
    const identity = workflowIdentity(request, { operation: request.parentResultId === null ? 'text' : 'similar', sourceSceneRevision: null })
    const { profiles } = await this.#profileEnvironment(config, identity)
    const profileId = this.#profileId(request.providerId, operation, 'draft', profiles)
    return this.#enqueueProfileConfigured({
      profileId,
      confirmed: request.providerId !== 'mock',
      operation,
      draft: {
        prompt: request.prompt,
        negativePrompt: request.negativePrompt,
        aspect: { width: request.aspectWidth, height: request.aspectHeight },
        quantity: request.count,
        profileId,
        referenceResultIds: request.parentResultId === null ? [] : [request.parentResultId],
        sourceSceneRevision: null,
        referenceMode: request.referenceMode,
        variationInstruction: request.variationInstruction,
        preserveConstraints: request.preserveConstraints,
        expandedSections: []
      },
      outputWidth: request.outputWidth,
      outputHeight: request.outputHeight,
      references: request.references,
      parameters: { ...request.parameters, workflowIdempotencyKey: identity },
      sourceMessageId: request.sourceMessageId,
      parentResultId: request.parentResultId,
      modelOverride: request.model
    }, {}, config, owner)
    })
  }

  async enqueueProfile(
    request: GenerationProfileRequest,
    options: { readonly deferActivation?: boolean; readonly agentScope?: AgentGenerationAuthority } = {}
  ): Promise<GenerationJob> {
    this.#assertRequestedProject(request.projectId)
    const owner = this.#project
    return this.#providerSettings.withStableConfiguration((config) => this.#enqueueProfileConfigured(request, options, config, owner))
  }

  #assertGenerationProject(owner: OpenProjectResult): void {
    if (this.#closed || this.#closingProject || this.#project !== owner) {
      throw new ProviderError('PROJECT_CONTEXT_CHANGED', '项目已切换，原请求已停止。请在当前作品中重新确认请求。', 'validating')
    }
  }

  async #profileIdForInvocation(providerId: string, operation: GenerationProfileRequest['operation'], invocationId: string,
    preferredTier: 'draft' | 'final' = 'draft'): Promise<string> {
    const owner = this.#project
    return this.#providerSettings.withStableConfiguration(async (config) => {
      this.#assertGenerationProject(owner)
      const { profiles } = await this.#profileEnvironment(config, `tool:${invocationId}`)
      this.#assertGenerationProject(owner)
      return this.#profileId(providerId, operation, preferredTier, profiles)
    })
  }

  async #profileEnvironment(config: ProviderConfigFile, identity?: string) {
    const existing = identity === undefined ? null : await this.#workflowCoordinator.getIntentByKey(this.#project.workspace.metadata.id, identity)
    const binding = existing?.spec.executionIdentityId ? await this.#executionBindings.read(existing.spec.executionIdentityId) : null
    const image = binding?.image ?? config.providers.find((item): item is ImageProviderConfig => item.kind === 'image')
    const imageProvider = image === undefined ? null : this.#makeImageProvider(image, binding?.policy ?? config.executionPolicy)
    const providers = new ProviderRegistry([this.#providers.get('mock'), ...(imageProvider === null ? [] : [imageProvider])])
    const profiles = new GenerationProfileRegistry(providers, {
      mock: ['mock-balanced', 'mock-slow', 'mock-failure', 'mock-timeout'], 'image-provider': image === undefined ? [] : [image.defaultModel]
    })
    return { profiles, providers }
  }

  async #enqueueProfileConfigured(request: GenerationProfileRequest, options: { readonly deferActivation?: boolean; readonly agentScope?: AgentGenerationAuthority }, config: ProviderConfigFile,
    owner: OpenProjectResult): Promise<GenerationJob> {
    this.#assertGenerationProject(owner)
    const operation: GenerationWorkflowOperation = request.operation === 'edit'
      ? 'edit'
      : request.referenceSource?.kind === 'canvas'
        ? 'canvas'
        : request.parentResultId === null
          ? 'text'
          : 'similar'
    const identity = workflowIdentity({ ...request, prompt: request.draft.prompt, negativePrompt: request.draft.negativePrompt,
      aspectWidth: request.draft.aspect.width, aspectHeight: request.draft.aspect.height, count: request.draft.quantity },
      { operation, sourceSceneRevision: request.draft.sourceSceneRevision })
    const inputHash = executionInputHash(request)
    const existing = await this.#existingCompiledInvocation(identity, inputHash, options.deferActivation === true, options.agentScope)
    if (existing !== null) return existing
    const { profiles, providers } = await this.#profileEnvironment(config, identity)
    const source: GenerationReferenceSource = request.referenceSource ?? (request.parentResultId !== null
      ? { kind: 'result', resultId: request.parentResultId }
      : request.references.length > 0 ? { kind: 'images', assetIds: request.references.map((entry) => entry.assetId) } : { kind: 'text' })
    if (request.referenceSource !== undefined && (request.references.length > 0
      || request.parentResultId !== null && (source.kind !== 'result' || source.resultId !== request.parentResultId))) {
      throw new ProviderError('REFERENCE_SOURCE_CONFLICT', '参考对象与附带的图片或结果不一致，请重新选择。', 'validating')
    }
    const previewInput = { projectId: owner.workspace.metadata.id, source, profileId: request.profileId,
      modelOverride: request.modelOverride, referenceMode: request.draft.referenceMode }
    const preview = await this.#resolveReference(previewInput, config, owner)
    if (request.referenceSource !== undefined && request.expectedReferenceSignature !== preview.signature) {
      throw new ProviderError('REFERENCE_REVIEW_REQUIRED', '参考对象或图片配置已改变，请刷新预览后重新提交。', 'validating')
    }
    if (source.kind !== 'text' && !preview.supportedModes.includes(request.draft.referenceMode)) {
      throw new ProviderError('REFERENCE_MODE_UNSUPPORTED', '当前对象或图片模型不支持这个参考方式。普通图片只能提供观感参考，请重新选择。', 'validating')
    }
    const parameters = Object.fromEntries(Object.entries(request.parameters).filter(([key]) =>
      !['promptIr', 'promptPackage', 'referenceAssetId', 'semanticSheetAssetId', 'referenceCompilationId', 'referenceSourceSnapshot', 'sentPrompt'].includes(key)))
    const prompt = [request.draft.prompt, request.draft.variationInstruction.trim() ? `本次只改变：${request.draft.variationInstruction.trim()}` : '',
      request.draft.preserveConstraints.trim() ? `保持约束：${request.draft.preserveConstraints.trim()}` : ''].filter(Boolean).join('\n')
    let prepared = { ...request, draft: { ...request.draft, prompt, sourceSceneRevision: source.kind === 'canvas' ? source.sceneRevision : null },
      parameters: { ...parameters, invocationInputHash: inputHash, referenceSourceSnapshot: { version: 1, source, signature: preview.signature, summary: preview.summary, assetIds: preview.assetIds } } }
    if (source.kind === 'canvas') {
      const preflight = profiles.compile({ ...prepared, operation: 'generate', references: [] })
      const provider = providers.get(preflight.providerId)
      const compilation = await this.#referenceCompiler.compile(this.#sceneService.state().scene, prompt, provider.id, provider.capabilities, preflight.model, request.draft.referenceMode,
        { aspectWidth: request.draft.aspect.width, aspectHeight: request.draft.aspect.height, outputWidth: request.outputWidth, outputHeight: request.outputHeight })
      const references = compilation.providerPrompt.referenceStrategy === 'composite'
        ? [{ assetId: compilation.asset.id, intent: 'composition' as const, strength: .82 },
          ...(request.draft.referenceMode === 'hybrid' && provider.capabilities.multipleReferences ? [{ assetId: compilation.semanticSheetAsset.id, intent: 'composition' as const, strength: .72 }] : [])] : []
      prepared = { ...prepared, operation: references.length ? 'reference' : 'generate', references,
        draft: { ...prepared.draft, prompt: compilation.providerPrompt.prompt, negativePrompt: [compilation.providerPrompt.negativePrompt, request.draft.negativePrompt].filter(Boolean).join('\n') },
        parameters: { ...prepared.parameters, ...{ mode: 'canvas', originalRequirement: request.draft.prompt,
          promptIr: compilation.promptIr, promptPackage: compilation.promptPackage, referenceCompilationId: compilation.id,
          referenceAssetId: compilation.asset.id, semanticSheetAssetId: compilation.semanticSheetAsset.id } } }
    } else {
      const references = preview.assetIds.map((assetId) => ({ assetId, intent: 'composition' as const, strength: .82 }))
      // Legacy explicit references retain their intent (including edit-source and
      // mask); their ownership and bytes were still checked by Main above.
      prepared = { ...prepared, references: request.referenceSource === undefined && request.references.length > 0 ? request.references : references,
        operation: references.length ? 'reference' : 'generate', parentResultId: source.kind === 'result' ? source.resultId : null }
    }
    const rechecked = await this.#resolveReference(previewInput, config, owner)
    if (rechecked.signature !== preview.signature) throw new ProviderError('REFERENCE_REVIEW_REQUIRED', '参考在编译期间发生变化，请刷新预览。', 'validating')
    const compiled = profiles.compile(prepared)
    return this.#enqueueWorkflowConfigured(compiled, {
      ...(options.agentScope === undefined ? {} : { agentScope: options.agentScope }),
      operation,
      sourceSceneRevision: prepared.draft.sourceSceneRevision,
      promptPackage: compiled.parameters.promptPackage ?? null,
      deferActivation: options.deferActivation === true,
      idempotencyKey: identity
    }, config, owner)
  }

  async #existingCompiledInvocation(identity: string, inputHash: string, deferActivation: boolean, agentScope?: AgentGenerationAuthority): Promise<GenerationJob | null> {
    const existing = await this.#workflowCoordinator.getIntentByKey(this.#project.workspace.metadata.id, identity)
    if (existing === null) return null
    if (existing.turnId !== (agentScope?.turnId ?? null) || existing.threadId !== (agentScope?.threadId ?? null)
      || existing.toolCallItemId !== (agentScope?.toolCallItemId ?? null)) {
      throw new ProviderError('IDEMPOTENCY_CONFLICT', '原请求属于另一份执行授权，不能从当前入口激活。', 'validating')
    }
    if (existing.compiledRequest.request.parameters.invocationInputHash !== inputHash) {
      throw new ProviderError('IDEMPOTENCY_CONFLICT', '原生成请求与当前输入快照不一致，请核对后创建新请求。', 'validating')
    }
    if (existing.jobId === null) throw new ProviderError('NO_REPOST', '原请求的创建状态需要核对，不能自动重复发送。', 'validating')
    const job = await this.#repository.getJob(existing.jobId)
    if (job.status === 'queued' && !deferActivation) await this.#workflowCoordinator.activate(job.id)
    return job
  }

  async generateFromCanvas(
    inputValue: CanvasGenerationInput,
    workflowInvocationId: string | null = null,
    beforeDispatch?: (request: ImageTaskRequest) => Promise<void>,
    deferActivation = false,
    agentScope?: AgentGenerationAuthority
  ): Promise<CanvasGenerationResult> {
    let input = canvasGenerationInputSchema.parse(inputValue)
    this.#assertRequestedProject(input.scene.projectId)
    const owner = this.#project
    const referenceCompiler = this.#referenceCompiler
    return this.#providerSettings.withStableConfiguration(async (config) => {
    this.#assertGenerationProject(owner)
    const inputHash = executionInputHash(input)
    const identity = workflowInvocationId !== null ? `tool:${workflowInvocationId}`
      : input.sourceMessageId !== null ? `canvas-message:${input.sourceMessageId}:${inputHash}` : `manual:${randomUUID()}`
    const existing = await this.#existingCompiledInvocation(identity, inputHash, deferActivation, agentScope)
    if (existing !== null) {
      const saved = existing.request.parameters
      return canvasGenerationResultSchema.parse({ jobId: existing.id, jobStatus: existing.status,
        referenceAssetId: saved.referenceAssetId, semanticSheetAssetId: saved.semanticSheetAssetId,
        promptIr: saved.promptIr, promptPackage: saved.promptPackage, sentPrompt: existing.request.prompt,
        sentNegativePrompt: existing.request.negativePrompt, warnings: saved.referenceWarnings ?? [] })
    }
    const authoritativeScene = this.#sceneService.state().scene
    if (input.scene.id !== authoritativeScene.id || input.scene.revision !== authoritativeScene.revision) {
      throw new ProviderError('REFERENCE_REVIEW_REQUIRED', '画布已修改，请刷新参考预览后重新提交。', 'validating')
    }
    input = { ...input, scene: authoritativeScene }
    const previewInput = { projectId: authoritativeScene.projectId, source: { kind: 'canvas' as const, sceneRevision: authoritativeScene.revision },
      profileId: input.profileId, modelOverride: input.providerId === 'mock' ? input.model : null, referenceMode: input.referenceMode }
    const referencePreview = await this.#resolveReference(previewInput, config, owner)
    const { profiles, providers } = await this.#profileEnvironment(config)
    const draft = {
      prompt: input.originalRequirement,
      negativePrompt: '',
      aspect: { width: input.scene.canvas.aspectWidth, height: input.scene.canvas.aspectHeight },
      quantity: input.count,
      profileId: input.profileId,
      referenceResultIds: [] as string[],
      sourceSceneRevision: input.scene.revision,
      referenceMode: input.referenceMode,
      variationInstruction: '',
      preserveConstraints: '',
      expandedSections: [] as ('parameters' | 'references' | 'advanced')[]
    }
    const preflight = profiles.compile({
      profileId: input.profileId,
      confirmed: input.confirmed,
      // Resolve the model before rendering. The selected mode must also be
      // supported; no silent hybrid-to-structure fallback is permitted.
      operation: 'generate',
      draft,
      outputWidth: input.scene.canvas.outputWidth,
      outputHeight: input.scene.canvas.outputHeight,
      references: [],
      parameters: {},
      sourceMessageId: input.sourceMessageId,
      parentResultId: null,
      modelOverride: input.providerId === 'mock' ? input.model : null
    })
    if (preflight.providerId !== input.providerId) throw new Error('画布生成档位与请求供应商不一致。')
    const provider = providers.get(preflight.providerId)
    if (!referencePreview.supportedModes.includes(input.referenceMode)) {
      throw new ProviderError('IMAGE_REFERENCE_UNSUPPORTED', `${provider.label} 不支持画面参考。请选择“结构参考”或可接收图片的供应商。`, 'validating')
    }
    const compilation = await referenceCompiler.compile(
      input.scene,
      input.originalRequirement,
      provider.id,
      provider.capabilities,
      preflight.model,
      input.referenceMode
    )
    this.#assertGenerationProject(owner)
    const references = compilation.providerPrompt.referenceStrategy === 'composite'
        ? [
            { assetId: compilation.asset.id, intent: 'composition' as const, strength: 0.82 },
            ...(input.referenceMode === 'hybrid' && provider.capabilities.multipleReferences
              ? [{ assetId: compilation.semanticSheetAsset.id, intent: 'composition' as const, strength: 0.72 }]
              : [])
          ]
        : []
    const request = profiles.compile({
      profileId: input.profileId,
      confirmed: input.confirmed,
      operation: references.length > 0 ? 'reference' : 'generate',
      draft: { ...draft, prompt: compilation.providerPrompt.prompt, negativePrompt: compilation.providerPrompt.negativePrompt },
      outputWidth: input.scene.canvas.outputWidth,
      outputHeight: input.scene.canvas.outputHeight,
      references,
      parameters: {
        mode: 'canvas',
        originalRequirement: input.originalRequirement,
        promptIr: compilation.promptIr,
        promptPackage: compilation.promptPackage,
        sentPrompt: compilation.providerPrompt.prompt,
        referenceCompilationId: compilation.id,
        referenceAssetId: compilation.asset.id,
        semanticSheetAssetId: compilation.semanticSheetAsset.id,
        referenceMode: input.referenceMode,
        referenceSourceSnapshot: { version: 1, source: referencePreview.source, signature: referencePreview.signature, summary: referencePreview.summary, assetIds: referencePreview.assetIds },
        invocationInputHash: inputHash,
        referenceWarnings: compilation.warnings,
        ...(workflowInvocationId === null ? {} : { workflowInvocationId })
      },
      sourceMessageId: input.sourceMessageId,
      parentResultId: null,
      modelOverride: input.providerId === 'mock' ? input.model : null
    })
    await beforeDispatch?.(request)
    this.#assertGenerationProject(owner)
    if ((await this.#resolveReference(previewInput, config, owner)).signature !== referencePreview.signature) {
      throw new ProviderError('REFERENCE_REVIEW_REQUIRED', '画布在编译期间发生变化，请刷新参考预览。', 'validating')
    }
    const job = await this.#enqueueWorkflowConfigured(request, {
      operation: 'canvas',
      ...(agentScope === undefined ? {} : { agentScope }),
      sourceSceneRevision: input.scene.revision,
      promptPackage: compilation.promptPackage,
      deferActivation,
      idempotencyKey: identity
    }, config, owner)
    return canvasGenerationResultSchema.parse({
      jobId: job.id,
      jobStatus: job.status,
      referenceAssetId: compilation.asset.id,
      semanticSheetAssetId: compilation.semanticSheetAsset.id,
      promptIr: compilation.promptIr,
      promptPackage: compilation.promptPackage,
      sentPrompt: compilation.providerPrompt.prompt,
      sentNegativePrompt: compilation.providerPrompt.negativePrompt,
      warnings: compilation.warnings
    })
    })
  }

  async editFromCanvas(
    inputValue: CanvasEditInput,
    workflowInvocationId: string | null = null,
    beforeDispatch?: (request: ImageTaskRequest) => Promise<void>,
    deferActivation = false,
    agentScope?: AgentGenerationAuthority,
    agentAnnotation: EphemeralAnnotation | null = null
  ): Promise<CanvasEditResult> {
    let input = canvasEditInputSchema.parse(inputValue)
    // Only the internal Agent invocation supplies this argument; IPC provides
    // the normal input alone. Rebuild masks over Main's authoritative Scene.
    const annotation = agentAnnotation === null ? null : ephemeralAnnotationSchema.parse(agentAnnotation)
    if (annotation !== null && annotation.targetElementId !== input.targetElementId) {
      throw new Error('临时标注与局部修改目标不一致。')
    }
    this.#assertRequestedProject(input.scene.projectId)
    const owner = this.#project
    const editMaskCompiler = this.#editMaskCompiler
    return this.#providerSettings.withStableConfiguration(async (config) => {
    this.#assertGenerationProject(owner)
    const inputHash = executionInputHash(annotation === null ? input : { ...input, annotation })
    const identity = workflowInvocationId !== null ? `tool:${workflowInvocationId}`
      : input.sourceMessageId !== null ? `edit-message:${input.sourceMessageId}:${inputHash}` : `manual:${randomUUID()}`
    const existing = await this.#existingCompiledInvocation(identity, inputHash, deferActivation, agentScope)
    if (existing !== null) {
      const saved = existing.request.parameters
      const dimensions = saved.maskDimensions as { width: number; height: number }
      return canvasEditResultSchema.parse({ jobId: existing.id, jobStatus: existing.status, sourceAssetId: saved.sourceAssetId,
        maskAssetId: saved.maskAssetId, maskWidth: dimensions.width, maskHeight: dimensions.height })
    }
    const authoritativeScene = this.#sceneService.state().scene
    if (input.scene.id !== authoritativeScene.id || input.scene.revision !== authoritativeScene.revision) {
      throw new ProviderError('REFERENCE_REVIEW_REQUIRED', '画布或蒙版已修改，请核对当前版本后重新提交。', 'validating')
    }
    const transientMasks = annotation === null ? [] : buildTransientAnnotationMasks(authoritativeScene, input.targetElementId, annotation, randomUUID)
    input = { ...input, scene: transientMasks.length === 0 ? authoritativeScene
      : { ...authoritativeScene, elements: [...authoritativeScene.elements, ...transientMasks] } }
    const { profiles, providers } = await this.#profileEnvironment(config)
    const profileDraft = {
      prompt: input.prompt,
      negativePrompt: input.negativePrompt,
      aspect: { width: input.scene.canvas.aspectWidth, height: input.scene.canvas.aspectHeight },
      quantity: input.count,
      profileId: input.profileId,
      referenceResultIds: input.parentResultId === null ? [] : [input.parentResultId],
      sourceSceneRevision: input.scene.revision,
      referenceMode: 'hybrid' as const,
      variationInstruction: input.prompt,
      preserveConstraints: '蒙版外区域保持不变',
      expandedSections: [] as ('parameters' | 'references' | 'advanced')[]
    }
    const preflight = profiles.compile({
      profileId: input.profileId,
      confirmed: input.confirmed,
      operation: 'edit',
      draft: profileDraft,
      outputWidth: input.scene.canvas.outputWidth,
      outputHeight: input.scene.canvas.outputHeight,
      references: [],
      parameters: {},
      sourceMessageId: input.sourceMessageId,
      parentResultId: input.parentResultId,
      modelOverride: input.providerId === 'mock' ? input.model : null
    })
    if (preflight.providerId !== input.providerId) throw new Error('局部修改档位与请求供应商不一致。')
    const provider = providers.get(preflight.providerId)
    if (!provider.capabilities.maskEditing) {
      throw new Error(`${provider.label} 不支持蒙版局部编辑，请切换到支持该能力的供应商。`)
    }
    const target = input.scene.elements.find((element) => element.id === input.targetElementId)
    if (target?.type !== 'image') throw new Error('局部修改需要先选择一个图片元素。')
    const source = await owner.workspace.assets.getAsset(target.assetId)
    const referenceInput = { projectId: input.scene.projectId, source: { kind: 'images' as const, assetIds: [source.id] },
      profileId: input.profileId, modelOverride: input.providerId === 'mock' ? input.model : null, referenceMode: 'visual' as const }
    const referencePreview = await this.#resolveReference(referenceInput, config, owner)
    if (input.parentResultId !== null && !(await this.#repository.listJobs(owner.workspace.metadata.id)).some((job) => job.results.some((result) => result.id === input.parentResultId && result.assetId === source.id))) {
      throw new ProviderError('REFERENCE_SOURCE_CONFLICT', '局部修改的来源结果与选中图片不一致。', 'validating')
    }
    const mask = await editMaskCompiler.compile(input.scene, target.id, source)
    this.#assertGenerationProject(owner)
    const profileRequest = profiles.compile({
      profileId: input.profileId,
      confirmed: input.confirmed,
      operation: 'edit',
      draft: profileDraft,
      outputWidth: source.width,
      outputHeight: source.height,
      references: [
        { assetId: source.id, intent: 'edit-source', strength: 1 },
        { assetId: mask.asset.id, intent: 'mask', strength: 1 }
      ],
      parameters: {
        mode: 'local-edit',
        originalRequirement: input.prompt,
        targetElementId: target.id,
        sourceAssetId: source.id,
        maskAssetId: mask.asset.id,
        contributingMaskIds: mask.contributingMaskIds,
        referenceSourceSnapshot: { version: 1, source: referencePreview.source, signature: referencePreview.signature,
          summary: '选中的图片与当前画布蒙版', sceneRevision: authoritativeScene.revision, assetIds: [source.id, mask.asset.id] },
        sourceDimensions: { width: source.width, height: source.height },
        maskDimensions: { width: mask.width, height: mask.height },
        invocationInputHash: inputHash,
        ...(workflowInvocationId === null ? {} : { workflowInvocationId })
      },
      sourceMessageId: input.sourceMessageId,
      parentResultId: input.parentResultId,
      modelOverride: input.providerId === 'mock' ? input.model : null
    })
    const request: ImageTaskRequest = {
      ...profileRequest,
      kind: 'edit',
      sourceAssetId: source.id,
      maskAssetId: mask.asset.id,
    }
    await beforeDispatch?.(request)
    this.#assertGenerationProject(owner)
    if (this.#sceneService.state().scene.revision !== authoritativeScene.revision
      || (await this.#resolveReference(referenceInput, config, owner)).signature !== referencePreview.signature) {
      throw new ProviderError('REFERENCE_REVIEW_REQUIRED', '画布、蒙版或源图在编译期间发生变化，请重新核对。', 'validating')
    }
    const job = await this.#enqueueWorkflowConfigured(request, {
      operation: 'edit',
      ...(agentScope === undefined ? {} : { agentScope }),
      sourceSceneRevision: input.scene.revision,
      promptPackage: profileRequest.parameters.promptPackage ?? null,
      deferActivation,
      idempotencyKey: identity
    }, config, owner)
    return canvasEditResultSchema.parse({
      jobId: job.id,
      jobStatus: job.status,
      sourceAssetId: source.id,
      maskAssetId: mask.asset.id,
      maskWidth: mask.width,
      maskHeight: mask.height
    })
    })
  }

  cancel(jobId: string): Promise<GenerationJob> {
    return this.#queue.cancel(jobId)
  }

  resultFamilies(): Promise<readonly GenerationResultFamily[]> {
    return this.#workflowCoordinator.resultFamilies()
  }

  async setGenerationResultFavorite(inputValue: GenerationResultFavoriteInput): Promise<readonly GenerationResultFamily[]> {
    const input = generationResultFavoriteInputSchema.parse(inputValue)
    this.#assertRequestedProject(input.projectId)
    const owner = this.#project
    const exists = (await this.#repository.listJobs(this.#project.workspace.metadata.id))
      .some((job) => job.results.some((result) => result.id === input.resultId))
    if (!exists) throw new Error('The requested generation result does not exist in this project.')
    this.#assertGenerationProject(owner)
    await this.#repository.setFavorite(input.resultId, input.favorite)
    return this.#workflowCoordinator.resultFamilies()
  }

  async placeGenerationResult(inputValue: PlaceGenerationResultInput, expectedSceneRevision?: number | null, signal?: AbortSignal, targetElementId?: string): Promise<PlaceGenerationResultReceipt> {
    const input = placeGenerationResultInputSchema.parse(inputValue)
    this.#assertRequestedProject(input.projectId)
    const owner = this.#project
    const jobs = await this.#repository.listJobs(this.#project.workspace.metadata.id)
    this.#assertGenerationProject(owner)
    const match = jobs.flatMap((job) => job.results.map((result) => ({ job, result })))
      .find((entry) => entry.result.id === input.resultId)
    if (match === undefined) throw new Error('The requested generation result does not exist in this project.')
    const current = this.#sceneService.state().scene
    if (expectedSceneRevision !== undefined && expectedSceneRevision !== current.revision) {
      throw new AgentToolExecutorError('SCENE_REVISION_STALE',
        `The plan expected scene revision ${expectedSceneRevision}, but revision ${current.revision} is current.`, true)
    }
    const target = targetElementId === undefined ? undefined : current.elements.find((element) => element.id === targetElementId)
    if (targetElementId !== undefined && (target === undefined || (target.type !== 'image' && target.type !== 'placeholder'))) {
      throw new AgentToolExecutorError('TOOL_SCOPE_DENIED', '要替换的图片或占位已经不存在，未修改画布。', true)
    }
    if (target !== undefined && (target.locked || current.elements.some((element) => element.id === target.groupId && element.locked))) {
      throw new AgentToolExecutorError('TOOL_SCOPE_DENIED', '要替换的对象已锁定，未修改画布。', true)
    }
    if (target !== undefined && current.elements.some((element) => element.type === 'mask' && element.targetElementId === target.id && element.mode === 'protect')) {
      throw new AgentToolExecutorError('SCENE_ELEMENT_PROTECTED', '要替换的对象有保护蒙版，未修改画布。', true)
    }
    const existing = target?.type === 'image' && target.assetId === match.result.assetId
      ? target : current.elements.find((element) => element.id === input.placementId)
    if (existing !== undefined) {
      if (existing.type !== 'image' || existing.assetId !== match.result.assetId) {
        throw new Error('The placement id is already bound to a different canvas element.')
      }
      return placeGenerationResultReceiptSchema.parse({
        resultId: match.result.id,
        jobId: match.job.id,
        assetId: match.result.assetId,
        elementId: existing.id,
        batchId: input.placementId,
        sceneRevision: current.revision,
        reused: true
      })
    }
    const asset = await this.#project.workspace.assets.getAsset(match.result.assetId)
    this.#assertGenerationProject(owner)
    const lineage = (await this.resultFamilies())
      .flatMap((family) => family.members)
      .find((member) => member.resultId === match.result.id)
    this.#assertGenerationProject(owner)
    const canvasAspect = current.canvas.outputWidth / current.canvas.outputHeight
    const imageAspect = asset.width / asset.height
    const maxWidth = 0.78
    const maxHeight = 0.78
    const width = imageAspect >= canvasAspect ? maxWidth : Math.min(maxWidth, maxHeight * imageAspect / canvasAspect)
    const height = imageAspect >= canvasAspect ? Math.min(maxHeight, maxWidth * canvasAspect / imageAspect) : maxHeight
    const element: SceneElement = {
      id: input.placementId,
      version: ELEMENT_SCHEMA_VERSION,
      type: 'image',
      name: `生成结果 ${match.result.variantIndex + 1}`,
      description: `由 ${match.job.providerId}/${match.job.model} 生成；保留 Result 与 Job 血缘。`,
      transform: { x: (1 - width) / 2, y: (1 - height) / 2, width, height, rotation: 0 },
      zIndex: current.elements.length,
      opacity: 1,
      blendMode: 'normal',
      visible: true,
      locked: false,
      groupId: null,
      semanticRole: 'generated-result',
      referencePolicy: 'include',
      provenance: {
        origin: match.job.providerId === 'mock' ? 'mock-generated' : 'provider-generated',
        sourceBriefId: lineage?.sourceBriefId ?? null,
        sourceDirectionId: lineage?.sourceDirectionId ?? null,
        sourceAssetId: match.result.assetId
      },
      assetId: match.result.assetId,
      crop: { x: 0, y: 0, width: 1, height: 1 },
      fit: 'contain',
      referenceRole: 'general'
    }
    const mutation = await this.#sceneService.execute({
      expectedSceneRevision: current.revision,
      batch: {
        id: input.placementId,
        origin: input.origin,
        summary: target === undefined ? '将生成结果放入画布' : `将生成结果放入${target.name}`,
        commands: target === undefined ? [{ kind: 'element.add', element }] : [{
          kind: 'element.set-image', elementId: target.id, assetId: match.result.assetId, provenance: element.provenance!
        }]
      }
    }, signal)
    if (!mutation.ok) throw new Error(`${mutation.error.code}: ${mutation.error.message}`)
    return placeGenerationResultReceiptSchema.parse({
      resultId: match.result.id,
      jobId: match.job.id,
      assetId: match.result.assetId,
      elementId: target?.id ?? element.id,
      batchId: mutation.receipt.affectedBatchId,
      sceneRevision: mutation.receipt.state.scene.revision,
      reused: false
    })
  }

  async #enqueueWorkflow(
    request: ImageTaskRequest,
    metadata: WorkflowMetadata
  ): Promise<GenerationJob> {
    const owner = this.#project
    return this.#providerSettings.withStableConfiguration((config) => this.#enqueueWorkflowConfigured(request, metadata, config, owner))
  }

  async #enqueueWorkflowConfigured(request: ImageTaskRequest, metadata: WorkflowMetadata, config: ProviderConfigFile,
    owner: OpenProjectResult): Promise<GenerationJob> {
    this.#assertGenerationProject(owner)
    const coordinator = this.#workflowCoordinator
    const profileId = typeof request.parameters.generationProfileId === 'string'
      ? request.parameters.generationProfileId
      : 'local-sketch'
    const tierValue = request.parameters.generationProfileTier
    const tier = tierValue === 'draft' || tierValue === 'final' ? tierValue : 'local-sketch'
    const estimatedValue = request.parameters.simulatedEstimatedCostCny
    const estimatedCostCny = typeof estimatedValue === 'number' && Number.isFinite(estimatedValue)
      ? Math.max(0, estimatedValue)
      : 0
    const identity = workflowIdentity(request, metadata)
    const existing = await coordinator.getIntentByKey(owner.workspace.metadata.id, identity)
    let binding: ImageExecutionBinding | null = existing?.spec.executionIdentityId
      ? await this.#executionBindings.read(existing.spec.executionIdentityId) : null
    const image = binding?.image ?? metadata.retryExecution?.image ?? config.providers.find((item): item is ImageProviderConfig => item.kind === 'image')
    const policy = binding?.policy ?? metadata.retryExecution?.policy ?? config.executionPolicy
    const provider = request.providerId === 'mock' ? this.#providers.get('mock')
      : image === undefined ? null : this.#makeImageProvider(image, policy)
    if (provider === null) throw new ProviderError('REQUEST_IDENTITY_UNAVAILABLE', '当前图片配置不可用，请先核对设置。', 'validating')
    const effectiveTimeoutMs = request.providerId === 'mock' ? 120_000 : image!.timeoutMs
    this.#assertGenerationProject(owner)
    if (metadata.agentScope !== undefined && metadata.agentScope.projectId !== owner.workspace.metadata.id) {
      throw new ProviderError('PROJECT_CONTEXT_CHANGED', '生成授权所属作品已经切换。', 'validating')
    }
    const created = await coordinator.create({
      projectId: owner.workspace.metadata.id,
      ...(metadata.agentScope === undefined ? {} : {
        threadId: metadata.agentScope.threadId, turnId: metadata.agentScope.turnId, toolCallItemId: metadata.agentScope.toolCallItemId
      }),
      sourceMessageId: request.sourceMessageId,
      request,
      capabilities: provider.capabilities,
      profileId,
      tier,
      operation: metadata.operation,
      sourceSceneRevision: metadata.sourceSceneRevision,
      promptPackage: metadata.promptPackage,
      idempotencyKey: identity,
      limits: {
        maxJobs: 1,
        maxImages: request.count,
        maxCostCny: estimatedCostCny,
        maxWallTimeMs: effectiveTimeoutMs,
        noImprovementLimit: 1
      },
      estimatedCostCny,
      bindExecution: async (compiled) => {
        this.#assertGenerationProject(owner)
        if (request.providerId === 'mock') return { executionIdentityId: null, effectiveTimeoutMs }
        if (binding === null) {
          if (existing !== null) throw new ProviderError('REQUEST_IDENTITY_UNAVAILABLE', '原任务缺少可验证的配置身份，请核对原任务。', 'validating')
          if (image === undefined || request.model !== image.defaultModel) {
            throw new ProviderError('REQUEST_CONFIG_CHANGED', '图片模型设置已变化，请核对后重新提交。', 'validating')
          }
          const retryExecution = metadata.retryExecution
          if (retryExecution !== undefined && (retryExecution.projectId !== owner.workspace.metadata.id
            || retryExecution.requestHash !== executionRequestHash(compiled))) {
            throw new ProviderError('IDEMPOTENCY_CONFLICT', '重试内容与原请求身份不一致。', 'validating')
          }
          const credentialReference = retryExecution?.credentialReference ?? await this.#secrets.captureReference('image-provider')
          if (credentialReference === null) throw new ProviderError('PROVIDER_KEY_MISSING', '请先安全保存图片供应商凭据。', 'validating')
          if (!await this.#secrets.hasReference('image-provider', credentialReference)) {
            throw new ProviderError('REQUEST_IDENTITY_UNAVAILABLE', '原凭据版本已撤销，请核对原任务。', 'validating')
          }
          binding = await this.#executionBindings.create({ projectId: owner.workspace.metadata.id,
            image, policy, credentialReference, model: compiled.model, invocationKey: identity,
            operation: 'kind' in compiled && compiled.kind === 'edit' ? 'edit' : 'generate', requestHash: executionRequestHash(compiled) })
        }
        this.#assertGenerationProject(owner)
        if (binding.projectId !== owner.workspace.metadata.id || binding.invocationKey !== identity
          || binding.requestHash !== executionRequestHash(compiled)) {
          throw new ProviderError('IDEMPOTENCY_CONFLICT', '同一生成请求的内容与原身份不一致。', 'validating')
        }
        return { executionIdentityId: binding.id, effectiveTimeoutMs }
      },
      deferActivation: metadata.deferActivation === true,
      parentJobId: metadata.parentJobId ?? null
    })
    return created.job
  }

  async retry(jobId: string, overrides: { readonly providerId?: string; readonly model?: string } = {}): Promise<GenerationJob> {
    this.#assertRequestedProject()
    const owner = this.#project
    const previous = await this.#repository.getJob(jobId)
    this.#assertGenerationProject(owner)
    if (previous.copiedFromProjectId) throw new ProviderError('PROJECT_COPY_REQUIRES_NEW_REQUEST', '这是原作品的任务记录。请用新的生成请求继续副本，不会重放原批准。', 'validating')
    if (previous.providerId !== 'mock' && (previous.externalTaskId !== null
      || previous.submissionState !== 'not_sent' || previous.error?.code === 'REQUEST_IDENTITY_UNAVAILABLE')) {
      throw new ProviderError('NO_REPOST', '原请求可能已经发送。请先核对原任务；重试不能创建另一份付费请求。', 'validating')
    }
    if (previous.providerId !== 'mock') {
      if ((overrides.providerId !== undefined && overrides.providerId !== previous.providerId)
        || (overrides.model !== undefined && overrides.model !== previous.model)) {
        throw new ProviderError('REQUEST_CONFIG_CHANGED', '原样重试保留原图片模型；更换模型请创建新请求。', 'validating')
      }
      try { await this.#resolveImageExecution(previous) }
      catch { throw new ProviderError('REQUEST_IDENTITY_UNAVAILABLE', '原请求配置或凭据版本无法核对，重试已暂停。', 'validating') }
      const retryExecution = await this.#executionBindings.read(previous.executionIdentityId!)
      this.#assertGenerationProject(owner)
      return this.#enqueueWorkflow(previous.request, {
        operation: 'kind' in previous.request && previous.request.kind === 'edit' ? 'edit'
          : previous.request.parentResultId === null ? 'text' : 'similar',
        sourceSceneRevision: typeof previous.request.parameters.sourceSceneRevision === 'number' ? previous.request.parameters.sourceSceneRevision : null,
        promptPackage: previous.request.parameters.promptPackage ?? null, parentJobId: previous.id,
        idempotencyKey: `retry:${previous.id}:attempt:${previous.attempt + 1}`, retryExecution
      })
    }
    const profileId = previous.request.parameters.generationProfileId
    if (typeof profileId === 'string') {
      const operation = 'kind' in previous.request && previous.request.kind === 'edit'
        ? 'edit' as const
        : previous.request.references.length === 0 ? 'generate' as const : 'reference' as const
      const validated = this.#profiles.compile({
        profileId,
        confirmed: true,
        operation,
        draft: {
          prompt: previous.request.prompt,
          negativePrompt: previous.request.negativePrompt,
          aspect: { width: previous.request.aspectWidth, height: previous.request.aspectHeight },
          quantity: previous.request.count,
          profileId,
          referenceResultIds: previous.request.parentResultId === null ? [] : [previous.request.parentResultId],
          sourceSceneRevision: null,
          expandedSections: []
        },
        outputWidth: previous.request.outputWidth,
        outputHeight: previous.request.outputHeight,
        references: previous.request.references,
        parameters: previous.request.parameters,
        sourceMessageId: previous.request.sourceMessageId,
        parentResultId: previous.request.parentResultId,
        modelOverride: overrides.model ?? previous.model
      })
      if (overrides.providerId !== undefined && overrides.providerId !== validated.providerId) {
        throw new ProviderError('PROFILE_PROVIDER_OVERRIDE_REJECTED', 'Retry cannot move a profiled image task to a different provider.', 'validating')
      }
      const retryRequest: ImageTaskRequest = operation === 'edit' && 'kind' in previous.request && previous.request.kind === 'edit'
        ? {
            ...validated,
            kind: 'edit',
            sourceAssetId: previous.request.sourceAssetId,
            maskAssetId: previous.request.maskAssetId
          }
        : validated
      const workflowOperation: GenerationWorkflowOperation = operation === 'edit'
        ? 'edit'
        : validated.parentResultId === null ? 'text' : 'similar'
      return this.#enqueueWorkflow(retryRequest, {
        operation: workflowOperation,
        sourceSceneRevision: typeof validated.parameters.sourceSceneRevision === 'number'
          ? validated.parameters.sourceSceneRevision
          : null,
        promptPackage: validated.parameters.promptPackage ?? null,
        parentJobId: previous.id,
        idempotencyKey: `retry:${previous.id}:attempt:${previous.attempt + 1}`
      })
    }
    const request = imageTaskRequestSchema.parse({
      ...previous.request,
      providerId: overrides.providerId ?? previous.providerId,
      model: overrides.model ?? previous.model
    })
    return this.#enqueueWorkflow(request, {
      operation: 'kind' in request && request.kind === 'edit'
        ? 'edit'
        : request.parentResultId === null ? 'text' : 'similar',
      sourceSceneRevision: typeof request.parameters.sourceSceneRevision === 'number'
        ? request.parameters.sourceSceneRevision
        : null,
      promptPackage: request.parameters.promptPackage ?? null,
      parentJobId: previous.id,
      idempotencyKey: `retry:${previous.id}:attempt:${previous.attempt + 1}`
    })
  }

  async #executePersistentAgentTool(
    tool: AgentToolPlan,
    context: AgentLoopToolContext,
    toolExecutor: AgentToolExecutorShadow,
    sceneService: SceneService,
    outboundContextService: OutboundContextService
  ): Promise<AgentToolOutcome> {
    if (context.signal.aborted) throw context.signal.reason
    const owner = this.#project
    if (owner.workspace.metadata.id !== context.projectId) {
      throw new ProviderError('PROJECT_CONTEXT_CHANGED', '原任务所属项目已切换，不能在其他项目执行。', 'validating')
    }
    if (tool.kind === 'scene.get_summary') {
      const summary = summarizeScene(sceneService.state().scene)
      return {
        toolIndex: context.toolIndex,
        ok: true,
        batchId: null,
        jobId: null,
        affectedElementIds: [],
        message: `已读取 Scene revision ${summary.revision} 与 ${summary.elementCount} 个元素的摘要。`,
        data: summary
      }
    }
    if (tool.kind === 'scene.get_elements') {
      const scene = sceneService.state().scene
      const requested = new Set(tool.elementIds)
      const elements = tool.elementIds.length === 0
        ? scene.elements.slice(0, 100)
        : scene.elements.filter((element) => requested.has(element.id)).slice(0, 100)
      return {
        toolIndex: context.toolIndex,
        ok: true,
        batchId: null,
        jobId: null,
        affectedElementIds: elements.map((element) => element.id),
        message: `已读取 ${elements.length} 个元素。`,
        data: { sceneRevision: scene.revision, elements }
      }
    }
    if (tool.kind === 'scene_batch' || isAtomicSceneWriteTool(tool)) {
      const atomic = isAtomicSceneWriteTool(tool)
      const summary = atomic ? tool.summary : tool.summary
      const commands = atomic ? compileAtomicSceneCommands(tool) : tool.commands
      const blendViolation = blendModeCommandViolation(sceneService.state().scene, commands)
      if (blendViolation !== null) {
        throw new AgentToolExecutorError('TOOL_SCOPE_DENIED', blendViolation, true)
      }
      const expectedSceneRevision = atomic
        ? tool.expectedSceneRevision
        : context.expectedSceneRevision === undefined ? context.request.sceneSummary.revision : context.expectedSceneRevision
      const currentSceneRevision = sceneService.state().scene.revision
      if (expectedSceneRevision !== currentSceneRevision) {
        throw new AgentToolExecutorError(
          'SCENE_REVISION_STALE',
          `The plan expected scene revision ${expectedSceneRevision}, but revision ${currentSceneRevision} is current.`,
          true
        )
      }
      const receipt = await toolExecutor.executeSceneBatchMain({
        projectId: context.projectId,
        threadId: context.threadId,
        turnId: context.turnId,
        legacyRunId: context.legacyRunId,
        ordinal: context.toolCallOrdinal,
        mode: 'collaboration',
        explicitTurnAuthorization: true,
        definitionName: atomic ? tool.kind : 'scene.apply_batch',
        scene: sceneService.state().scene,
        tool: {
          idempotencyKey: `turn:${context.turnId}:item:${context.toolCallItemId}:${tool.kind}:v1`,
          expectedSceneRevision,
          scope: {
            canvas: context.request.selectedIds.length === 0
              || (atomic && (tool.kind === 'scene.set_canvas' || tool.kind === 'scene.create_elements')),
            elementIds: context.request.selectedIds
          },
          summary,
          commands
        },
        executeBatch: (batch, expectedSceneRevision) => sceneService.execute({ expectedSceneRevision, batch }, context.signal)
      })
      return { ...receipt.outcome, toolIndex: context.toolIndex }
    }
    if (tool.kind === 'history.undo_batch') {
      const result = await sceneService.undo({
        expectedSceneRevision: tool.expectedSceneRevision,
        batchId: tool.batchId
      }, context.signal)
      if (!result.ok) {
        throw Object.assign(new Error(result.error.message), {
          code: result.error.code,
          recoverable: result.error.recoverable
        })
      }
      return {
        toolIndex: context.toolIndex,
        ok: true,
        batchId: result.receipt.affectedBatchId,
        jobId: null,
        affectedElementIds: [],
        message: '已撤销最近一个匹配的画布批次。',
        sceneRevisionBefore: tool.expectedSceneRevision,
        sceneRevisionAfter: result.receipt.state.scene.revision
      }
    }
    if (tool.kind === 'place_generation_result' || tool.kind === 'result.place_on_canvas') {
      if (tool.targetElementId !== undefined && context.request.selectedIds.length > 0 && !context.request.selectedIds.includes(tool.targetElementId)) {
        throw new AgentToolExecutorError('TOOL_SCOPE_DENIED', '替换目标不在本轮选区中，未修改画布。', true)
      }
      if (!(context.request.generationResults ?? []).some((result) => result.resultId === tool.resultId)) {
        throw new Error('要放入画布的生成结果不在当前可核对结果列表中。')
      }
      const expectedSceneRevision = context.expectedSceneRevision === undefined
        ? context.request.sceneSummary.revision : context.expectedSceneRevision
      const receipt = await this.placeGenerationResult({
        resultId: tool.resultId,
        placementId: context.toolCallItemId,
        origin: 'agent'
      }, expectedSceneRevision, context.signal, tool.targetElementId)
      return {
        toolIndex: context.toolIndex,
        ok: true,
        batchId: receipt.reused ? null : receipt.batchId,
        jobId: receipt.jobId,
        affectedElementIds: receipt.reused ? [] : [receipt.elementId],
        message: receipt.reused ? '该结果已经位于画布中，没有新的修改。' : tool.targetElementId === undefined ? '生成结果已作为可编辑图片层放入画布。' : '生成结果已替换目标图片，布局保持不变。',
        sceneRevisionBefore: expectedSceneRevision ?? undefined,
        sceneRevisionAfter: receipt.sceneRevision
      }
    }
    if (tool.kind === 'memory_candidate') {
      await this.#agent.createMemoryCandidate({
        kind: tool.memoryKind,
        content: tool.content,
        sourceType: 'planner',
        sourceId: context.turnId,
        confidence: tool.confidence
      })
      return {
        toolIndex: context.toolIndex,
        ok: true,
        batchId: null,
        jobId: null,
        affectedElementIds: [],
        message: '已提出项目记忆候选，等待用户确认。'
      }
    }
    if (tool.kind === 'directive_create') {
      if (!/(?:记住|以后|始终|必须|规则|不要再|每次)/u.test(context.request.text)) {
        throw new Error('写入项目规则需要用户在本轮明确表达长期约束。')
      }
      await this.#agent.createProjectDirective({
        text: tool.text,
        category: tool.category,
        priority: tool.priority,
        sourceMessageId: context.sourceMessageId
      })
      return {
        toolIndex: context.toolIndex,
        ok: true,
        batchId: null,
        jobId: null,
        affectedElementIds: [],
        message: '项目规则已写入，可在设置中停用或修改。'
      }
    }
    if (tool.kind === 'generation') {
      await this.#prepareImageOutbound(context, outboundContextService, tool.request)
      const operation = tool.request.references.length === 0 ? 'generate' : 'reference'
      const profileId = await this.#profileIdForInvocation(tool.request.providerId, operation, context.toolCallItemId)
      this.#assertGenerationProject(owner)
      const job = await this.enqueueProfile({
        profileId,
        confirmed: tool.request.providerId !== 'mock',
        operation,
        draft: {
          prompt: tool.request.prompt,
          negativePrompt: tool.request.negativePrompt,
          aspect: { width: tool.request.aspectWidth, height: tool.request.aspectHeight },
          quantity: tool.request.count,
          profileId,
          referenceResultIds: tool.request.parentResultId === null ? [] : [tool.request.parentResultId],
          sourceSceneRevision: sceneService.state().scene.revision,
          referenceMode: tool.request.referenceMode,
          variationInstruction: tool.request.variationInstruction,
          preserveConstraints: tool.request.preserveConstraints,
          expandedSections: []
        },
        outputWidth: tool.request.outputWidth,
        outputHeight: tool.request.outputHeight,
        references: tool.request.references,
        parameters: { ...tool.request.parameters, workflowInvocationId: context.toolCallItemId },
        sourceMessageId: context.sourceMessageId,
        parentResultId: tool.request.parentResultId,
        modelOverride: tool.request.model
      }, { deferActivation: true, agentScope: context })
      return { toolIndex: context.toolIndex, ok: true, batchId: null, jobId: job.id, affectedElementIds: [], message: '图片生成任务已创建。' }
    }
    if (tool.kind === 'canvas_generation') {
      const operation = 'reference' as const
      const profileId = await this.#profileIdForInvocation(tool.providerId, operation, context.toolCallItemId)
      this.#assertGenerationProject(owner)
      const compilation = await this.generateFromCanvas({
        scene: sceneService.state().scene,
        originalRequirement: tool.originalRequirement,
        providerId: tool.providerId,
        model: tool.model,
        count: tool.count,
        referenceMode: tool.referenceMode,
        profileId,
        confirmed: tool.providerId !== 'mock',
        sourceMessageId: context.sourceMessageId
      }, context.toolCallItemId, async (request) => {
        await this.#prepareImageOutbound(context, outboundContextService, request)
      }, true, context)
      return {
        toolIndex: context.toolIndex,
        ok: true,
        batchId: null,
        jobId: compilation.jobId,
        affectedElementIds: [],
        message: '画布参考与图片生成任务已创建。'
      }
    }
    if (tool.kind === 'canvas_edit') {
      const scene = sceneService.state().scene
      const target = scene.elements.find((element) => element.id === tool.targetElementId)
      if (target?.type !== 'image') throw new Error('局部修改目标不是可用的图片元素。')
      const parentResult = (await this.listJobs()).flatMap((job) => job.results).find((result) => result.assetId === target.assetId)
      const profileId = await this.#profileIdForInvocation(tool.providerId, 'edit', context.toolCallItemId, 'final')
      this.#assertGenerationProject(owner)
      const edit = await this.editFromCanvas({
        scene,
        targetElementId: target.id,
        prompt: tool.prompt,
        negativePrompt: '',
        providerId: tool.providerId,
        model: tool.model,
        count: tool.count,
        profileId,
        confirmed: tool.providerId !== 'mock',
        sourceMessageId: context.sourceMessageId,
        parentResultId: parentResult?.id ?? null
      }, context.toolCallItemId, async (request) => {
        await this.#prepareImageOutbound(context, outboundContextService, request)
      }, true, context, tool.ephemeralAnnotation)
      return {
        toolIndex: context.toolIndex,
        ok: true,
        batchId: null,
        jobId: edit.jobId,
        affectedElementIds: [target.id],
        message: '局部修改任务已创建，源图保持不变。'
      }
    }
    const job = await this.cancel(tool.jobId)
    return { toolIndex: context.toolIndex, ok: true, batchId: null, jobId: job.id, affectedElementIds: [], message: '生成任务已取消。' }
  }

  async #prepareImageOutbound(
    context: AgentLoopToolContext,
    service: OutboundContextService,
    request: ImageTaskRequest
  ): Promise<OutboundContextRecord | null> {
    if (context.contextManifestId === null) return null
    const measurement = await measureOutboundImagePayload(request, async (assetId) => {
      const resolved = await this.#project.workspace.assets.resolveAsset(assetId)
      const metadata = await stat(resolved.filePath)
      if (!metadata.isFile()) throw new Error(`Asset ${assetId} is not an outbound file.`)
      return metadata.size
    })
    const record = await service.prepare({
      projectId: context.projectId,
      threadId: context.threadId,
      turnId: context.turnId,
      manifestId: context.contextManifestId,
      // Generation Tool Items are linked through generation_workflow_intents.tool_call_item_id.
      // agent_outbound_context_records.tool_call_id references the Scene ToolCall ledger instead.
      toolCallId: null,
      providerId: request.providerId,
      model: request.model,
      dataTypes: ['user_text', 'prompt_package', ...(measurement.imageAssetIds.length > 0 ? ['reference_image'] : [])],
      imageAssetIds: measurement.imageAssetIds,
      textBytes: Buffer.byteLength(request.prompt, 'utf8'),
      imageBytes: measurement.imageBytes,
      approvalId: context.approvalId,
      requestCorrelationId: context.requestCorrelationId ?? context.toolCallItemId,
      providerLocal: request.providerId === 'mock',
      permissionAllowsExternal: request.providerId !== 'mock',
      imageReviewApproved: context.approvalId !== null
    })
    if (record.status === 'blocked') {
      const error = new Error(record.reason) as Error & { code: string }
      error.code = 'OUTBOUND_POLICY_BLOCKED'
      throw error
    }
    return record
  }

  getConversation(): Promise<ConversationSnapshot> {
    return this.#agent.snapshot()
  }

  async acceptDesignReview(inputValue: AcceptDesignReviewInput): Promise<ConversationSnapshot> {
    const input = acceptDesignReviewInputSchema.parse(inputValue)
    const owner = this.#project
    if (owner.workspace.metadata.id !== input.projectId) throw new Error('PROJECT_CHANGED: 当前项目已改变。')
    const validate = () => {
      this.#assertGenerationProject(owner)
      if (this.#sceneService.state().scene.revision !== input.sceneRevision) throw new Error('作品已修改；之前的检查不能代表当前版本。')
    }
    validate()
    return this.#agent.acceptDesignReview(input.messageId, input.sceneRevision, validate)
  }

  getAgentHarnessSnapshot(): Promise<AgentHarnessSnapshot> {
    return this.#agent.harnessSnapshot()
  }

  getProjectKnowledge(): Promise<ProjectKnowledgeSnapshot> {
    return this.#agent.getProjectKnowledge()
  }

  createProjectDirective(input: CreateProjectDirectiveInput): Promise<ProjectKnowledgeSnapshot> {
    return this.#agent.createProjectDirective(input)
  }

  updateProjectDirective(input: UpdateProjectDirectiveInput): Promise<ProjectKnowledgeSnapshot> {
    return this.#agent.updateProjectDirective(input)
  }

  createProjectMemory(input: CreateProjectMemoryInput): Promise<ProjectKnowledgeSnapshot> {
    return this.#agent.createProjectMemory(input)
  }

  updateProjectMemory(input: UpdateProjectMemoryInput): Promise<ProjectKnowledgeSnapshot> {
    return this.#agent.updateProjectMemory(input)
  }

  createMemoryCandidate(input: CreateMemoryCandidateInput): Promise<ProjectKnowledgeSnapshot> {
    return this.#agent.createMemoryCandidate(input)
  }

  resolveMemoryCandidate(input: ResolveMemoryCandidateInput): Promise<ProjectKnowledgeSnapshot> {
    return this.#agent.resolveMemoryCandidate(input)
  }

  setOutboundPolicy(input: SetOutboundPolicyInput): Promise<ProjectKnowledgeSnapshot> {
    return this.#agent.setOutboundPolicy(input)
  }

  replayAgentEvents(afterSequence: number, limit = 1_000): Promise<readonly AgentEvent[]> {
    return this.#agent.replayHarnessEvents(afterSequence, limit)
  }

  subscribeAgent(listener: (event: AgentEvent) => void): () => void {
    this.#agentListeners.add(listener)
    return () => this.#agentListeners.delete(listener)
  }

  startAgentRun(request: AgentRequest, mode: AgentMode = 'collaboration', taskRelation?: TaskRelation): Promise<AgentRun> {
    this.#assertRequestedProject(request.projectId)
    return this.#agent.start(request, mode, taskRelation)
  }

  inputAgentRun(request: AgentRequest, semantics: TurnInputMode | AgentTaskDispatch): Promise<AgentRun> {
    this.#assertRequestedProject(request.projectId)
    return this.#agent.input(request, semantics)
  }

  resumeAgentQueue(): Promise<number> {
    return this.#agent.resumeQueue()
  }

  resolveTemporaryAgentTurn(turnId: string, resolution: 'accept' | 'reject'): Promise<AgentHarnessSnapshot> {
    return this.#agent.resolveTemporaryTry(turnId, resolution)
  }

  claimAgentPlan(runId: string): Promise<AgentPlan | null> {
    return this.#agent.claimPlan(runId)
  }

  confirmAgentRun(runId: string, optionId?: string): Promise<AgentRun> {
    return this.#agent.confirm(runId, optionId)
  }

  reportAgentToolStarted(runId: string, toolIndex: number): Promise<void> {
    return this.#agent.reportToolStarted(runId, toolIndex)
  }

  executeAgentSceneTool(runId: string, toolIndex: number): Promise<AgentSceneToolCommitReceipt> {
    return this.#agent.executeMainSceneTool(
      runId,
      toolIndex,
      this.#sceneService.state().scene,
      (batch, expectedSceneRevision) => this.#sceneService.execute({ expectedSceneRevision, batch })
    )
  }

  completeAgentRun(input: { readonly runId: string; readonly outcomes: readonly AgentToolOutcome[] }): Promise<AgentRun> {
    return this.#agent.complete(input)
  }

  cancelAgentRun(runId: string): Promise<AgentRun> {
    return this.#agent.cancel(runId)
  }

  async markActivityBatchUndone(batchId: string): Promise<void> {
    const ledger = new ActivityLedgerRepository(join(this.#project.workspace.directory, 'project.db'))
    try {
      await ledger.markBatchUndone(this.#project.workspace.metadata.id, batchId)
    } finally {
      await ledger.close()
    }
  }

  #assertRequestedProject(projectId?: string): void {
    if (this.#closed || this.#closingProject) throw new Error('PROJECT_CHANGED: 项目正在切换，请稍后继续。')
    if (projectId !== undefined && projectId !== this.#project.workspace.metadata.id) throw new Error('PROJECT_CHANGED: 项目已经切换，请回到原作品后继续。')
  }

  async readAssetDataUrl(assetId: string, thumbnail: boolean, projectId?: string): Promise<string> {
    this.#assertRequestedProject(projectId)
    const owner = this.#project
    const asset = (await owner.workspace.repository.listAssets()).find((candidate) => candidate.id === assetId)
    if (asset === undefined || asset.status !== 'available') throw new Error('The requested generation asset is unavailable.')
    const filePath = thumbnail
      ? owner.workspace.assets.resolveThumbnail(asset)
      : owner.workspace.assets.resolveOriginal(asset)
    const bytes = await readFile(filePath).catch(async (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && this.#project === owner && !this.#closingProject && !this.#closed) {
        await owner.workspace.repository.updateAssetStatus(asset.id, 'missing')
      }
      throw error
    })
    const mime = thumbnail ? 'image/webp' : mimeFor(asset.format)
    return `data:${mime};base64,${bytes.toString('base64')}`
  }

  async close(): Promise<void> {
    if (this.#closePromise !== null) return this.#closePromise
    const lifecycle = this.#projectLifecycle
    this.#closePromise = (async () => {
      await lifecycle?.catch(() => undefined)
      this.#closed = true
      await this.#closeProject(true)
      await this.#diagnosticLog.flush()
    })()
    return this.#closePromise
  }
}
