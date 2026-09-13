import { describe, expect, it } from 'vitest'
import { generationDraftSchema, generationRequestSchema } from '../../src/shared/generation'
import { generationResultFamilyMemberSchema } from '../../src/shared/generation-workflow'

describe('creative continuity backward-compatible contracts', () => {
  it('upgrades a pre-continuity generation request to the safe hybrid defaults', () => {
    const request = generationRequestSchema.parse({
      prompt: 'quiet botanical poster',
      negativePrompt: '',
      aspectWidth: 4,
      aspectHeight: 5,
      outputWidth: 1024,
      outputHeight: 1280,
      count: 1,
      providerId: 'mock',
      model: 'mock-balanced',
      references: [],
      parameters: {},
      sourceMessageId: null,
      parentResultId: null
    })

    expect(request).toMatchObject({
      referenceMode: 'hybrid',
      variationInstruction: '',
      preserveConstraints: ''
    })
  })

  it('upgrades old drafts and result metadata without losing their original facts', () => {
    const draft = generationDraftSchema.parse({
      prompt: 'quiet botanical poster',
      negativePrompt: '',
      aspect: { width: 4, height: 5 },
      quantity: 1,
      profileId: 'local-sketch',
      referenceResultIds: [],
      sourceSceneRevision: 3,
      expandedSections: ['parameters']
    })
    const member = generationResultFamilyMemberSchema.parse({
      resultId: '00000000-0000-4000-8000-000000000001',
      jobId: 'job-1',
      assetId: '00000000-0000-4000-8000-000000000002',
      parentResultId: null,
      rootResultId: '00000000-0000-4000-8000-000000000001',
      variantIndex: 0,
      favorite: false,
      profileId: 'local-sketch',
      operation: 'text',
      sourceSceneRevision: 3,
      promptPackageHash: null,
      providerId: 'mock',
      model: 'mock-balanced',
      actualCostCny: 0,
      createdAt: '2026-08-28T12:00:00.000+08:00'
    })

    expect(draft).toMatchObject({ prompt: 'quiet botanical poster', referenceMode: 'hybrid', variationInstruction: '', preserveConstraints: '' })
    expect(member).toMatchObject({
      sourceSceneRevision: 3,
      sourceBriefId: null,
      sourceDirectionId: null,
      referenceMode: 'hybrid',
      variationInstruction: '',
      preserveConstraints: ''
    })
  })
})
