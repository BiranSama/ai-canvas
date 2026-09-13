import { AlertCircle, Check, ChevronDown, CircleDot, Clock3, Columns2, Download, GitBranch, Heart, ImagePlus, Layers3, LoaderCircle, RotateCcw, Settings2, Square } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { formatGenerationCost, formatGenerationCostSummary, summarizeGenerationCosts } from '../../../shared/generation-cost'
import { calculateOutputSize, parseAspectRatio } from '../../../domain'
import type { GenerationDraft, GenerationJob, GenerationProfileAvailability, GenerationProfileSnapshot, GenerationResult } from '../../../shared/generation'
import type { GenerationProviderInfo } from '../../../shared/desktop-api'
import type { GenerationResultFamily } from '../../../shared/generation-workflow'
import type { ProviderSettingsSnapshot } from '../../../shared/provider-settings'
import { registerRuntimeAsset } from '../assets/runtime-assets'
import { useGenerationDraftStore } from '../store/generation-draft-store'
import { useWorkspaceStore } from '../store/workspace-store'
import { useProjectScope } from '../store/use-project-scope'
import type { GenerationWorkContext } from '../../../shared/project-work-context'
import { ImeSafeTextarea } from './ImeSafeTextField'
import { GenerationReferenceControl } from './GenerationReferenceControl'
import type { GenerationReferencePreview } from '../../../shared/generation-reference'
import { formatTimeLimit, generationTiming } from '../../../shared/execution-timing'

interface GenerateViewProps {
  readonly header: React.ReactNode
}

const ACTIVE_STATUSES = new Set(['queued', 'preparing', 'generating', 'downloading'])
const RETRYABLE_STATUSES = new Set(['failed', 'cancelled', 'timed_out', 'interrupted'])

const stageLabels: Readonly<Record<GenerationJob['stage'], string>> = {
  queued: '等待开始',
  validating: '正在检查请求',
  submitting: '正在提交',
  generating: '正在生成',
  localizing: '正在保存到本地',
  completed: '已完成',
  failed: '生成失败',
  cancelled: '已取消',
  timed_out: '等待超时',
  interrupted: '上次运行被中断'
}

const ratioOptions = ['1:1', '4:5', '3:2', '16:9'] as const

const referenceModeCopy = {
  hybrid: { label: '同时参考', hint: '画面观感与结构语义一起交给模型' },
  visual: { label: '画面参考', hint: '更重视构图、色彩、质感与相对位置' },
  structure: { label: '结构参考', hint: '只传递元素、关系、层级与意图' }
} as const

function findJobForResult(jobs: readonly GenerationJob[], result: GenerationResult): GenerationJob | undefined {
  return jobs.find((job) => job.id === result.jobId)
}

function jobTimeCopy(job: GenerationJob): string {
  const timing = generationTiming(job)
  if (timing.limitMs === null) return '旧任务未记录可核对的时限，不会补一段新的等待时间。'
  return `本任务总时限 ${formatTimeLimit(timing.limitMs)} · ${job.startedAt === null ? '排队不计时' : ACTIVE_STATUSES.has(job.status)
    ? `剩余 ${formatTimeLimit(timing.remainingMs ?? 0)}` : `已用 ${formatTimeLimit(timing.elapsedMs)}`}；创建后固定，重启不延长。`
}

function engineLabel(providers: readonly GenerationProviderInfo[], providerId: string, modelId: string): string {
  const provider = providers.find((candidate) => candidate.id === providerId)
  const providerLabel = provider?.label ?? (providerId === 'mock' ? '本地离线引擎' : providerId)
  const modelLabel = provider?.models.find((candidate) => candidate.id === modelId)?.label
    ?? (providerId === 'mock' ? '标准' : modelId)
  return `${providerLabel} · ${modelLabel}`
}

export function GenerateView({ header }: GenerateViewProps): React.JSX.Element {
  const setActiveView = useWorkspaceStore((state) => state.setActiveView)
  const setSelection = useWorkspaceStore((state) => state.setSelection)
  const scene = useWorkspaceStore((state) => state.scene)
  const projectId = scene.projectId
  const isCurrent = useProjectScope(projectId)
  const refreshSequence = useRef(0)
  const filmstripRef = useRef<HTMLDivElement>(null)
  const [providers, setProviders] = useState<readonly GenerationProviderInfo[]>([])
  const [profileSnapshot, setProfileSnapshot] = useState<GenerationProfileSnapshot | null>(null)
  const [providerSettings, setProviderSettings] = useState<ProviderSettingsSnapshot | null>(null)
  const [jobs, setJobs] = useState<readonly GenerationJob[]>([])
  const [resultFamilies, setResultFamilies] = useState<readonly GenerationResultFamily[]>([])
  const draftState = useGenerationDraftStore()
  const {
    prompt,
    negativePrompt,
    ratioInput,
    quantity: count,
    model,
    profileId,
    referenceResultId,
    referenceMode,
    referenceSource,
    variationInstruction,
    preserveConstraints,
    expandedSections, focusedResultId, compareAId, compareBId, compareEnabled, compareActiveSide, familyExpanded, resultScrollLeft
  } = draftState
  const updateDraft = useCallback((patch: Partial<GenerationWorkContext>): void => {
    if (isCurrent()) useGenerationDraftStore.getState().updateDraft(patch, projectId)
  }, [isCurrent, projectId])
  const setSelectedResult = (result: GenerationResult): void => updateDraft(compareEnabled
    ? { [compareActiveSide === 'A' ? 'compareAId' : 'compareBId']: result.id, focusedResultId: result.id }
    : { focusedResultId: result.id })
  const [thumbnailUrls, setThumbnailUrls] = useState<Record<string, string>>({})
  const [originalUrls, setOriginalUrls] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const [pendingConfirmation, setPendingConfirmation] = useState(false)
  const [referencePreview, setReferencePreview] = useState<GenerationReferencePreview | null>(null)

  const refreshJobs = useCallback(async (): Promise<void> => {
    if (!isCurrent()) return
    const sequence = ++refreshSequence.current
    try {
      const [nextJobs, nextFamilies] = await Promise.all([
        window.desktop.listGenerationJobs(),
        window.desktop.listGenerationResultFamilies()
      ])
      if (!isCurrent() || sequence !== refreshSequence.current) return
      const ownedJobs = nextJobs.filter((job) => job.projectId === projectId)
      setJobs(ownedJobs)
      setResultFamilies(nextFamilies)
      const current = useGenerationDraftStore.getState()
      const available = ownedJobs.flatMap((job) => job.results).filter((result) => result.assetAvailable !== false)
      const ids = new Set(available.map((result) => result.id))
      const valid = (id: string | null): boolean => id !== null && ids.has(id)
      const patch: Partial<GenerationWorkContext> = {}
      if (!valid(current.focusedResultId)) {
        patch.focusedResultId = available[0]?.id ?? null
        if (current.focusedResultId !== null) setLocalError('原结果或其素材已不可用。文字要求已保留，可重新关联素材后继续。')
      }
      if (current.compareAId !== null && !valid(current.compareAId)) patch.compareAId = null
      if (current.compareBId !== null && !valid(current.compareBId)) patch.compareBId = null
      if (current.compareEnabled && (!valid(current.compareAId) || !valid(current.compareBId))) {
        patch.compareEnabled = false
        setLocalError('原比较版本已不可用，已返回当前作品。其余草稿仍保留。')
      }
      if (current.referenceResultId !== null && !valid(current.referenceResultId)) {
        patch.referenceResultId = null
        patch.referenceSource = { kind: 'unresolved' }
        setLocalError('原参考版本已不可用，请重新选择参考；文字要求已保留。')
      }
      if (Object.keys(patch).some((key) => patch[key as keyof GenerationWorkContext] !== current[key as keyof GenerationWorkContext])) updateDraft(patch)
    } catch (error) {
      if (isCurrent() && sequence === refreshSequence.current) setLocalError(error instanceof Error ? error.message : '无法读取本地生成任务。')
    }
  }, [isCurrent, projectId, updateDraft])

  useEffect(() => {
    let active = true
    void Promise.all([
      window.desktop.listGenerationProviders(),
      window.desktop.listGenerationProfiles(),
      window.desktop.getProviderSettings()
    ]).then(([providerList, profiles, settings]) => {
      if (active && isCurrent()) {
        setProviders(providerList)
        setProfileSnapshot(profiles)
        setProviderSettings(settings)
        const configuredImage = settings.providers.find((provider) => provider.id === 'image-provider')
        const preferred = configuredImage?.configured === true
          ? profiles.profiles.find((entry) => entry.status === 'available' && entry.profile.providerId === 'image-provider' && entry.profile.tier === 'draft')?.profile
          : undefined
        const currentDraft = useGenerationDraftStore.getState()
        if (preferred !== undefined && !currentDraft.profileSelectionMade) {
          updateDraft({
            profileId: preferred.id,
            profileSelectionMade: true,
            model: preferred.modelId,
            quantity: preferred.defaultQuantity
          })
        }
      }
    }).catch((error: unknown) => {
      if (active) setLocalError(error instanceof Error ? error.message : '无法读取生成能力。')
    })
    const initialRefresh = window.setTimeout(() => void refreshJobs(), 0)
    const timer = window.setInterval(() => void refreshJobs(), 350)
    return () => {
      active = false
      window.clearTimeout(initialRefresh)
      window.clearInterval(timer)
    }
  }, [refreshJobs, isCurrent, updateDraft])

  useEffect(() => {
    const applyProfiles = (
      nextProviders: readonly GenerationProviderInfo[],
      profiles: GenerationProfileSnapshot,
      settings: ProviderSettingsSnapshot
    ): void => {
      if (!isCurrent()) return
      setProviders(nextProviders)
      setProfileSnapshot(profiles)
      setProviderSettings(settings)
      const image = settings.providers.find((provider) => provider.id === 'image-provider')
      const imageReady = image?.kind === 'image'
        && image.configured
        && image.baseUrl.trim() !== ''
        && image.defaultModel.trim() !== ''
        && image.protocol !== 'unconfigured'
        && (image.protocol !== 'task-images' || settings.executionPolicy.maxRequestsPerJob >= 3)
      const preferred = imageReady
        ? profiles.profiles.find((entry) => entry.status === 'available'
          && entry.profile.providerId === 'image-provider'
          && entry.profile.tier === 'draft')?.profile
        : undefined
      const current = useGenerationDraftStore.getState()
      if (preferred !== undefined && !current.profileSelectionMade) {
        updateDraft({
          profileId: preferred.id,
          profileSelectionMade: true,
          model: preferred.modelId,
          quantity: preferred.defaultQuantity
        })
        return
      }
    }
    const handleProviderSettingsChanged = (event: Event): void => {
      const snapshot = (event as CustomEvent<{ readonly snapshot?: ProviderSettingsSnapshot }>).detail?.snapshot
      if (snapshot === undefined) return
      void Promise.all([
        window.desktop.listGenerationProviders(),
        window.desktop.listGenerationProfiles()
      ]).then(([nextProviders, profiles]) => applyProfiles(nextProviders, profiles, snapshot)).catch((error: unknown) => {
        setLocalError(error instanceof Error ? error.message : '图片模型配置已保存，但生成能力没有刷新。')
      })
    }
    window.addEventListener('ai-canvas:provider-settings-changed', handleProviderSettingsChanged)
    return () => window.removeEventListener('ai-canvas:provider-settings-changed', handleProviderSettingsChanged)
  }, [isCurrent, updateDraft])

  const results = useMemo(
    () => jobs.flatMap((job) => job.results.filter((result) => result.assetAvailable !== false).map((result) => ({ result, job }))),
    [jobs]
  )
  const selectedResult = results.find(({ result }) => result.id === focusedResultId)?.result ?? results[0]?.result ?? null
  const focusedResult = compareEnabled ? results.find(({ result }) => result.id === compareAId)?.result ?? selectedResult : selectedResult
  const compareResult = compareEnabled ? results.find(({ result }) => result.id === compareBId)?.result ?? null : null
  const actionResult = compareEnabled && compareActiveSide === 'B' ? compareResult ?? focusedResult : focusedResult
  const setCompareResult = (result: GenerationResult | null): void => updateDraft(result === null
    ? { compareEnabled: false }
    : { compareEnabled: true, compareAId: focusedResult?.id ?? null, compareBId: result.id, compareActiveSide: 'A' })
  const focusedAssetId = focusedResult?.assetId ?? null
  const compareAssetId = compareResult?.assetId ?? null
  const referenceResult = referenceResultId === null ? null : results.find(({ result }) => result.id === referenceResultId)?.result ?? null
  const activeJob = jobs.find((job) => ACTIVE_STATUSES.has(job.status)) ?? null
  const resultMode = activeJob !== null || results.length > 0
  const latestProblem = jobs.find((job) => RETRYABLE_STATUSES.has(job.status)) ?? null
  const profileEntries = profileSnapshot?.profiles ?? []
  const activeProfileEntry = profileEntries.find((candidate) => candidate.profile.id === profileId) ?? null
  const activeProfile = activeProfileEntry?.profile ?? null
  const providerId = activeProfile?.providerId ?? 'mock'
  const activeProvider = providers.find((provider) => provider.id === providerId) ?? providers[0]
  const configuredImageProvider = providerSettings?.providers.find((provider) => provider.id === 'image-provider')
  const imageModuleConfigured = configuredImageProvider?.kind === 'image'
    && configuredImageProvider.baseUrl.trim() !== ''
    && configuredImageProvider.defaultModel.trim() !== ''
    && configuredImageProvider.protocol !== 'unconfigured'
  const hasAvailableImageProfile = profileEntries.some((entry) => entry.status === 'available' && entry.profile.providerId === 'image-provider')
  const taskProtocolBudgetBlocked = imageModuleConfigured
    && configuredImageProvider?.protocol === 'task-images'
    && (providerSettings?.executionPolicy.maxRequestsPerJob ?? 0) < 3
  const realImageAvailable = providerSettings !== null
    && providerSettings.realCallsAuthorized
    && configuredImageProvider?.configured === true
    && imageModuleConfigured
    && hasAvailableImageProfile
  const selectedProviderAvailable = activeProfileEntry?.status === 'available' && (providerId === 'mock' || realImageAvailable)
  const parsedRatio = parseAspectRatio(ratioInput)
  const outputSize = parsedRatio.value === null ? null : calculateOutputSize(parsedRatio.value, 1280)
  const ratioSupported = parsedRatio.value !== null && (
    activeProvider === undefined ||
    activeProvider.capabilities.supportedRatios.includes('custom') ||
    activeProvider.capabilities.supportedRatios.includes(`${parsedRatio.value.width}:${parsedRatio.value.height}`)
  )
  const visualReferenceSupported = referencePreview !== null
    && JSON.stringify(referencePreview.source) === JSON.stringify(referenceSource)
    && (referenceSource.kind === 'text' || referencePreview.supportedModes.includes(referenceMode))
  const variationReady = referenceResult === null || variationInstruction.trim().length > 0
  const parametersExpanded = expandedSections.includes('parameters')

  useLayoutEffect(() => {
    if (filmstripRef.current !== null) filmstripRef.current.scrollLeft = resultScrollLeft
  }, [results.length, resultScrollLeft])

  useEffect(() => {
    for (const { result } of results) {
      if (thumbnailUrls[result.assetId] !== undefined) continue
      void window.desktop.readGenerationAsset(result.assetId, true, projectId).then((url) => {
        if (!isCurrent()) return
        setThumbnailUrls((current) => current[result.assetId] === undefined ? { ...current, [result.assetId]: url } : current)
      }).catch(() => undefined)
    }
  }, [thumbnailUrls, results, projectId, isCurrent])

  useEffect(() => {
    const requiredAssetIds = [...new Set([focusedAssetId, compareAssetId].filter((id): id is string => id !== null))]
    let active = true
    void Promise.all(requiredAssetIds.map(async (assetId) => {
      try {
        return [assetId, await window.desktop.readGenerationAsset(assetId, false, projectId)] as const
      } catch {
        return null
      }
    })).then((entries) => {
      if (!active || !isCurrent()) return
      setOriginalUrls(Object.fromEntries(entries.filter((entry): entry is readonly [string, string] => entry !== null)))
    })
    return () => { active = false }
  }, [compareAssetId, focusedAssetId, projectId, isCurrent])

  const submit = async (confirmed = false): Promise<void> => {
    if (!isCurrent()) return
    if (parsedRatio.value === null || outputSize === null || !ratioSupported || !visualReferenceSupported || !variationReady) return
    if (activeProfile?.requireConfirmation === true && !confirmed) {
      setPendingConfirmation(true)
      return
    }
    setSubmitting(true)
    setLocalError(null)
    const draft: GenerationDraft = {
      prompt: prompt.trim(),
      negativePrompt: negativePrompt.trim(),
      aspect: { width: parsedRatio.value.width, height: parsedRatio.value.height },
      quantity: count,
      profileId,
      referenceResultIds: referenceResult === null ? [] : [referenceResult.id],
      sourceSceneRevision: referenceSource.kind === 'canvas' ? referenceSource.sceneRevision : null,
      referenceMode,
      variationInstruction: variationInstruction.trim(),
      preserveConstraints: preserveConstraints.trim(),
      expandedSections: [...expandedSections]
    }
    const request = {
      projectId,
      profileId,
      confirmed,
      referenceSource,
      expectedReferenceSignature: referencePreview?.signature,
      operation: 'generate' as const,
      draft,
      outputWidth: outputSize.width,
      outputHeight: outputSize.height,
      references: [],
      parameters: { basePrompt: prompt.trim(), referenceMode },
      sourceMessageId: null,
      parentResultId: referenceResult?.id ?? null,
      modelOverride: providerId === 'mock' ? model : null
    }
    try {
      await window.desktop.enqueueGenerationProfile(request)
      if (!isCurrent()) return
      setPendingConfirmation(false)
      updateDraft({ expandedSections: expandedSections.filter((section) => section !== 'parameters') })
      await refreshJobs()
    } catch (error) {
      if (isCurrent()) setLocalError(error instanceof Error ? error.message : '任务未能加入队列。')
    } finally {
      if (isCurrent()) setSubmitting(false)
    }
  }

  const insertIntoCanvas = async (result: GenerationResult, localEdit = false): Promise<void> => {
    try {
      const dataUrl = await window.desktop.readGenerationAsset(result.assetId, false, projectId)
      if (!isCurrent()) return
      registerRuntimeAsset(result.assetId, dataUrl)
      const receipt = await window.desktop.placeGenerationResult({
        projectId,
        resultId: result.id,
        placementId: globalThis.crypto.randomUUID(),
        origin: 'user'
      })
      if (!isCurrent()) return
      setSelection([receipt.elementId])
      setActiveView('canvas')
      if (localEdit) useWorkspaceStore.getState().setActiveTool('mask')
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : '无法把结果放入画布。')
    }
  }

  const exportResult = async (result: GenerationResult): Promise<void> => {
    try {
      const dataUrl = await window.desktop.readGenerationAsset(result.assetId, false, projectId)
      if (!isCurrent()) return
      const extension = /^data:image\/jpeg/.test(dataUrl) ? 'jpg' : /^data:image\/webp/.test(dataUrl) ? 'webp' : 'png'
      const anchor = document.createElement('a')
      anchor.href = dataUrl
      const job = findJobForResult(jobs, result)
      anchor.download = `${useWorkspaceStore.getState().projectName}-${job ? versionLabel(result, job) : `v${result.variantIndex + 1}`}-${result.id.slice(0, 8)}.${extension}`
      anchor.click()
    } catch {
      setLocalError('导出结果没有完成，请重试。')
    }
  }

  const toggleFavorite = async (result: GenerationResult): Promise<void> => {
    try {
      const families = await window.desktop.setGenerationResultFavorite({ projectId, resultId: result.id, favorite: !result.favorite })
      if (!isCurrent()) return
      setResultFamilies(families)
      await refreshJobs()
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : '无法更新结果收藏状态。')
    }
  }

  const retry = async (job: GenerationJob): Promise<void> => {
    try {
      await window.desktop.retryGeneration(job.id, job.providerId === 'mock' ? { model } : {})
      if (!isCurrent()) return
      setLocalError(null)
      await refreshJobs()
    } catch (error) {
      if (isCurrent()) setLocalError(error instanceof Error ? error.message : '无法重试此任务。')
    }
  }

  const selectedJob = focusedResult === null ? undefined : findJobForResult(jobs, focusedResult)
  const selectedFamily = focusedResult === null
    ? null
    : resultFamilies.find((family) => family.members.some((member) => member.resultId === focusedResult.id)) ?? null
  const selectedFamilyMember = focusedResult === null || selectedFamily === null
    ? null
    : selectedFamily.members.find((member) => member.resultId === focusedResult.id) ?? null
  const estimatedTotal = activeProfile?.estimatedUnitCostCny == null ? null : Number((activeProfile.estimatedUnitCostCny * count).toFixed(2))
  const selectedProfileLabel = activeProfile?.label ?? '读取档位…'
  const referenceLabel = referenceSource.kind === 'text' ? '仅文字'
    : referenceSource.kind === 'canvas' ? `画布 r${referenceSource.sceneRevision}`
      : referenceSource.kind === 'result' ? '选中结果'
        : referenceSource.kind === 'images' ? `${referenceSource.assetIds.length} 张参考图片` : '请确认参考对象'

  const versionLabel = (result: GenerationResult, job: GenerationJob): string => {
    const family = resultFamilies.find((candidate) => candidate.members.some((member) => member.resultId === result.id))
    const familyIndex = family?.members.findIndex((member) => member.resultId === result.id) ?? -1
    return familyIndex >= 0 ? `v${familyIndex + 1}` : `v${job.attempt}.${result.variantIndex + 1}`
  }

  const continueFromResult = (result: GenerationResult): void => {
    const sourceJob = findJobForResult(jobs, result)
    const storedBasePrompt = sourceJob?.request.parameters.basePrompt
    const storedRequirement = sourceJob?.request.parameters.originalRequirement
    const continuationPrompt = typeof storedBasePrompt === 'string' && storedBasePrompt.trim().length > 0
      ? storedBasePrompt.trim()
      : typeof storedRequirement === 'string' && storedRequirement.trim().length > 0
        ? storedRequirement.trim()
        : prompt.trim().length > 0
          ? prompt
          : sourceJob?.request.prompt ?? ''
    updateDraft({
      prompt: continuationPrompt,
      referenceResultId: result.id,
      referenceSource: { kind: 'result', resultId: result.id },
      referenceMode: 'visual',
      variationInstruction: '',
      preserveConstraints: '主体身份、主要构图、画面比例与核心色调',
      expandedSections: expandedSections.includes('parameters') ? expandedSections : [...expandedSections, 'parameters']
    })
  }

  const compareWithParent = (): void => {
    if (selectedFamilyMember?.parentResultId === null || selectedFamilyMember?.parentResultId === undefined) return
    const parent = results.find(({ result }) => result.id === selectedFamilyMember.parentResultId)?.result
    if (parent !== undefined) setCompareResult(parent)
  }

  const renderResultActions = (result: GenerationResult): React.JSX.Element => (
    <div className="result-actions">
      <button data-testid="insert-generation-result" type="button" title="放入画布" onClick={() => void insertIntoCanvas(result)}><ImagePlus size={15} />放入画布</button>
      {results.length > 1 && <button type="button" title={compareResult === null ? '与另一版本并排比较' : '结束比较'} onClick={() => setCompareResult(compareResult === null ? results.find(({ result: candidate }) => candidate.id !== result.id)?.result ?? null : null)}><Columns2 size={14} />{compareResult === null ? '比较' : '结束比较'}</button>}
      <button type="button" title="以此结果为参考继续变化" onClick={() => continueFromResult(result)}><RotateCcw size={14} />继续变化</button>
      <button type="button" title="放入画布并绘制局部修改蒙版" onClick={() => void insertIntoCanvas(result, true)}><Layers3 size={14} />局部修改</button>
      <button type="button" title={`导出结果 ${versionLabel(result, findJobForResult(jobs, result)!)}`} aria-label={`导出结果 ${versionLabel(result, findJobForResult(jobs, result)!)}`} onClick={() => void exportResult(result)}><Download size={14} />导出</button>
      <button type="button" title={result.favorite ? '取消收藏' : '收藏此结果'} aria-pressed={result.favorite} onClick={() => void toggleFavorite(result)}><Heart size={14} fill={result.favorite ? 'currentColor' : 'none'} />{result.favorite ? '已收藏' : '收藏'}</button>
    </div>
  )

  return (
    <div className="generate-view">
      {header}
      <main className={`generate-workspace${resultMode ? ' is-result-mode' : ''}${resultMode && !parametersExpanded ? ' is-parameters-collapsed' : ''}`}>
        <section className={`generation-composer${resultMode && !parametersExpanded ? ' is-compact' : ''}`} aria-label="快速生成设置">
          {resultMode && (
            <button type="button" className="generation-compact-summary glass-surface" aria-expanded={parametersExpanded} onClick={() => updateDraft({ expandedSections: parametersExpanded ? expandedSections.filter((section) => section !== 'parameters') : [...expandedSections, 'parameters'] })}>
              <span><strong title={prompt}>{activeJob === null ? prompt || '继续当前作品' : stageLabels[activeJob.stage]}</strong><small>{referenceLabel} · {ratioInput} · {count} 张 · {selectedProfileLabel}</small></span>
              <span>{parametersExpanded ? '收起参数' : '展开参数'}<ChevronDown size={13} /></span>
            </button>
          )}
          <div className="generation-form-body">
          <div className="generation-heading">
            <span>本次创作</span>
            <h1>{referenceSource.kind === 'text' ? '从画面开始' : '延续这件作品'}</h1>
            <p>写下要保留的细节，与这一次想尝试的变化。</p>
          </div>

          <label className="generation-prompt">
            <span>画面需求</span>
            <textarea data-testid="generation-prompt" aria-label="画面需求" maxLength={8000} value={prompt} onChange={(event) => updateDraft({ prompt: event.currentTarget.value })} rows={5} />
          </label>
          <GenerationReferenceControl source={referenceSource} mode={referenceMode}
            profileId={activeProfile?.id ?? null} modelOverride={providerId === 'mock' ? model : null}
            configurationKey={JSON.stringify([activeProfileEntry, configuredImageProvider])}
            selectedResultId={actionResult?.id ?? null} updateDraft={updateDraft} onPreview={setReferencePreview} />
          <details className="generation-options" open={expandedSections.includes('advanced')} onToggle={(event) => {
            const open = event.currentTarget.open
            if (open !== expandedSections.includes('advanced')) updateDraft({ expandedSections: open ? [...expandedSections, 'advanced'] : expandedSections.filter((section) => section !== 'advanced') })
          }}>
            <summary><span>尺寸与生成策略</span><small>{ratioInput} · {count} 张 · {selectedProfileLabel}</small><ChevronDown size={14} /></summary>
          <label className="generation-negative">
            <span>不希望出现</span>
            <input aria-label="负面提示词" maxLength={8000} value={negativePrompt} onChange={(event) => updateDraft({ negativePrompt: event.currentTarget.value })} />
          </label>

          <div className="generation-controls">
            <fieldset>
              <legend>比例</legend>
              <div className="segmented-row">
                {ratioOptions.map((option) => (
                  <button key={option} type="button" className={ratioInput === option ? 'is-active' : ''} onClick={() => updateDraft({ ratioInput: option })}>{option}</button>
                ))}
                <input aria-label="自由生成比例" maxLength={40} value={ratioInput} onChange={(event) => updateDraft({ ratioInput: event.currentTarget.value })} />
              </div>
              <small className={ratioSupported ? '' : 'has-error'}>{parsedRatio.error ?? (ratioSupported && outputSize !== null ? `${parsedRatio.value?.width}:${parsedRatio.value?.height} → ${outputSize.width} × ${outputSize.height}` : `${activeProvider?.label ?? '当前供应商'}不支持这个比例`)}</small>
            </fieldset>
            <label className="generation-quantity"><span>数量</span><select aria-label="生成数量" value={count} onChange={(event) => updateDraft({ quantity: Number(event.currentTarget.value) })}>{[1, 2, 3, 4].filter((value) => value <= (activeProfile?.maxQuantity ?? 4)).map((value) => <option key={value} value={value}>{value} 张</option>)}</select></label>
            <div className="generation-provider-control" aria-label="生成供应商">
              <span>图片模型</span>
              <div>
                <span>
                  <strong>{configuredImageProvider?.label ?? '未配置图片模型'}</strong>
                  <small>{taskProtocolBudgetBlocked
                    ? '异步任务式 Images · 请把每任务请求上限提高到至少 3'
                    : imageModuleConfigured
                      ? `${configuredImageProvider.protocol} · ${configuredImageProvider.configured ? configuredImageProvider.defaultModel : '未保存凭据，当前任务仍可使用本地档'}`
                    : '选择协议、地址与模型后启用真实生成'}</small>
                </span>
                <button type="button" aria-label="配置图片模型" onClick={() => window.dispatchEvent(new CustomEvent('ai-canvas:open-provider-settings', { detail: { providerId: 'image-provider' } }))}><Settings2 size={13} />更换配置</button>
              </div>
            </div>
            <label className="generation-model-scenario"><span>模型情景</span><select aria-label="模型情景" value={model} onChange={(event) => updateDraft({ model: event.currentTarget.value })}>{activeProvider?.models.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
          </div>
          <div className="generation-tier" role="group" aria-label="生成档位">
            <span>生成档位</span>
            {profileEntries.map((entry: GenerationProfileAvailability) => (
              <button
                key={entry.profile.id}
                type="button"
                className={profileId === entry.profile.id ? 'is-active' : ''}
                disabled={entry.status !== 'available'}
                title={entry.reason ?? `${entry.profile.label} · ${entry.profile.simulated ? '本地离线' : '图片供应商'}`}
                onClick={() => {
                  updateDraft({ profileId: entry.profile.id, profileSelectionMade: true, quantity: entry.profile.defaultQuantity, model: entry.profile.modelId })
                  setPendingConfirmation(false)
                }}
              >{entry.profile.label}{entry.status === 'locked' ? ' · 已锁定' : ''}</button>
            ))}
          </div>
          </details>

          {referenceResult !== null && (
            <div className="variation-contract">
              <div className="reference-chip">
                <ImagePlus size={14} />
                <span>从版本 {referenceResult.variantIndex + 1} 继续 · {referenceModeCopy[referenceMode].label}</span>
                <button type="button" onClick={() => updateDraft({ referenceResultId: null, referenceSource: { kind: 'text' }, variationInstruction: '', preserveConstraints: '' })}>移除</button>
              </div>
              <label>
                <span>这次只改变</span>
                <ImeSafeTextarea
                  aria-label="本次变化"
                  maxLength={8000}
                  onDraftChange={(value) => updateDraft({ variationInstruction: value })}
                  value={variationInstruction}
                  placeholder="例如：让标题更飘逸，瓶身稍微下移，光线更柔和"
                  rows={2}
                  onCommit={(value) => updateDraft({ variationInstruction: value })}
                />
              </label>
              <label>
                <span>保持不变</span>
                <ImeSafeTextarea
                  aria-label="保持不变"
                  maxLength={8000}
                  onDraftChange={(value) => updateDraft({ preserveConstraints: value })}
                  value={preserveConstraints}
                  placeholder="例如：主体身份、比例、主色调和留白"
                  rows={2}
                  onCommit={(value) => updateDraft({ preserveConstraints: value })}
                />
              </label>
              <small>原始画面需求会作为基线保留；新版本会单独记录变化与继承关系。</small>
              {!visualReferenceSupported && <small className="has-error">请核对上方参考预览，选择支持画面参考的图片模型。</small>}
            </div>
          )}
          {selectedJob?.request.parameters.mode === 'canvas' && (
            <div className="reference-chip canvas-reference-chip">
              <Layers3 size={13} />
              <span>画布参考已编译并保存</span>
            </div>
          )}
          {selectedJob !== undefined && 'kind' in selectedJob.request && selectedJob.request.kind === 'edit' && (
            <div className="reference-chip canvas-reference-chip">
              <Layers3 size={13} />
              <span>非破坏式局部修改 · 源图与蒙版已保留</span>
            </div>
          )}

          </div>
          <div className="generation-submit-area">
          <div className="profile-budget-summary" aria-label="档位费用摘要">
            <span>{activeProfile?.simulated === true ? `模拟估价 ¥${(estimatedTotal ?? 0).toFixed(2)}` : estimatedTotal === null ? '费用未知' : `预估 ¥${estimatedTotal.toFixed(2)}`}</span>
            <span>{activeProfile?.simulated === true ? '离线模拟 · ¥0.00' : `预约额度 ¥${providerSettings?.executionPolicy.maxCostCnyPerJob.toFixed(2) ?? '—'}`}</span>
          </div>
          <button
            type="button"
            className="generate-primary"
            data-testid="generation-submit"
            disabled={prompt.trim().length === 0 || submitting || activeJob !== null || !ratioSupported || !selectedProviderAvailable || !visualReferenceSupported || !variationReady}
            onClick={() => void submit(false)}
          >
            {activeJob === null ? <CircleDot size={17} /> : <LoaderCircle className="spin" size={17} />}
            {activeJob === null ? '开始生成' : stageLabels[activeJob.stage]}
          </button>
          {pendingConfirmation && activeProfile !== null && (
            <div className="generation-confirmation" role="alertdialog" aria-label="确认生成">
              <div><strong>确认使用 {activeProfile.label}</strong><span>{count} 张 · {activeProfile.simulated ? '离线模拟，¥0.00' : `费用未知，预约额度 ¥${providerSettings?.executionPolicy.maxCostCnyPerJob.toFixed(2) ?? '—'}；预约不代表实际扣费上限`}</span></div>
              <button type="button" onClick={() => setPendingConfirmation(false)}>取消</button>
              <button type="button" onClick={() => void submit(true)}>确认生成</button>
            </div>
          )}
          <details className="provider-boundary"><summary>本次请求与费用范围</summary><p>{providerSettings === null
            ? '正在读取本地供应商边界…'
            : realImageAvailable
              ? `使用已保存的服务，每任务最多 ${providerSettings.executionPolicy.maxImagesPerJob} 张、${providerSettings.executionPolicy.maxRequestsPerJob} 个传输请求。价格未知时，预约额度不保证实际人民币扣费上限。`
              : taskProtocolBudgetBlocked
                ? '异步任务需要创建、查询和安全下载三个请求阶段；请把每任务请求上限提高到至少 3，本地档仍可使用。'
              : '本地离线档不联网、不计费；保存图片服务的地址、模型与凭据后会出现对应生成策略。'}</p></details>
          </div>
        </section>

        <section className="generation-results" aria-label="生成结果">
          <p className="generation-cost-summary" data-testid="generation-cost-summary">{formatGenerationCostSummary(summarizeGenerationCosts(jobs))}</p>
          <div className={`result-focus${focusedResult !== null ? ' has-result' : ''}${compareResult !== null ? ' is-comparing' : ''}`} data-result-a={focusedResult?.id ?? ''} data-result-b={compareResult?.id ?? ''}>
            {compareEnabled && <div className="result-compare-labels" aria-hidden="true"><span>A{compareActiveSide === 'A' ? ' · 当前操作' : ''}</span><span>B{compareActiveSide === 'B' ? ' · 当前操作' : ''}</span></div>}
            {focusedResult !== null && (originalUrls[focusedResult.assetId] ?? thumbnailUrls[focusedResult.assetId]) !== undefined ? (
              <img src={originalUrls[focusedResult.assetId] ?? thumbnailUrls[focusedResult.assetId]} alt={selectedJob?.request.prompt ?? '生成结果'} />
            ) : (
              <div className="result-empty">
                <CircleDot size={24} />
                <strong>{activeJob === null ? '结果会出现在这里' : stageLabels[activeJob.stage]}</strong>
                <span>{activeJob === null ? '描述画面，或选择画布与图片作为参考。' : '可以切换工作视图，任务和要求会保留。'}</span>
              </div>
            )}
            {compareResult !== null && (originalUrls[compareResult.assetId] ?? thumbnailUrls[compareResult.assetId]) !== undefined && (
              <img className="compare-image" src={originalUrls[compareResult.assetId] ?? thumbnailUrls[compareResult.assetId]} alt="对比版本" />
            )}
          </div>
          {compareEnabled && <div className="result-compare-controls" aria-label="版本比较">
            {(['A', 'B'] as const).map((side) => <div key={side} className="result-compare-side" role="group" aria-label={`比较 ${side}`}>
              <button type="button" aria-pressed={compareActiveSide === side} onClick={() => updateDraft({ compareActiveSide: side })}>操作 {side}</button>
              <select aria-label={`比较版本 ${side}`} value={(side === 'A' ? compareAId : compareBId) ?? ''} onChange={(event) => updateDraft({ [side === 'A' ? 'compareAId' : 'compareBId']: event.currentTarget.value, compareActiveSide: side })}>
                {results.map(({ result, job }, index) => <option key={result.id} value={result.id}>第 {index + 1} 项 · {versionLabel(result, job)}</option>)}
              </select>
            </div>)}
            <button type="button" onClick={() => updateDraft({ compareAId: compareBId, compareBId: compareAId })}>交换 A/B</button>
            <small>下方版本带可更换当前操作侧</small>
          </div>}
          {actionResult !== null && <div className="result-action-row">{renderResultActions(actionResult)}</div>}

          {focusedResult !== null && selectedFamily !== null && (
            <section className={`result-family-panel${familyExpanded ? ' is-expanded' : ''}`} data-testid="result-family-summary" aria-label="结果家族">
              <button type="button" className="result-family-summary" aria-expanded={familyExpanded} onClick={() => updateDraft({ familyExpanded: !familyExpanded })}>
                <span><GitBranch size={12} /><strong>结果家族</strong><small>{selectedFamily.members.length} 个版本 · {selectedFamily.favoriteResultIds.length} 个收藏</small></span>
                <span>{selectedFamily.rootResultId === focusedResult.id ? '起始版本' : '派生版本'}<ChevronDown size={11} /></span>
              </button>
              {selectedFamilyMember !== null && selectedFamilyMember.parentResultId !== null && (
                <div className="variation-receipt" data-testid="variation-receipt">
                  <span className="variation-receipt-trace" aria-hidden="true" />
                  <div>
                    <strong>{selectedFamilyMember.variationInstruction || '延续上一版本'}</strong>
                    <small>
                      {referenceModeCopy[selectedFamilyMember.referenceMode].label}
                      {selectedFamilyMember.preserveConstraints ? ` · 保持 ${selectedFamilyMember.preserveConstraints}` : ''}
                    </small>
                  </div>
                  <button type="button" onClick={compareWithParent}><Columns2 size={12} />与父版本比较</button>
                </div>
              )}
              {familyExpanded && selectedFamilyMember !== null && (
                <div className="result-family-detail">
                  <div className="result-family-branches" role="list" aria-label="家族版本">
                    {selectedFamily.members.map((member, index) => {
                      const result = results.find((candidate) => candidate.result.id === member.resultId)?.result
                      const parentIndex = member.parentResultId === null
                        ? null
                        : selectedFamily.members.findIndex((candidate) => candidate.resultId === member.parentResultId)
                      return (
                        <div key={member.resultId} className="result-family-node" role="listitem">
                          {member.parentResultId !== null && (
                            <span className="result-family-connector" aria-label={`继承自版本 ${(parentIndex ?? 0) + 1}`}>
                              <span aria-hidden="true" />
                              <small>v{(parentIndex ?? 0) + 1}</small>
                            </span>
                          )}
                          <button
                            type="button"
                            className={member.resultId === focusedResult.id ? 'is-active' : ''}
                            disabled={result === undefined}
                            onClick={() => result !== undefined && setSelectedResult(result)}
                          >
                            {result !== undefined && thumbnailUrls[result.assetId] !== undefined
                              ? <img src={thumbnailUrls[result.assetId]} alt="" />
                              : <span className="result-family-placeholder" />}
                            <span><strong>v{index + 1}</strong><small>{member.parentResultId === null ? '起始' : referenceModeCopy[member.referenceMode].label}</small></span>
                            {member.favorite && <Heart size={9} fill="currentColor" />}
                          </button>
                        </div>
                      )
                    })}
                  </div>
                  <dl className="result-provenance">
                    <div><dt>来源</dt><dd>{selectedFamilyMember.parentResultId === null ? '起始版本' : `继承 ${selectedFamilyMember.parentResultId.slice(0, 8)}`}</dd></div>
                    <div><dt>操作</dt><dd>{selectedFamilyMember.operation === 'edit' ? '局部修改' : selectedFamilyMember.operation === 'similar' ? '相似延展' : selectedFamilyMember.operation === 'canvas' ? '画布参考' : selectedFamilyMember.operation === 'text-effect' ? '文字效果' : '首次生成'}</dd></div>
                    <div><dt>参考</dt><dd>{referenceModeCopy[selectedFamilyMember.referenceMode].label}</dd></div>
                    <div><dt>变化</dt><dd>{selectedFamilyMember.variationInstruction || '首次生成，无增量说明'}</dd></div>
                    <div><dt>保持</dt><dd>{selectedFamilyMember.preserveConstraints || '沿用原始需求'}</dd></div>
                    <div><dt>生成策略</dt><dd>{typeof selectedJob?.request.parameters.generationProfileLabel === 'string' ? selectedJob.request.parameters.generationProfileLabel : '旧任务未记录策略名称'}</dd></div>
                    <div><dt>引擎</dt><dd>{engineLabel(providers, selectedFamilyMember.providerId, selectedFamilyMember.model)}</dd></div>
                    <div><dt>Scene</dt><dd>{selectedFamilyMember.sourceSceneRevision === null ? '未记录' : `r${selectedFamilyMember.sourceSceneRevision}`}</dd></div>
                    <div><dt>设计方向</dt><dd title={selectedFamilyMember.sourceDirectionId ?? undefined}>{scene.creativeContext?.directions?.find((direction) => direction.id === selectedFamilyMember.sourceDirectionId)?.title ?? (selectedFamilyMember.sourceDirectionId === null ? '未记录' : '来源已保留')}</dd></div>
                    <div><dt>任务费用</dt><dd>{formatGenerationCost(selectedFamilyMember.cost)}{selectedFamilyMember.copiedFromProjectId ? ' · 源项目记录' : ''}<span> · 同任务多张结果共用此金额</span></dd></div>
                    {selectedFamilyMember.cost?.estimate && <div><dt>当时预估</dt><dd>{selectedFamilyMember.cost.estimate.currency} {selectedFamilyMember.cost.estimate.amount.toFixed(2)} · {selectedFamilyMember.cost.estimate.source === 'offline_simulation' ? '离线模拟估价' : '服务价格'}</dd></div>}
                  </dl>
                </div>
              )}
            </section>
          )}

          {(activeJob !== null || latestProblem !== null || localError !== null) && (
            <div data-testid="generation-status" className={`generation-status${activeJob === null ? ' has-problem' : ''}`} aria-live="polite">
              {activeJob !== null ? <Clock3 size={15} /> : <AlertCircle size={15} />}
              <div>
                <strong>{activeJob !== null ? stageLabels[activeJob.stage] : localError ?? stageLabels[latestProblem?.stage ?? 'failed']}</strong>
                <span>{activeJob !== null
                  ? engineLabel(providers, activeJob.providerId, activeJob.model)
                  : latestProblem === null
                    ? '请检查本地运行状态后重试。'
                    : `${engineLabel(providers, latestProblem.providerId, latestProblem.model)} · ${stageLabels[latestProblem.stage]} · ${latestProblem.error?.message ?? '任务未完成'}`}</span>
                {activeJob === null && latestProblem !== null && <small className="preserved-request">要求已保留：{latestProblem.request.prompt}</small>}
                {(activeJob ?? latestProblem) !== null && <small className="generation-time-policy">{jobTimeCopy((activeJob ?? latestProblem)!)}</small>}
              </div>
              {activeJob !== null && <button type="button" onClick={() => void window.desktop.cancelGeneration(activeJob.id).then(refreshJobs)}><Square size={11} />取消</button>}
              {activeJob === null && latestProblem !== null && (latestProblem.copiedFromProjectId
                ? <button type="button" onClick={() => updateDraft({ prompt: latestProblem.request.prompt, negativePrompt: latestProblem.request.negativePrompt,
                  ratioInput: `${latestProblem.request.aspectWidth}:${latestProblem.request.aspectHeight}`, quantity: Math.min(4, latestProblem.request.count), expandedSections: ['parameters'] })}>沿用要求</button>
                : <button type="button" onClick={() => void retry(latestProblem)}><RotateCcw size={12} />重试</button>)}
            </div>
          )}

          <div className="filmstrip-header">
            <div><strong>创作版本</strong><span>{results.length} 个本地结果</span></div>
            {jobs.some((job) => job.status === 'completed') && <span className="saved-mark"><Check size={12} />已保存</span>}
          </div>
          <div className="result-filmstrip" ref={filmstripRef} aria-label="结果胶片条" onScroll={(event) => updateDraft({ resultScrollLeft: event.currentTarget.scrollLeft })}>
            {results.map(({ result, job }) => (
              <button
                type="button"
                data-testid="generation-result"
                key={result.id}
                className={actionResult?.id === result.id ? 'is-selected' : ''}
                data-parent-result={result.parentResultId ?? ''}
                onClick={() => setSelectedResult(result)}
              >
                {thumbnailUrls[result.assetId] === undefined ? <span className="filmstrip-loading" /> : <img src={thumbnailUrls[result.assetId]} alt="" />}
                <span>{versionLabel(result, job)}{result.parentResultId === null ? '' : ' ↳'}</span>
              </button>
            ))}
            {results.length === 0 && <p>还没有版本。完成的结果不会覆盖彼此。</p>}
          </div>
        </section>
      </main>
    </div>
  )
}
