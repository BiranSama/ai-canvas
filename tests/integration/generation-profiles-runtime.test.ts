import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GenerationRuntime } from '../../src/main/generation/generation-runtime'
import type { GenerationJob, GenerationProfileRequest } from '../../src/shared/generation'

const roots: string[] = []

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop()
    if (root !== undefined) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

async function waitForTerminal(runtime: GenerationRuntime, jobId: string): Promise<GenerationJob> {
  const deadline = Date.now() + 6_000
  while (Date.now() < deadline) {
    const job = (await runtime.listJobs()).find((candidate) => candidate.id === jobId)
    if (job !== undefined && ['completed', 'failed', 'cancelled', 'timed_out', 'interrupted'].includes(job.status)) return job
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('Profile job did not reach a terminal state.')
}

async function waitForActive(runtime: GenerationRuntime, jobId: string): Promise<GenerationJob> {
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    const job = (await runtime.listJobs()).find((candidate) => candidate.id === jobId)
    if (job !== undefined && ['preparing', 'generating', 'downloading'].includes(job.status)) return job
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('Profile job did not become active.')
}

function profileRequest(profileId: string, quantity: number, modelOverride: string | null = null, confirmed = false): GenerationProfileRequest {
  return {
    profileId,
    confirmed,
    operation: 'generate',
    draft: {
      prompt: 'A restrained paper and botanical study', negativePrompt: 'neon, clutter', aspect: { width: 4, height: 5 },
      quantity,
      profileId,
      referenceResultIds: [],
      sourceSceneRevision: 0,
      referenceMode: 'hybrid',
      variationInstruction: '',
      preserveConstraints: '',
      expandedSections: []
    },
    outputWidth: 320,
    outputHeight: 400,
    references: [],
    parameters: {},
    sourceMessageId: null,
    parentResultId: null,
    modelOverride
  }
}

describe('Generation Studio profile runtime', () => {
  it('persists draft/final profile provenance, simulated estimates, exact results and zero actual cost', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ai-canvas-profiles-'))
    roots.push(root)
    const runtime = await GenerationRuntime.create(root)
    expect(runtime.listProfiles().profiles).toHaveLength(6)

    const draft = await waitForTerminal(runtime, (await runtime.enqueueProfile(profileRequest('mock-draft', 4))).id)
    expect(draft).toMatchObject({ status: 'completed', providerId: 'mock', model: 'mock-balanced' })
    expect(draft.results).toHaveLength(4)
    expect(draft.request.parameters).toMatchObject({ generationProfileId: 'mock-draft', simulatedEstimatedCostCny: .16, actualCostCny: 0 })

    const final = await waitForTerminal(runtime, (await runtime.enqueueProfile(profileRequest('mock-final', 2, null, true))).id)
    expect(final.results).toHaveLength(2)
    expect(final.request.parameters).toMatchObject({ generationProfileId: 'mock-final', simulatedEstimatedCostCny: .44, actualCostCny: 0 })
    await runtime.close()
  })

  it('keeps source facts through failure, retry and cancellation while obsolete locked profiles stay absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ai-canvas-profile-recovery-'))
    roots.push(root)
    const runtime = await GenerationRuntime.create(root)
    await expect(runtime.enqueueProfile(profileRequest('real-final', 1, null, true))).rejects.toThrowError(expect.objectContaining({ code: 'PROFILE_NOT_FOUND' }))
    expect(await runtime.listJobs()).toHaveLength(0)

    const failed = await waitForTerminal(runtime, (await runtime.enqueueProfile(profileRequest('local-sketch', 1, 'mock-failure'))).id)
    expect(failed).toMatchObject({ status: 'failed', error: { code: 'MOCK_PROVIDER_FAILURE' } })
    await expect(runtime.retry(failed.id, { providerId: 'image-provider' })).rejects.toMatchObject({ code: 'PROFILE_PROVIDER_OVERRIDE_REJECTED' })
    expect(await runtime.listJobs()).toHaveLength(1)
    const retried = await waitForTerminal(runtime, (await runtime.retry(failed.id, { model: 'mock-balanced' })).id)
    expect(retried).toMatchObject({ status: 'completed', parentJobId: failed.id, attempt: 2 })
    expect(retried.request).toMatchObject({ prompt: failed.request.prompt, parameters: { generationProfileId: 'local-sketch', actualCostCny: 0 } })

    const slow = await runtime.enqueueProfile(profileRequest('local-sketch', 1, 'mock-slow'))
    await waitForActive(runtime, slow.id)
    await runtime.cancel(slow.id)
    expect(await waitForTerminal(runtime, slow.id)).toMatchObject({ status: 'cancelled', request: { prompt: slow.request.prompt } })
    await runtime.close()
  })
})
