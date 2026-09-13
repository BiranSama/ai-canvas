import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { GenerateView } from '../../src/renderer/src/components/GenerateView'
import { useWorkspaceStore } from '../../src/renderer/src/store/workspace-store'
import { useGenerationDraftStore } from '../../src/renderer/src/store/generation-draft-store'
import { generationRequestSchema, type GenerationJob } from '../../src/shared/generation'

it('retries a stored real request without replacing its identity with the current draft model', async () => {
  const projectId = useWorkspaceStore.getState().scene.projectId
  const job: GenerationJob = {
    id: 'request-a', projectId, providerId: 'image-provider', model: 'model-a',
    request: generationRequestSchema.parse({ providerId: 'image-provider', model: 'model-a', prompt: '原作品', aspectWidth: 4, aspectHeight: 5, outputWidth: 1024, outputHeight: 1280 }),
    status: 'cancelled', stage: 'cancelled', submissionState: 'not_sent', externalTaskId: null,
    attempt: 1, parentJobId: null, sourceMessageId: null, cancelRequested: true, error: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), startedAt: null, completedAt: null, results: []
  }
  const retry = vi.fn(async () => job)
  Object.defineProperty(window, 'desktop', { configurable: true, value: {
    listGenerationProviders: async () => [], listGenerationProfiles: async () => ({ profiles: [] }),
    getProviderSettings: async () => ({ providers: [], executionPolicy: { maxCostCnyPerJob: 10 } }), listGenerationJobs: async () => [job],
    listGenerationResultFamilies: async () => [], retryGeneration: retry
  } })
  useGenerationDraftStore.setState({ model: 'model-b', profileSelectionMade: true })
  render(<GenerateView header={null} />)
  fireEvent.click(await screen.findByRole('button', { name: '重试' }))
  await waitFor(() => expect(retry).toHaveBeenCalledWith('request-a', {}))
})
