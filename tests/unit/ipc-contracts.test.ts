import { describe, expect, it } from 'vitest'
import {
  agentDirectiveUpdateSchema,
  agentInputSchema,
  agentStartSchema,
  agentTemporaryResolveSchema,
  agentMemoryUpdateSchema,
  agentOutboundPolicySetSchema,
  designDirectionSelectSchema,
  diagnosticExportSchema,
  generationResultFavoriteInputSchema,
  placeGenerationResultInputSchema,
  providerConnectionTestSchema,
  providerExecutionPolicySetSchema,
  runtimeInfoSchema
} from '../../src/main/ipc/contracts'
import { DEFAULT_PROVIDER_CONFIG, providerConfigFileSchema } from '../../src/shared/provider-settings'

describe('runtimeInfoSchema', () => {
  it('accepts the narrow desktop runtime response', () => {
    expect(
      runtimeInfoSchema.parse({
        appVersion: '0.1.0',
        electronVersion: '43.3.0',
        platform: 'win32',
        systemTheme: 'light',
        backgroundMaterial: 'mica',
        startupRoute: 'library',
        projectLibraryPath: 'C:\\Users\\Example\\Documents\\AI Canvas',
        nativeModules: {
          betterSqlite3: true,
          sharp: true,
          sqliteVersion: '3.51.2',
          sharpVersion: '0.35.3'
        }
      })
    ).toMatchObject({ platform: 'win32', backgroundMaterial: 'mica', startupRoute: 'library' })
  })

  it('rejects an unexpected renderer capability', () => {
    const parsed = runtimeInfoSchema.safeParse({
      appVersion: '0.1.0',
      electronVersion: '43.3.0',
      platform: 'win32',
      systemTheme: 'light',
      backgroundMaterial: 'mica',
      startupRoute: 'library',
      projectLibraryPath: 'C:\\Users\\Example\\Documents\\AI Canvas',
      nativeModules: {
        betterSqlite3: true,
        sharp: true,
        sqliteVersion: '3.51.2',
        sharpVersion: '0.35.3'
      },
      readFile: true
    })

    expect(parsed.success).toBe(true)
    if (parsed.success) expect('readFile' in parsed.data).toBe(false)
  })
})

describe('Product Provider policy IPC contract', () => {
  it('requires an explicit confirmation for the single LLM connection request', () => {
    expect(providerConnectionTestSchema.parse({
      providerId: 'openai-compatible-llm',
      confirmed: true
    })).toEqual({ providerId: 'openai-compatible-llm', confirmed: true })
    expect(providerConnectionTestSchema.safeParse({
      providerId: 'openai-compatible-llm',
      confirmed: false
    }).success).toBe(false)
    expect(providerConnectionTestSchema.safeParse({
      providerId: 'image-provider',
      confirmed: true
    }).success).toBe(false)
  })

  it('accepts bounded Owner policy and rejects unbounded numeric values', () => {
    expect(providerExecutionPolicySetSchema.parse({
      approvalMode: 'confirm_each',
      autoGenerate: false,
      maxRequestsPerJob: 50,
      maxImagesPerJob: 4,
      maxCostCnyPerJob: 20
    })).toMatchObject({ maxRequestsPerJob: 50, maxImagesPerJob: 4, maxCostCnyPerJob: 20 })
    expect(providerExecutionPolicySetSchema.safeParse({
      approvalMode: 'session',
      autoGenerate: true,
      maxRequestsPerJob: 101,
      maxImagesPerJob: 17,
      maxCostCnyPerJob: -1
    }).success).toBe(false)
    expect(providerExecutionPolicySetSchema.safeParse({
      approvalMode: 'session',
      autoGenerate: true,
      maxRequestsPerJob: 10,
      maxImagesPerJob: 4,
      maxCostCnyPerJob: 20,
      unlimitedSpend: true
    }).success).toBe(false)
  })

  it('migrates the short-lived unlimited flag to the configured finite ceiling', () => {
    const parsed = providerConfigFileSchema.parse({
      ...structuredClone(DEFAULT_PROVIDER_CONFIG),
      executionPolicy: {
        ...structuredClone(DEFAULT_PROVIDER_CONFIG.executionPolicy),
        unlimitedSpend: true
      }
    })
    expect(parsed.executionPolicy).toEqual(DEFAULT_PROVIDER_CONFIG.executionPolicy)
    expect(parsed.executionPolicy).not.toHaveProperty('unlimitedSpend')
  })
})

describe('Product diagnostic export IPC contract', () => {
  it('accepts only an empty request so Renderer cannot choose source or destination paths', () => {
    expect(diagnosticExportSchema.parse({})).toEqual({})
    expect(diagnosticExportSchema.safeParse({
      sourcePath: 'C:\\private\\diagnostic.jsonl',
      destinationPath: 'C:\\private\\package.json'
    }).success).toBe(false)
  })
})

describe('AH1 S5 narrow IPC contracts', () => {
  it('requires expectedVersion for project knowledge writes', () => {
    expect(agentDirectiveUpdateSchema.safeParse({
      id: '00000000-0000-4000-8000-000000000001', enabled: false
    }).success).toBe(false)
    expect(agentMemoryUpdateSchema.safeParse({
      id: '00000000-0000-4000-8000-000000000002', expectedVersion: 2, status: 'deleted'
    }).success).toBe(true)
  })

  it('accepts only the four explicit outbound policies', () => {
    expect(agentOutboundPolicySetSchema.parse({ policy: 'local_only', expectedVersion: 1 })).toEqual({
      policy: 'local_only', expectedVersion: 1
    })
    expect(agentOutboundPolicySetSchema.safeParse({ policy: 'send_everything', expectedVersion: 1 }).success).toBe(false)
  })
})

describe('AH1 S7 generation result IPC contracts', () => {
  const resultId = '00000000-0000-4000-8000-000000000101'
  const placementId = '00000000-0000-4000-8000-000000000102'

  it('accepts only a narrow favorite mutation and strips no hidden authority fields', () => {
    expect(generationResultFavoriteInputSchema.parse({ resultId, favorite: true })).toEqual({ resultId, favorite: true })
    expect(generationResultFavoriteInputSchema.safeParse({ resultId: 'result-1', favorite: true }).success).toBe(false)
  })

  it('requires a stable placement id and only accepts user or agent origin', () => {
    expect(placeGenerationResultInputSchema.parse({ resultId, placementId })).toEqual({
      resultId,
      placementId,
      origin: 'user'
    })
    expect(placeGenerationResultInputSchema.safeParse({ resultId, placementId, origin: 'renderer' }).success).toBe(false)
    expect(placeGenerationResultInputSchema.safeParse({ resultId, origin: 'user' }).success).toBe(false)
  })
})

describe('AH1 S8 Agent mode start contract', () => {
  const request = {
    text: '先评审当前构图，不要改画布。',
    sceneSummary: {
      revision: 1,
      canvas: { aspectWidth: 4, aspectHeight: 5, outputWidth: 1024, outputHeight: 1280, backgroundColor: '#f4f3f0', globalStyle: '' },
      elementCount: 0,
      elements: []
    },
    selectedIds: [],
    selectedElements: [],
    attachments: [],
    ephemeralAnnotation: null,
    autoGenerate: false,
    activeGenerationJobId: null
  }

  it('defaults new turns to collaboration and rejects invented modes', () => {
    expect(agentStartSchema.parse({ request })).toMatchObject({ mode: 'collaboration' })
    expect(agentStartSchema.parse({ request, mode: 'review', taskRelation: 'new_task' })).toMatchObject({ mode: 'review', taskRelation: 'new_task' })
    expect(agentStartSchema.safeParse({ request, mode: 'unbounded' }).success).toBe(false)
  })

  it('accepts both legacy input and explicit task semantics while keeping interrupt relation-free', () => {
    expect(agentInputSchema.parse({ request, mode: 'append_current' })).toMatchObject({ mode: 'append_current' })
    expect(agentInputSchema.parse({
      request, taskRelation: 'new_task', dispatchMode: 'queue_after_current'
    })).toMatchObject({ taskRelation: 'new_task', dispatchMode: 'queue_after_current' })
    expect(agentInputSchema.safeParse({
      request, taskRelation: 'continue_current', dispatchMode: 'interrupt_current'
    }).success).toBe(false)
    expect(agentTemporaryResolveSchema.parse({
      turnId: '00000000-0000-4000-8000-000000000999', resolution: 'reject'
    })).toMatchObject({ resolution: 'reject' })
  })
})

describe('Product 1.0 C-S1 direction selection IPC contract', () => {
  const input = {
    sourceRunId: '73000000-0000-4000-8000-000000000001',
    briefId: '73000000-0000-4000-8000-000000000002',
    directionId: '73000000-0000-4000-8000-000000000003',
    expectedSceneRevision: 4
  }

  it('accepts only stable identities, a revision and the two explicit resolutions', () => {
    expect(designDirectionSelectSchema.parse(input)).toEqual({ ...input, resolution: 'strict' })
    expect(designDirectionSelectSchema.parse({ ...input, resolution: 'replace_agent_structure' })).toMatchObject({
      resolution: 'replace_agent_structure'
    })
    expect(designDirectionSelectSchema.safeParse({ ...input, resolution: 'force_everything' }).success).toBe(false)
  })

  it('strips Renderer attempts to inject a plan or arbitrary endpoint', () => {
    const parsed = designDirectionSelectSchema.parse({
      ...input,
      scenePlan: { elements: [] },
      baseUrl: 'https://example.invalid'
    })
    expect(parsed).not.toHaveProperty('scenePlan')
    expect(parsed).not.toHaveProperty('baseUrl')
  })
})
