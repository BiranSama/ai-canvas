import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from 'electron'
import { basename, extname } from 'node:path'
import { DESKTOP_CHANNELS, DESKTOP_EVENTS, type RuntimeInfo } from '../../shared/desktop-api'
import { diagnosticExportResultSchema } from '../../shared/diagnostics'
import { projectWorkContextSchema } from '../../shared/project-work-context'
import { generationReferencePreviewInputSchema } from '../../shared/generation-reference'
import type { AppearanceSettingsService } from '../appearance/appearance-settings-service'
import type { GenerationRuntime } from '../generation/generation-runtime'
import { inspectNativeModules } from '../native-health'
import {
  activityBatchIdSchema,
  appearanceSettingsSetSchema,
  agentDecisionResolveSchema,
  agentDirectiveCreateSchema,
  agentDirectiveUpdateSchema,
  agentEventReplaySchema,
  agentInputSchema,
  agentTemporaryResolveSchema,
  agentMemoryCandidateCreateSchema,
  agentMemoryCandidateResolveSchema,
  agentMemoryCreateSchema,
  agentMemoryUpdateSchema,
  agentOutboundPolicySetSchema,
  agentRunIdSchema,
  agentStartSchema,
  assetImportSchema,
  canvasEditSchema,
  canvasGenerationSchema,
  generationAssetSchema,
  generationEnqueueSchema,
  generationProfileEnqueueSchema,
  generationResultFavoriteInputSchema,
  generationJobIdSchema,
  generationRetrySchema,
  placeGenerationResultInputSchema,
  providerConnectionTestSchema,
  providerSecretDeleteSchema,
  providerConfigSetSchema,
  providerExecutionPolicySetSchema,
  providerSecretSetSchema,
  projectCreateSchema,
  projectFavoriteSchema,
  projectIdSchema,
  projectLibraryChangeSchema,
  runtimeInfoSchema,
  sceneExecuteSchema,
  designDirectionSelectSchema,
  designReviewAcceptSchema,
  diagnosticExportSchema,
  sceneHistorySchema
} from './contracts'

let subscribedRuntime: Promise<GenerationRuntime> | null = null
let unsubscribeScene: (() => void) | null = null
let unsubscribeAgent: (() => void) | null = null
let subscribedAppearance: AppearanceSettingsService | null = null
let unsubscribeAppearance: (() => void) | null = null

function ensureAppearanceBroadcast(service: AppearanceSettingsService): void {
  if (subscribedAppearance === service) return
  unsubscribeAppearance?.()
  subscribedAppearance = service
  unsubscribeAppearance = service.subscribe((snapshot) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(DESKTOP_EVENTS.appearanceChanged, snapshot)
    }
  })
}

function ensureSceneBroadcast(generationRuntime: Promise<GenerationRuntime>): void {
  if (subscribedRuntime === generationRuntime) return
  unsubscribeScene?.()
  unsubscribeAgent?.()
  unsubscribeScene = null
  unsubscribeAgent = null
  subscribedRuntime = generationRuntime
  void generationRuntime.then((runtime) => {
    if (subscribedRuntime !== generationRuntime) return
    unsubscribeScene = runtime.subscribeScene((event) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send(DESKTOP_EVENTS.sceneChanged, event)
      }
    })
    unsubscribeAgent = runtime.subscribeAgent((event) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send(DESKTOP_EVENTS.agentEvent, event)
      }
    })
  })
}

async function createRuntimeInfo(
  backgroundMaterial: RuntimeInfo['backgroundMaterial'],
  generationRuntime: Promise<GenerationRuntime>
): Promise<RuntimeInfo> {
  return runtimeInfoSchema.parse({
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron,
    platform: process.platform,
    systemTheme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
    backgroundMaterial,
    startupRoute: process.env.AI_CANVAS_STARTUP === 'library' || process.env.AI_CANVAS_E2E !== '1' ? 'library' : 'workspace',
    projectLibraryPath: (await generationRuntime).getProjectLibraryDirectory(),
    nativeModules: await inspectNativeModules()
  })
}

export function registerDesktopIpc(
  backgroundMaterial: RuntimeInfo['backgroundMaterial'],
  generationRuntime: Promise<GenerationRuntime>,
  appearanceSettings: AppearanceSettingsService
): void {
  ensureSceneBroadcast(generationRuntime)
  ensureAppearanceBroadcast(appearanceSettings)
  for (const channel of Object.values(DESKTOP_CHANNELS)) ipcMain.removeHandler(channel)
  ipcMain.handle(DESKTOP_CHANNELS.runtimeInfo, async (): Promise<RuntimeInfo> => createRuntimeInfo(backgroundMaterial, generationRuntime))
  ipcMain.handle(DESKTOP_CHANNELS.appearanceSettings, async () => appearanceSettings.snapshot())
  ipcMain.handle(DESKTOP_CHANNELS.appearanceSettingsSet, async (_event, input: unknown) => {
    return appearanceSettings.update(appearanceSettingsSetSchema.parse(input))
  })
  ipcMain.handle(DESKTOP_CHANNELS.diagnosticExport, async (event, input: unknown) => {
    diagnosticExportSchema.parse(input)
    const owner = BrowserWindow.fromWebContents(event.sender)
    const defaultName = `AI-Canvas-diagnostics-${new Date().toISOString().slice(0, 10)}.json`
    let filePath = process.env.AI_CANVAS_E2E === '1'
      ? process.env.AI_CANVAS_E2E_DIAGNOSTIC_EXPORT_PATH
      : undefined
    if (filePath === undefined || filePath === '') {
      const options = {
        title: '保存脱敏诊断包',
        defaultPath: defaultName,
        buttonLabel: '保存诊断包',
        filters: [{ name: 'AI Canvas Diagnostic', extensions: ['json'] }]
      }
      const result = owner === null ? await dialog.showSaveDialog(options) : await dialog.showSaveDialog(owner, options)
      if (result.canceled || result.filePath === '') {
        return diagnosticExportResultSchema.parse({
          status: 'cancelled', fileName: null, correlationId: null, message: '已取消；没有创建诊断包。'
        })
      }
      filePath = result.filePath
    }
    const destinationPath = extname(filePath).toLowerCase() === '.json' ? filePath : `${filePath}.json`
    const info = await createRuntimeInfo(backgroundMaterial, generationRuntime)
    return (await generationRuntime).exportDiagnosticPackage(destinationPath, {
      appVersion: info.appVersion,
      electronVersion: info.electronVersion,
      platform: info.platform,
      nativeModules: info.nativeModules
    }, await appearanceSettings.snapshot())
  })
  ipcMain.handle(DESKTOP_CHANNELS.generationProviders, async () => (await generationRuntime).listProviders())
  ipcMain.handle(DESKTOP_CHANNELS.generationProfiles, async () => (await generationRuntime).listProfiles())
  ipcMain.handle(DESKTOP_CHANNELS.generationJobs, async () => (await generationRuntime).listJobs())
  ipcMain.handle(DESKTOP_CHANNELS.generationEnqueue, async (_event, input: unknown) => {
    return (await generationRuntime).enqueue(generationEnqueueSchema.parse(input))
  })
  ipcMain.handle(DESKTOP_CHANNELS.generationProfileEnqueue, async (_event, input: unknown) => {
    return (await generationRuntime).enqueueProfile(generationProfileEnqueueSchema.parse(input))
  })
  ipcMain.handle(DESKTOP_CHANNELS.generationReferencePreview, async (_event, input: unknown) => {
    return (await generationRuntime).previewGenerationReference(generationReferencePreviewInputSchema.parse(input))
  })
  ipcMain.handle(DESKTOP_CHANNELS.generationCancel, async (_event, input: unknown) => {
    return (await generationRuntime).cancel(generationJobIdSchema.parse(input))
  })
  ipcMain.handle(DESKTOP_CHANNELS.generationRetry, async (_event, input: unknown) => {
    const parsed = generationRetrySchema.parse(input)
    const overrides = {
      ...(parsed.overrides.providerId === undefined ? {} : { providerId: parsed.overrides.providerId }),
      ...(parsed.overrides.model === undefined ? {} : { model: parsed.overrides.model })
    }
    return (await generationRuntime).retry(parsed.jobId, overrides)
  })
  ipcMain.handle(DESKTOP_CHANNELS.generationResultFamilies, async () => {
    return (await generationRuntime).resultFamilies()
  })
  ipcMain.handle(DESKTOP_CHANNELS.generationResultFavorite, async (_event, input: unknown) => {
    return (await generationRuntime).setGenerationResultFavorite(generationResultFavoriteInputSchema.parse(input))
  })
  ipcMain.handle(DESKTOP_CHANNELS.generationResultPlace, async (_event, input: unknown) => {
    return (await generationRuntime).placeGenerationResult(placeGenerationResultInputSchema.parse(input))
  })
  ipcMain.handle(DESKTOP_CHANNELS.generationAsset, async (_event, input: unknown) => {
    const parsed = generationAssetSchema.parse(input)
    return (await generationRuntime).readAssetDataUrl(parsed.assetId, parsed.thumbnail, parsed.projectId)
  })
  ipcMain.handle(DESKTOP_CHANNELS.canvasGeneration, async (_event, input: unknown) => {
    return (await generationRuntime).generateFromCanvas(canvasGenerationSchema.parse(input))
  })
  ipcMain.handle(DESKTOP_CHANNELS.canvasEdit, async (_event, input: unknown) => {
    return (await generationRuntime).editFromCanvas(canvasEditSchema.parse(input))
  })
  ipcMain.handle(DESKTOP_CHANNELS.providerSettings, async () => (await generationRuntime).getProviderSettings())
  ipcMain.handle(DESKTOP_CHANNELS.providerConnectionTest, async (_event, input: unknown) => {
    return (await generationRuntime).validateProviderConnection(providerConnectionTestSchema.parse(input))
  })
  ipcMain.handle(DESKTOP_CHANNELS.providerConfigSet, async (_event, input: unknown) => {
    return (await generationRuntime).setProviderConfig(providerConfigSetSchema.parse(input))
  })
  ipcMain.handle(DESKTOP_CHANNELS.providerExecutionPolicySet, async (_event, input: unknown) => {
    return (await generationRuntime).setProviderExecutionPolicy(providerExecutionPolicySetSchema.parse(input))
  })
  ipcMain.handle(DESKTOP_CHANNELS.providerSecretSet, async (_event, input: unknown) => {
    return (await generationRuntime).setProviderSecret(providerSecretSetSchema.parse(input))
  })
  ipcMain.handle(DESKTOP_CHANNELS.providerSecretDelete, async (_event, input: unknown) => {
    return (await generationRuntime).deleteProviderSecret(providerSecretDeleteSchema.parse(input))
  })
  ipcMain.handle(DESKTOP_CHANNELS.projectRecent, async () => (await generationRuntime).listRecentProjects())
  ipcMain.handle(DESKTOP_CHANNELS.projectCreate, async (event, input: unknown) => {
    const parsed = projectCreateSchema.parse(input)
    if (process.env.AI_CANVAS_E2E !== '1') {
      return { cancelled: false, bootstrap: await (await generationRuntime).createProjectInLibrary(parsed.suggestedName) }
    }
    const owner = BrowserWindow.fromWebContents(event.sender)
    const options = {
      title: '新建 AI Canvas 项目',
      defaultPath: `${parsed.suggestedName}.aicanvas`,
      buttonLabel: '创建项目',
      filters: [{ name: 'AI Canvas Project', extensions: ['aicanvas'] }]
    }
    const result = owner === null ? await dialog.showSaveDialog(options) : await dialog.showSaveDialog(owner, options)
    if (result.canceled || result.filePath === '') return { cancelled: true, bootstrap: null }
    const directory = extname(result.filePath).toLowerCase() === '.aicanvas' ? result.filePath : `${result.filePath}.aicanvas`
    const name = basename(directory, '.aicanvas')
    return { cancelled: false, bootstrap: await (await generationRuntime).createProject(directory, name) }
  })
  ipcMain.handle(DESKTOP_CHANNELS.projectOpen, async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender)
    const options = { title: '打开 AI Canvas 项目', buttonLabel: '打开项目', properties: ['openDirectory'] as Array<'openDirectory'> }
    const result = owner === null ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(owner, options)
    const directory = result.filePaths[0]
    if (result.canceled || directory === undefined) return { cancelled: true, bootstrap: null }
    return { cancelled: false, bootstrap: await (await generationRuntime).openProject(directory) }
  })
  ipcMain.handle(DESKTOP_CHANNELS.projectOpenRecent, async (_event, input: unknown) => {
    return (await generationRuntime).openRecentProject(projectIdSchema.parse(input))
  })
  ipcMain.handle(DESKTOP_CHANNELS.projectRelocateRecent, async (event, input: unknown) => {
    const projectId = projectIdSchema.parse(input)
    const owner = BrowserWindow.fromWebContents(event.sender)
    const options = { title: '重新定位 AI Canvas 项目', buttonLabel: '关联此项目', properties: ['openDirectory'] as Array<'openDirectory'> }
    const result = owner === null ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(owner, options)
    const directory = result.filePaths[0]
    if (result.canceled || directory === undefined) return { cancelled: true, bootstrap: null }
    return { cancelled: false, bootstrap: await (await generationRuntime).relocateRecentProject(projectId, directory) }
  })
  ipcMain.handle(DESKTOP_CHANNELS.projectDeleteRecent, async (_event, input: unknown) => {
    return (await generationRuntime).deleteRecentProject(
      projectIdSchema.parse(input),
      (targetPath) => shell.trashItem(targetPath)
    )
  })
  ipcMain.handle(DESKTOP_CHANNELS.projectFavoriteSet, async (_event, input: unknown) => {
    const parsed = projectFavoriteSchema.parse(input)
    return (await generationRuntime).setProjectFavorite(parsed.projectId, parsed.favorite)
  })
  ipcMain.handle(DESKTOP_CHANNELS.projectLibraryChange, async (event, input: unknown) => {
    const mode = projectLibraryChangeSchema.parse(input)
    const owner = BrowserWindow.fromWebContents(event.sender)
    const options = {
      title: mode === 'migrate' ? '迁移项目库到新位置' : '选择以后新项目的位置',
      buttonLabel: mode === 'migrate' ? '复制并校验' : '使用此位置',
      properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>
    }
    const result = owner === null ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(owner, options)
    const directory = result.filePaths[0]
    if (result.canceled || directory === undefined) {
      return { cancelled: true, settings: await (await generationRuntime).getProjectLibrarySettings(), migration: null }
    }
    return (await generationRuntime).changeProjectLibraryLocation(directory, mode)
  })
  ipcMain.handle(DESKTOP_CHANNELS.projectSaveAs, async (event, input: unknown) => {
    const parsed = projectCreateSchema.parse(input)
    const owner = BrowserWindow.fromWebContents(event.sender)
    const options = {
      title: '项目另存为',
      defaultPath: `${parsed.suggestedName}.aicanvas`,
      buttonLabel: '另存项目',
      filters: [{ name: 'AI Canvas Project', extensions: ['aicanvas'] }]
    }
    const result = owner === null ? await dialog.showSaveDialog(options) : await dialog.showSaveDialog(owner, options)
    if (result.canceled || result.filePath === '') return { cancelled: true, bootstrap: null }
    const directory = extname(result.filePath).toLowerCase() === '.aicanvas' ? result.filePath : `${result.filePath}.aicanvas`
    return { cancelled: false, bootstrap: await (await generationRuntime).saveProjectAs(directory) }
  })
  ipcMain.handle(DESKTOP_CHANNELS.assetImport, async (_event, input: unknown) => {
    return (await generationRuntime).importAsset(assetImportSchema.parse(input))
  })
  ipcMain.handle(DESKTOP_CHANNELS.workspaceBootstrap, async () => (await generationRuntime).getWorkspaceBootstrap())
  ipcMain.handle(DESKTOP_CHANNELS.projectWorkContextSave, async (_event, input: unknown) => {
    (await generationRuntime).saveProjectWorkContext(projectWorkContextSchema.parse(input))
  })
  ipcMain.handle(DESKTOP_CHANNELS.sceneExecute, async (_event, input: unknown) => {
    return (await generationRuntime).executeSceneCommands(sceneExecuteSchema.parse(input))
  })
  ipcMain.handle(DESKTOP_CHANNELS.sceneUndo, async (_event, input: unknown) => {
    return (await generationRuntime).undoScene(sceneHistorySchema.parse(input))
  })
  ipcMain.handle(DESKTOP_CHANNELS.sceneRedo, async (_event, input: unknown) => {
    return (await generationRuntime).redoScene(sceneHistorySchema.parse(input))
  })
  ipcMain.handle(DESKTOP_CHANNELS.designDirectionSelect, async (_event, input: unknown) => {
    return (await generationRuntime).selectDesignDirection(designDirectionSelectSchema.parse(input))
  })
  ipcMain.handle(DESKTOP_CHANNELS.conversationSnapshot, async () => (await generationRuntime).getConversation())
  ipcMain.handle(DESKTOP_CHANNELS.designReviewAccept, async (_event, input: unknown) => (await generationRuntime).acceptDesignReview(designReviewAcceptSchema.parse(input)))
  ipcMain.handle(DESKTOP_CHANNELS.agentHarnessSnapshot, async () => (await generationRuntime).getAgentHarnessSnapshot())
  ipcMain.handle(DESKTOP_CHANNELS.agentKnowledge, async () => (await generationRuntime).getProjectKnowledge())
  ipcMain.handle(DESKTOP_CHANNELS.agentDirectiveCreate, async (_event, input: unknown) => {
    return (await generationRuntime).createProjectDirective(agentDirectiveCreateSchema.parse(input))
  })
  ipcMain.handle(DESKTOP_CHANNELS.agentDirectiveUpdate, async (_event, input: unknown) => {
    return (await generationRuntime).updateProjectDirective(agentDirectiveUpdateSchema.parse(input))
  })
  ipcMain.handle(DESKTOP_CHANNELS.agentMemoryCreate, async (_event, input: unknown) => {
    return (await generationRuntime).createProjectMemory(agentMemoryCreateSchema.parse(input))
  })
  ipcMain.handle(DESKTOP_CHANNELS.agentMemoryUpdate, async (_event, input: unknown) => {
    return (await generationRuntime).updateProjectMemory(agentMemoryUpdateSchema.parse(input))
  })
  ipcMain.handle(DESKTOP_CHANNELS.agentMemoryCandidateCreate, async (_event, input: unknown) => {
    return (await generationRuntime).createMemoryCandidate(agentMemoryCandidateCreateSchema.parse(input))
  })
  ipcMain.handle(DESKTOP_CHANNELS.agentMemoryCandidateResolve, async (_event, input: unknown) => {
    return (await generationRuntime).resolveMemoryCandidate(agentMemoryCandidateResolveSchema.parse(input))
  })
  ipcMain.handle(DESKTOP_CHANNELS.agentOutboundPolicySet, async (_event, input: unknown) => {
    return (await generationRuntime).setOutboundPolicy(agentOutboundPolicySetSchema.parse(input))
  })
  ipcMain.handle(DESKTOP_CHANNELS.agentEventReplay, async (_event, input: unknown) => {
    const parsed = agentEventReplaySchema.parse(input)
    return (await generationRuntime).replayAgentEvents(parsed.afterSequence, parsed.limit)
  })
  ipcMain.handle(DESKTOP_CHANNELS.agentStart, async (_event, input: unknown) => {
    const parsed = agentStartSchema.parse(input)
    return (await generationRuntime).startAgentRun(parsed.request, parsed.mode, parsed.taskRelation)
  })
  ipcMain.handle(DESKTOP_CHANNELS.agentInput, async (_event, input: unknown) => {
    const parsed = agentInputSchema.parse(input)
    return 'mode' in parsed
      ? (await generationRuntime).inputAgentRun(parsed.request, parsed.mode)
      : (await generationRuntime).inputAgentRun(parsed.request, {
          taskRelation: parsed.taskRelation,
          dispatchMode: parsed.dispatchMode
        })
  })
  ipcMain.handle(DESKTOP_CHANNELS.agentTemporaryResolve, async (_event, input: unknown) => {
    const parsed = agentTemporaryResolveSchema.parse(input)
    return (await generationRuntime).resolveTemporaryAgentTurn(parsed.turnId, parsed.resolution)
  })
  ipcMain.handle(DESKTOP_CHANNELS.agentQueueResume, async () => (await generationRuntime).resumeAgentQueue())
  ipcMain.handle(DESKTOP_CHANNELS.agentConfirm, async (_event, input: unknown) => {
    const parsed = agentDecisionResolveSchema.parse(input)
    return (await generationRuntime).confirmAgentRun(parsed.runId, parsed.optionId)
  })
  ipcMain.handle(DESKTOP_CHANNELS.agentCancel, async (_event, input: unknown) => {
    return (await generationRuntime).cancelAgentRun(agentRunIdSchema.parse(input))
  })
  ipcMain.handle(DESKTOP_CHANNELS.activityBatchUndone, async (_event, input: unknown) => {
    return (await generationRuntime).markActivityBatchUndone(activityBatchIdSchema.parse(input))
  })
}
