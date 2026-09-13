import { ArrowUp, Check, RotateCcw, Square, X } from 'lucide-react'
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react'
import type { AgentRun, ConversationSnapshot } from '../../../shared/agent'
import { createAgentRequest } from '../agent/agent-client'
import { subscribeAgentUpdates } from '../agent/agent-event-stream'
import { autoGenerationTurnCopy, useCreationSessionStore } from '../store/creation-session-store'
import { useGenerationDraftStore } from '../store/generation-draft-store'
import { useWorkspaceStore } from '../store/workspace-store'
import { useProjectScope } from '../store/use-project-scope'

type CreationComposerState = 'idle' | 'editing' | 'acting' | 'confirm' | 'completed' | 'generating' | 'failed'

const ACTIVE_AGENT_STATUSES = new Set<AgentRun['status']>(['queued', 'planning', 'awaiting_confirmation', 'awaiting_execution', 'executing'])
const FAILED_AGENT_STATUSES = new Set<AgentRun['status']>(['failed', 'timed_out', 'interrupted'])

async function preferredImageProvider(operation: 'generate' | 'reference' | 'edit'): Promise<{
  readonly providerId: string
  readonly model: string
  readonly profileId: string
  readonly confirmed: boolean
}> {
  const [settings, profiles] = await Promise.all([
    window.desktop.getProviderSettings(),
    window.desktop.listGenerationProfiles()
  ])
  const imageProvider = settings.providers.find((provider) => provider.id === 'image-provider')
  const realProfile = profiles.profiles.find((entry) => entry.status === 'available'
    && entry.profile.providerId === 'image-provider'
    && entry.profile.supportedOperations.includes(operation))?.profile
  return settings.realCallsAuthorized
    && imageProvider?.configured === true
    && imageProvider.baseUrl.trim() !== ''
    && imageProvider.defaultModel.trim() !== ''
    && realProfile !== undefined
    ? { providerId: 'image-provider', model: imageProvider.defaultModel, profileId: realProfile.id, confirmed: true }
    : { providerId: 'mock', model: 'mock-balanced', profileId: 'local-sketch', confirmed: false }
}

const CREATION_STATE_COPY: Record<CreationComposerState, string> = {
  idle: '待命',
  editing: '正在编辑',
  acting: 'AI 正在执行',
  confirm: '等待确认',
  completed: '已完成',
  generating: '正在生成',
  failed: '需要处理'
}

export function CreationBar(): React.JSX.Element {
  const inputComposingRef = useRef(false)
  const projectId = useWorkspaceStore((state) => state.scene.projectId)
  const isCurrent = useProjectScope(projectId)
  const [submitting, setSubmitting] = useState(false)
  const [compiling, setCompiling] = useState(false)
  const [editing, setEditing] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [snapshot, setSnapshot] = useState<ConversationSnapshot | null>(null)
  const [scope, setScope] = useState<'selection' | 'canvas'>('selection')
  const value = useCreationSessionStore((state) => state.draft)
  const setValue = useCreationSessionStore((state) => state.setDraft)
  const agentMode = useCreationSessionStore((state) => state.agentMode)
  const setAgentMode = useCreationSessionStore((state) => state.setAgentMode)
  const autoGenerate = useCreationSessionStore((state) => state.autoGenerateForNextTurn)
  const setAutoGenerate = useCreationSessionStore((state) => state.setAutoGenerateForNextTurn)
  const providerAutoGeneration = useCreationSessionStore((state) => state.providerAutoGeneration)
  const bindProject = useCreationSessionStore((state) => state.bindProject)
  const refreshProviderAutoGeneration = useCreationSessionStore((state) => state.refreshProviderAutoGeneration)
  const completeAcceptedTurn = useCreationSessionStore((state) => state.completeAcceptedTurn)
  const setActiveView = useWorkspaceStore((state) => state.setActiveView)
  const referenceMode = useGenerationDraftStore((state) => state.referenceMode)
  const updateGenerationDraft = useGenerationDraftStore((state) => state.updateDraft)
  const undo = useWorkspaceStore((state) => state.undo)
  const scene = useWorkspaceStore((state) => state.scene)
  const selectedIds = useWorkspaceStore((state) => state.selectedIds)
  const selected = scene.elements.find((element) => element.id === selectedIds[0])
  const activeRun = snapshot?.runs.find((run) => ACTIVE_AGENT_STATUSES.has(run.status)) ?? null
  const latestRun = snapshot?.runs[0] ?? null
  const latestRunProblem = latestRun !== null && FAILED_AGENT_STATUSES.has(latestRun.status)
    ? latestRun.errorMessage ?? '这次操作没有完成；画布未被部分修改。'
    : null
  const latestReceipt = snapshot?.messages.find((message) => message.role === 'assistant' && message.receipt !== null)?.receipt ?? null
  const effectiveScope = selectedIds.length === 0 ? 'canvas' : scope
  const autoGenerationCopy = autoGenerationTurnCopy(agentMode, providerAutoGeneration)
  const refresh = useCallback(async (): Promise<void> => {
    try {
      setSnapshot(await window.desktop.getConversationSnapshot())
    } catch {
      setProblem('无法读取当前操作状态，请重试')
    }
  }, [])

  useEffect(() => {
    bindProject(scene.projectId)
    void refreshProviderAutoGeneration()
  }, [bindProject, refreshProviderAutoGeneration, scene.projectId])

  useEffect(() => {
    const initial = window.setTimeout(() => void refresh(), 0)
    const unsubscribe = subscribeAgentUpdates(() => void refresh())
    return () => {
      window.clearTimeout(initial)
      unsubscribe()
    }
  }, [refresh])
  const editTarget = selected?.type === 'image'
    ? selected
    : selected?.type === 'mask'
      ? scene.elements.find((element) => element.id === selected.targetElementId && element.type === 'image')
      : undefined
  const hasEditMask = editTarget !== undefined && scene.elements.some(
    (element) => element.type === 'mask' && element.visible && element.targetElementId === editTarget.id
  )
  const composerState: CreationComposerState = problem !== null || latestRunProblem !== null
    ? 'failed'
    : activeRun?.status === 'awaiting_confirmation'
      ? 'confirm'
      : activeRun !== null
        ? 'acting'
    : editing || compiling
      ? 'generating'
      : submitting
        ? 'acting'
        : value.trim().length > 0
          ? 'editing'
          : latestRun?.status === 'completed'
            ? 'completed'
            : 'idle'

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    const text = value.trim()
    if (text.length === 0 || submitting) return
    setSubmitting(true)
    setProblem(null)
    try {
      const request = await createAgentRequest(text, autoGenerate, effectiveScope)
      if (activeRun === null) await window.desktop.startAgentRun(request, agentMode)
      else await window.desktop.inputAgentRun(request, 'correct_current')
      completeAcceptedTurn()
      await refresh()
    } catch {
      setProblem('要求未送达，请重试')
    } finally {
      setSubmitting(false)
    }
  }

  const confirm = async (): Promise<void> => {
    if (activeRun?.status !== 'awaiting_confirmation') return
    try {
      await window.desktop.confirmAgentRun(activeRun.id)
      await refresh()
    } catch {
      setProblem('确认没有生效，请重试')
    }
  }

  const cancel = async (): Promise<void> => {
    if (activeRun === null) return
    try {
      await window.desktop.cancelAgentRun(activeRun.id)
      await refresh()
    } catch {
      setProblem('当前操作暂时无法停止')
    }
  }

  const generateCanvas = async (): Promise<void> => {
    if (compiling || submitting) return
    setCompiling(true)
    setProblem(null)
    try {
      const scene = useWorkspaceStore.getState().scene
      const provider = await preferredImageProvider('generate')
      if (!isCurrent()) return
      updateGenerationDraft({
        prompt: value.trim() || scene.canvas.globalStyle || '根据当前画布结构生成一张完整图片',
        referenceSource: { kind: 'canvas', sceneRevision: scene.revision },
        referenceResultId: null,
        referenceMode,
        model: provider.model,
        quantity: 1,
        profileId: provider.profileId,
        profileSelectionMade: true,
        ratioInput: `${scene.canvas.aspectWidth}:${scene.canvas.aspectHeight}`,
        expandedSections: ['parameters', 'references']
      }, scene.projectId)
      setActiveView('generate')
    } catch (error) {
      if (isCurrent()) setProblem(error instanceof Error ? error.message : '画布参考准备失败，请重试')
    } finally {
      if (isCurrent()) setCompiling(false)
    }
  }

  const editCanvasImage = async (): Promise<void> => {
    if (editing || compiling || submitting || editTarget?.type !== 'image' || !hasEditMask) return
    setEditing(true)
    setProblem(null)
    try {
      const jobs = await window.desktop.listGenerationJobs()
      const parentResult = jobs.flatMap((job) => job.results).find((result) => result.assetId === editTarget.assetId)
      const provider = await preferredImageProvider('edit')
      await window.desktop.editFromCanvas({
        scene,
        targetElementId: editTarget.id,
        prompt: value.trim() || '优化蒙版区域，保持其他区域完全不变',
        negativePrompt: '',
        providerId: provider.providerId,
        model: provider.model,
        count: 1,
        profileId: provider.profileId,
        confirmed: provider.confirmed,
        sourceMessageId: null,
        parentResultId: parentResult?.id ?? null
      })
      setActiveView('generate')
    } catch (error) {
      setProblem(error instanceof Error ? error.message : '局部修改请求未能开始，请重试')
    } finally {
      setEditing(false)
    }
  }
  return (
    <form
      className={`creation-bar composer-${composerState}`}
      data-composer-state={composerState}
      onSubmit={(event) => void submit(event)}
    >
      <div className="creation-input-row">
        <span className="composer-leading-mark" aria-hidden="true" />
        <textarea
          maxLength={8000}
          aria-label="创作输入"
          rows={1}
          value={value}
          disabled={submitting}
          onChange={(event) => setValue(event.currentTarget.value)}
          onCompositionStart={() => { inputComposingRef.current = true }}
          onCompositionEnd={() => { inputComposingRef.current = false }}
          onBlur={() => { inputComposingRef.current = false }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !inputComposingRef.current && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
              event.preventDefault()
              event.currentTarget.form?.requestSubmit()
            }
          }}
          placeholder={activeRun === null ? '描述你想调整的画面…' : '补充或修正当前要求…'}
        />
        <button type="submit" className="send-button" aria-label="发送创作指令" disabled={value.trim().length === 0 || submitting}><ArrowUp size={17} /></button>
      </div>
      {selectedIds.length > 0 && (
        <div className="canvas-selection-context" aria-label="画布指令范围">
          <span>作用范围</span>
          <button type="button" className={effectiveScope === 'selection' ? 'is-active' : ''} onClick={() => setScope('selection')}>当前选区 · {selectedIds.length}</button>
          <button type="button" className={effectiveScope === 'canvas' ? 'is-active' : ''} onClick={() => setScope('canvas')}>整个画布</button>
          {effectiveScope === 'selection' && selected !== undefined && <span className="selected-object">{selected.name}<X size={9} /></span>}
        </div>
      )}
      {composerState === 'confirm' && (
        <div className="canvas-confirm-row">
          <span>此要求将开始生成图片；确认后才会创建任务。</span>
          <button type="button" onClick={() => void confirm()}>确认生成</button>
          <button type="button" className="quiet-choice" onClick={() => void cancel()}><Square size={10} />停止</button>
        </div>
      )}
      {composerState === 'completed' && latestReceipt !== null && (
        <div className="canvas-agent-receipt" data-testid="canvas-agent-receipt">
          <Check size={13} />
          <span>{latestReceipt.items.map((item) => `${item.object}：${item.action} · ${item.impact}`).join('；')}</span>
          {latestReceipt.undoable && <button type="button" onClick={undo}><RotateCcw size={11} />撤销</button>}
          <button type="button" onClick={() => setActiveView('conversation')}>在对话中查看</button>
        </div>
      )}
      <div className="creation-meta">
        <span><span className="composer-state-label">{CREATION_STATE_COPY[composerState]}</span>{problem ?? latestRunProblem ?? (activeRun !== null ? `当前操作 · ${activeRun.status === 'planning' ? '正在理解要求' : activeRun.status === 'awaiting_confirmation' ? '需要确认生成' : '正在更新作品'}` : `当前画布 · ${autoGenerate ? '修改后继续生成' : '仅调整画布'}`)}</span>
        <label className="composer-mode-select">
          <span className="visually-hidden">Agent 模式</span>
          <select aria-label="Agent 模式" value={agentMode} disabled={activeRun !== null} onChange={(event) => setAgentMode(event.currentTarget.value as typeof agentMode)}>
            <option value="review">审阅</option>
            <option value="collaboration">协作</option>
            <option value="auto">自动</option>
          </select>
        </label>
        <label className="inline-toggle" title={autoGenerationCopy.title}><input type="checkbox" checked={autoGenerate} disabled={!autoGenerationCopy.enabled || activeRun !== null} onChange={(event) => setAutoGenerate(event.currentTarget.checked)} /><span>{autoGenerationCopy.label}</span></label>
        <label className="reference-mode-select" title="决定生成时如何理解当前画布">
          <span className="visually-hidden">参考方式</span>
          <select aria-label="参考方式" value={referenceMode} disabled={compiling || activeRun !== null} onChange={(event) => updateGenerationDraft({ referenceMode: event.currentTarget.value as typeof referenceMode })}>
            <option value="hybrid">同时参考</option>
            <option value="visual">画面参考</option>
            <option value="structure">结构参考</option>
          </select>
        </label>
        {hasEditMask && <button type="button" className="canvas-generate-action local-edit-action" data-testid="local-edit-submit" disabled={editing || compiling || submitting} onClick={() => void editCanvasImage()}>{editing ? '正在局部修改' : '局部修改'}</button>}
        {activeRun !== null && activeRun.status !== 'awaiting_confirmation' && <button type="button" className="canvas-generate-action quiet-choice" onClick={() => void cancel()}><Square size={9} />停止</button>}
        <button type="button" className="canvas-generate-action" disabled={compiling || submitting || activeRun !== null} onClick={() => void generateCanvas()}>{compiling ? '正在编译' : '生成画布'}</button>
      </div>
    </form>
  )
}
