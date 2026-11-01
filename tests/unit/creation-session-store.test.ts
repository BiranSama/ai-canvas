import { beforeEach, describe, expect, it } from 'vitest'
import { generatesWithoutAsking, useCreationSessionStore } from '../../src/renderer/src/store/creation-session-store'
import { asksBeforeGenerating, DEFAULT_PROVIDER_EXECUTION_POLICY, withAskBeforeGenerating } from '../../src/shared/provider-settings'

describe('creation session store', () => {
  beforeEach(() => {
    useCreationSessionStore.setState({ projectId: null, draft: '', references: [], pendingReferences: 0, askBeforeGenerating: null })
  })

  it('shares a draft across views but clears it when the active project changes', () => {
    useCreationSessionStore.getState().bindProject('project-a')
    useCreationSessionStore.getState().setDraft('把标题放松一点，保留大面积留白')
    expect(useCreationSessionStore.getState().draft).toBe('把标题放松一点，保留大面积留白')

    useCreationSessionStore.getState().bindProject('project-a')
    expect(useCreationSessionStore.getState().draft).toContain('标题')

    useCreationSessionStore.getState().bindProject('project-b')
    expect(useCreationSessionStore.getState()).toMatchObject({ projectId: 'project-b', draft: '' })
  })

  it('keeps attached pictures with the draft across views, and drops them with another project or a sent message', () => {
    const session = useCreationSessionStore.getState()
    session.bindProject('project-a')
    session.beginReference()
    expect(useCreationSessionStore.getState().pendingReferences).toBe(1)
    useCreationSessionStore.getState().finishReference('project-a', { assetId: 'asset-1', name: '参考.png' })
    // Returning to the same project, as a view switch does, keeps them.
    useCreationSessionStore.getState().bindProject('project-a')
    expect(useCreationSessionStore.getState()).toMatchObject({ pendingReferences: 0, references: [{ assetId: 'asset-1', name: '参考.png' }] })
    // A picture that finishes after the project changed is not added to the next one.
    useCreationSessionStore.getState().beginReference()
    useCreationSessionStore.getState().bindProject('project-b')
    useCreationSessionStore.getState().finishReference('project-a', { assetId: 'asset-2', name: '晚到.png' })
    expect(useCreationSessionStore.getState()).toMatchObject({ projectId: 'project-b', references: [], pendingReferences: 0 })
    useCreationSessionStore.getState().beginReference()
    useCreationSessionStore.getState().finishReference('project-b', { assetId: 'asset-3', name: 'b.png' })
    useCreationSessionStore.getState().completeAcceptedTurn()
    expect(useCreationSessionStore.getState().references).toEqual([])
  })

  it('generates without asking only once the person turned 「生图前先问我」 off', () => {
    expect(generatesWithoutAsking()).toBe(false)
    useCreationSessionStore.getState().setAskBeforeGenerating(true)
    expect(generatesWithoutAsking()).toBe(false)
    useCreationSessionStore.getState().setAskBeforeGenerating(false)
    expect(generatesWithoutAsking()).toBe(true)
    // A sent message does not turn the preference back on.
    useCreationSessionStore.getState().completeAcceptedTurn()
    expect(generatesWithoutAsking()).toBe(true)
  })
})

describe('「生图前先问我」 in the execution policy', () => {
  it('reads every saved pair the way it behaved before the switch', () => {
    expect(asksBeforeGenerating(DEFAULT_PROVIDER_EXECUTION_POLICY)).toBe(true)
    expect(asksBeforeGenerating({ approvalMode: 'confirm_each', autoGenerate: true })).toBe(true)
    expect(asksBeforeGenerating({ approvalMode: 'session', autoGenerate: false })).toBe(true)
    expect(asksBeforeGenerating({ approvalMode: 'session', autoGenerate: true })).toBe(false)
  })

  it('writes both fields and keeps the rest', () => {
    const off = withAskBeforeGenerating(DEFAULT_PROVIDER_EXECUTION_POLICY, false)
    expect(off).toEqual({ ...DEFAULT_PROVIDER_EXECUTION_POLICY, approvalMode: 'session', autoGenerate: true })
    expect(asksBeforeGenerating(off)).toBe(false)
    expect(withAskBeforeGenerating(off, true)).toEqual(DEFAULT_PROVIDER_EXECUTION_POLICY)
  })
})
