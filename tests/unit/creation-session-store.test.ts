import { beforeEach, describe, expect, it } from 'vitest'
import { autoGenerationTurnCopy, useCreationSessionStore } from '../../src/renderer/src/store/creation-session-store'

describe('creation session store', () => {
  beforeEach(() => {
    localStorage.clear()
    useCreationSessionStore.setState({
      projectId: null,
      draft: '',
      agentMode: 'collaboration',
      autoGenerateForNextTurn: false,
      providerAutoGeneration: 'unknown'
    })
  })

  it('shares a draft across views but clears it when the active project changes', () => {
    useCreationSessionStore.getState().bindProject('project-a')
    useCreationSessionStore.getState().setDraft('把标题放松一点，保留大面积留白')
    expect(useCreationSessionStore.getState().draft).toBe('把标题放松一点，保留大面积留白')

    useCreationSessionStore.getState().bindProject('project-a')
    expect(useCreationSessionStore.getState().draft).toContain('标题')

    useCreationSessionStore.getState().bindProject('project-b')
    expect(useCreationSessionStore.getState()).toMatchObject({
      projectId: 'project-b',
      draft: '',
      autoGenerateForNextTurn: false
    })
  })

  it('separates the global permission ceiling from one-turn generation intent', () => {
    useCreationSessionStore.getState().setProviderAutoGenerationAllowed(false)
    useCreationSessionStore.getState().setAutoGenerateForNextTurn(true)
    expect(useCreationSessionStore.getState().autoGenerateForNextTurn).toBe(false)

    useCreationSessionStore.getState().setProviderAutoGenerationAllowed(true)
    useCreationSessionStore.getState().setAutoGenerateForNextTurn(true)
    expect(useCreationSessionStore.getState().autoGenerateForNextTurn).toBe(true)

    useCreationSessionStore.getState().completeAcceptedTurn()
    expect(useCreationSessionStore.getState().autoGenerateForNextTurn).toBe(false)
  })

  it('keeps collaboration and auto eligible while review always returns to confirmation', () => {
    useCreationSessionStore.getState().setProviderAutoGenerationAllowed(true)
    useCreationSessionStore.getState().setAutoGenerateForNextTurn(true)
    useCreationSessionStore.getState().setAgentMode('review')

    expect(useCreationSessionStore.getState().autoGenerateForNextTurn).toBe(false)
    expect(autoGenerationTurnCopy('review', 'allowed')).toMatchObject({ enabled: false, label: '审阅模式逐步确认' })
    expect(autoGenerationTurnCopy('collaboration', 'allowed')).toMatchObject({ enabled: true, label: '本轮继续生成' })
  })
})
