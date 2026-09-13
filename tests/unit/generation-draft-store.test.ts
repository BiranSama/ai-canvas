import { afterEach, describe, expect, it } from 'vitest'
import { useGenerationDraftStore } from '../../src/renderer/src/store/generation-draft-store'

afterEach(() => {
  useGenerationDraftStore.setState({
    prompt: '', negativePrompt: '低清晰度，杂乱布局，错误文字，过度饱和', ratioInput: '4:5', quantity: 1,
    profileId: 'local-sketch', model: 'mock-balanced', referenceResultId: null,
    referenceMode: 'hybrid', variationInstruction: '', preserveConstraints: '', expandedSections: ['parameters']
  })
})

describe('GenerationDraft single source of truth', () => {
  it('keeps every user-owned generation fact together across view component lifecycles', () => {
    useGenerationDraftStore.getState().updateDraft({
      prompt: 'architectural poster',
      negativePrompt: 'clutter',
      ratioInput: '21:9',
      quantity: 4,
      profileId: 'mock-draft',
      model: 'mock-slow',
      referenceResultId: 'result-1',
      referenceMode: 'structure',
      variationInstruction: '只改变光线方向',
      preserveConstraints: '保持主体身份与画面比例',
      expandedSections: ['references']
    })
    expect(useGenerationDraftStore.getState()).toMatchObject({
      prompt: 'architectural poster', negativePrompt: 'clutter', ratioInput: '21:9', quantity: 4,
      profileId: 'mock-draft', model: 'mock-slow', referenceResultId: 'result-1', referenceMode: 'structure',
      variationInstruction: '只改变光线方向', preserveConstraints: '保持主体身份与画面比例', expandedSections: ['references']
    })
  })
})
