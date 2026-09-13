import { useEffect, useRef, useState } from 'react'
import type { GenerationReferencePreview, GenerationReferenceSource } from '../../../shared/generation-reference'
import type { ReferenceMode } from '../../../shared/generation'
import { useWorkspaceStore } from '../store/workspace-store'
import { useProjectScope } from '../store/use-project-scope'
import type { GenerationWorkContext } from '../../../shared/project-work-context'

const modeLabels = { structure: '结构参考', visual: '画面参考', hybrid: '同时参考' } as const
export function GenerationReferenceControl({ source, mode, profileId, modelOverride, configurationKey, selectedResultId, updateDraft, onPreview }: {
  readonly source: GenerationReferenceSource
  readonly mode: ReferenceMode
  readonly profileId: string | null
  readonly modelOverride: string | null
  readonly configurationKey: string
  readonly selectedResultId: string | null
  readonly updateDraft: (patch: Partial<GenerationWorkContext>) => void
  readonly onPreview: (preview: GenerationReferencePreview | null) => void
}): React.JSX.Element {
  const projectId = useWorkspaceStore((state) => state.scene.projectId)
  const isCurrent = useProjectScope(projectId)
  const revision = useWorkspaceStore((state) => state.scene.revision)
  const fileInput = useRef<HTMLInputElement>(null)
  const [preview, setPreview] = useState<GenerationReferencePreview | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)
  const [importing, setImporting] = useState(false)
  const sourceKey = JSON.stringify(source)
  useEffect(() => {
    let active = true
    onPreview(null)
    if (profileId === null) return
    void window.desktop.previewGenerationReference({ projectId, source: JSON.parse(sourceKey) as GenerationReferenceSource,
      profileId, modelOverride, referenceMode: mode }).then((next) => {
      if (!active || !isCurrent()) return
      setPreview(next); setProblem(null); onPreview(next)
    }).catch((error: unknown) => {
      if (!active || !isCurrent()) return
      setPreview(null); onPreview(null)
      setProblem(error instanceof Error ? error.message : '参考预览没有完成，请重试。')
    })
    return () => { active = false }
  }, [sourceKey, mode, profileId, modelOverride, configurationKey, projectId, isCurrent, onPreview, refresh, revision])

  const choose = (next: GenerationReferenceSource): void => updateDraft({ referenceSource: next,
    referenceResultId: next.kind === 'result' ? next.resultId : null,
    ...(next.kind === 'result' || next.kind === 'images' ? { referenceMode: 'visual' } : {}) })
  const importImages = async (files: FileList | null): Promise<void> => {
    if (files === null || files.length === 0) return
    setImporting(true); setProblem(null)
    try {
      if (files.length > 8) throw new Error('每次最多选择 8 张参考图片。')
      const assetIds: string[] = []
      for (const file of Array.from(files)) {
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('参考图片支持 PNG、JPEG 和 WebP。')
        const bytes = new Uint8Array(await file.arrayBuffer())
        if (!isCurrent()) return
        const asset = await window.desktop.importAsset({ projectId, name: file.name, mimeType: file.type as 'image/png' | 'image/jpeg' | 'image/webp', bytes })
        if (!isCurrent()) return
        assetIds.push(asset.id)
      }
      choose({ kind: 'images', assetIds })
    } catch (error) {
      if (isCurrent()) setProblem(error instanceof Error ? error.message : '参考图片导入失败，请重试。')
    } finally {
      if (isCurrent()) setImporting(false)
      if (fileInput.current) fileInput.current.value = ''
    }
  }
  const current = preview?.source.kind === source.kind && JSON.stringify(preview.source) === sourceKey ? preview : null
  return <fieldset className="generation-reference-control" data-testid="generation-reference-control">
    <legend>参考对象</legend>
    <div className="reference-source-choices" role="group" aria-label="参考对象">
      <button type="button" aria-pressed={source.kind === 'text'} onClick={() => choose({ kind: 'text' })}>仅文字</button>
      <button type="button" aria-pressed={source.kind === 'canvas'} onClick={() => choose({ kind: 'canvas', sceneRevision: revision })}>当前画布</button>
      <button type="button" aria-pressed={source.kind === 'result'} disabled={selectedResultId === null} onClick={() => selectedResultId && choose({ kind: 'result', resultId: selectedResultId })}>选中结果</button>
      <button type="button" aria-pressed={source.kind === 'images'} disabled={importing} onClick={() => fileInput.current?.click()}>{importing ? '正在导入…' : '指定图片'}</button>
      <input ref={fileInput} type="file" aria-label="导入参考图片" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={(event) => void importImages(event.currentTarget.files)} />
    </div>
    {current && <>
      {current.thumbnails.length > 0 && <div className="reference-preview-images">{current.thumbnails.map((url, index) => <img src={url} alt={`本次参考预览 ${index + 1}`} key={index} />)}</div>}
      <p className="reference-source-summary">{current.summary}</p>
      {source.kind !== 'text' && <>
        <div className="segmented-row" role="radiogroup" aria-label="参考方式">
          {current.supportedModes.map((value) => <button key={value} type="button" role="radio" aria-checked={mode === value}
            onClick={() => updateDraft({ referenceMode: value })}>{modeLabels[value]}</button>)}
        </div>
        {!current.supportedModes.includes(mode) && <p role="status">{current.supportedModes.length ? '请选择这个对象支持的参考方式。' : '当前图片模型不能接收这些参考图片，请更换模型或明确选择仅文字。'}</p>}
        <small>{mode === 'structure' ? '提交画布的元素、关系、层级与意图。' : mode === 'visual' ? '提交预览对应的图片与文字要求。' : '提交画布合成图、结构语义与文字要求。'}保持项是本次生成的约束，结果仍需核对。</small>
      </>}
    </>}
    {problem && <p className="has-error" role="status">{problem}</p>}
    {source.kind !== 'unresolved' && <button type="button" onClick={() => {
      if (source.kind === 'canvas') choose({ kind: 'canvas', sceneRevision: revision })
      setRefresh((value) => value + 1)
    }}>刷新参考预览</button>}
  </fieldset>
}
