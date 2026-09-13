import { z } from 'zod'
import { appearanceSettingsUpdateSchema } from '../../shared/appearance-settings'
export {
  generationResultFavoriteInputSchema,
  placeGenerationResultInputSchema
} from '../../shared/generation-workflow'
import { agentEventReplayInputSchema, agentStartInputSchema, agentTaskInputSchema, agentTurnInputSchema, temporaryTryResolutionSchema } from '../../shared/agent-harness'
import {
  createMemoryCandidateInputSchema,
  createProjectDirectiveInputSchema,
  createProjectMemoryInputSchema,
  resolveMemoryCandidateInputSchema,
  setOutboundPolicyInputSchema,
  updateProjectDirectiveInputSchema,
  updateProjectMemoryInputSchema
} from '../../shared/agent-context'
import { generationProfileRequestSchema, generationRequestSchema } from '../../shared/generation'
import { canvasGenerationInputSchema } from '../../shared/reference'
import { canvasEditInputSchema } from '../../shared/edit'
import {
  configurableProviderIdSchema,
  providerConnectionTestInputSchema,
  providerExecutionPolicySchema,
  providerPublicConfigSchema,
  providerSecretInputSchema
} from '../../shared/provider-settings'
import {
  assetImportInputSchema,
  projectCreateInputSchema,
  projectFavoriteInputSchema,
  projectIdInputSchema,
  projectLibraryChangeModeSchema
} from '../../shared/project'
import { sceneExecuteInputSchema, sceneHistoryInputSchema } from '../../shared/scene-authority'
import { designDirectionSelectionInputSchema } from '../../shared/design-direction-selection'
import { acceptDesignReviewInputSchema } from '../../shared/design-capability'
import { diagnosticExportInputSchema } from '../../shared/diagnostics'

export const nativeModuleHealthSchema = z.object({
  betterSqlite3: z.boolean(),
  sharp: z.boolean(),
  sqliteVersion: z.string().nullable(),
  sharpVersion: z.string().nullable()
})

export const runtimeInfoSchema = z.object({
  appVersion: z.string().min(1),
  electronVersion: z.string().min(1),
  platform: z.enum(['aix', 'darwin', 'freebsd', 'linux', 'openbsd', 'sunos', 'win32', 'android', 'haiku', 'cygwin', 'netbsd']),
  systemTheme: z.enum(['light', 'dark']),
  backgroundMaterial: z.enum(['mica', 'solid']),
  startupRoute: z.enum(['library', 'workspace']),
  projectLibraryPath: z.string().min(1),
  nativeModules: nativeModuleHealthSchema
})

export const appearanceSettingsSetSchema = appearanceSettingsUpdateSchema
export const diagnosticExportSchema = diagnosticExportInputSchema

export const generationJobIdSchema = z.string().min(1).max(200)
export const generationEnqueueSchema = generationRequestSchema
export const generationProfileEnqueueSchema = generationProfileRequestSchema
export const generationRetrySchema = z.object({
  jobId: generationJobIdSchema,
  overrides: z.object({
    providerId: z.string().min(1).max(200).optional(),
    model: z.string().min(1).max(200).optional()
  }).default({})
})

export const generationAssetSchema = z.object({
  projectId: z.string().uuid().optional(),
  assetId: z.string().min(1).max(200),
  thumbnail: z.boolean().default(true)
})
export const canvasGenerationSchema = canvasGenerationInputSchema
export const canvasEditSchema = canvasEditInputSchema
export const providerSecretSetSchema = providerSecretInputSchema
export const providerConnectionTestSchema = providerConnectionTestInputSchema
export const providerConfigSetSchema = providerPublicConfigSchema
export const providerExecutionPolicySetSchema = providerExecutionPolicySchema
export const providerSecretDeleteSchema = configurableProviderIdSchema
export const projectCreateSchema = projectCreateInputSchema
export const projectIdSchema = projectIdInputSchema
export const projectFavoriteSchema = projectFavoriteInputSchema
export const projectLibraryChangeSchema = projectLibraryChangeModeSchema
export const assetImportSchema = assetImportInputSchema

export const sceneExecuteSchema = sceneExecuteInputSchema
export const sceneHistorySchema = sceneHistoryInputSchema
export const designDirectionSelectSchema = designDirectionSelectionInputSchema
export const designReviewAcceptSchema = acceptDesignReviewInputSchema

export const agentStartSchema = agentStartInputSchema
export const agentInputSchema = z.union([agentTurnInputSchema, agentTaskInputSchema])
export const agentTemporaryResolveSchema = temporaryTryResolutionSchema
export const agentEventReplaySchema = agentEventReplayInputSchema
export const agentDirectiveCreateSchema = createProjectDirectiveInputSchema
export const agentDirectiveUpdateSchema = updateProjectDirectiveInputSchema
export const agentMemoryCreateSchema = createProjectMemoryInputSchema
export const agentMemoryUpdateSchema = updateProjectMemoryInputSchema
export const agentMemoryCandidateCreateSchema = createMemoryCandidateInputSchema
export const agentMemoryCandidateResolveSchema = resolveMemoryCandidateInputSchema
export const agentOutboundPolicySetSchema = setOutboundPolicyInputSchema
export const agentRunIdSchema = z.string().uuid()
export const agentDecisionResolveSchema = z.object({
  runId: z.string().uuid(),
  optionId: z.string().trim().min(1).max(80).optional()
})
export const activityBatchIdSchema = z.string().uuid()
