import { ArrowDown, ArrowUp, Eye, EyeOff, Pencil, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { ADJUSTMENT_KINDS, FILTER_KINDS, type AdjustmentKind, type FilterKind, type SceneElement } from '../../../domain'
import { ADJUSTMENT_LABELS, describeLayerSettings, layerSettingsLabel, type Histogram } from '../../../shared/adjustments'
import { FILTER_LABELS } from '../../../shared/filters'
import { adjustSelectedLayer, belowHistogram, changeLayerAdjustments, editLayerAdjustment, filterSelectedLayer, setAdjustmentLayerSettings } from '../adjustments/adjustment-actions'
import { adjustmentLayerSettings, useAdjustmentPreview } from '../canvas/adjustment-preview'
import { useWorkspaceStore } from '../store/workspace-store'
import { AdjustmentControls } from './AdjustmentControls'

type ImageElement = Extract<SceneElement, { type: 'image' }>
type AdjustmentLayer = Extract<SceneElement, { type: 'adjustment' }>

const SHORTCUTS: Partial<Record<AdjustmentKind, string>> = {
  levels: 'Ctrl+L', curves: 'Ctrl+M', 'hue-saturation': 'Ctrl+U', 'color-balance': 'Ctrl+B', 'black-white': 'Ctrl+Alt+Shift+B', invert: 'Ctrl+I', desaturate: 'Ctrl+Shift+U'
}

/**
 * An image layer's own adjustments and filters, oldest first, as they
 * apply: each can be opened again, turned off, moved or taken out. 添加调整
 * and 添加滤镜 open the same dialogs as the shortcuts.
 */
export function LayerAdjustmentsSection({ element }: { readonly element: ImageElement }): React.JSX.Element {
  const list = element.adjustments ?? []
  // Each change is made to the list as it is when the step runs, by id, so quick clicks do not undo each other.
  const move = (id: string, by: number): void => {
    void changeLayerAdjustments(element, (current) => {
      const next = [...current]
      const index = next.findIndex((candidate) => candidate.id === id)
      const [item] = index < 0 ? [] : next.splice(index, 1)
      if (item === undefined) return current
      next.splice(Math.max(0, Math.min(next.length, index + by)), 0, item)
      return next
    }, '调整顺序')
  }
  return (
    <div className="inspector-section adjustment-section">
      <p className="section-kicker">调整与滤镜</p>
      {list.length === 0 && <p className="field-note">只改这一层，不改原图。快捷键同 PS：Ctrl+L 色阶、Ctrl+M 曲线、Ctrl+U 色相/饱和度，Ctrl+Alt+F 再用一次上次的滤镜。</p>}
      {list.length > 0 && (
        <ol className="adjustment-list" aria-label="这一层的调整与滤镜">
          {list.map((adjustment, index) => {
            const label = layerSettingsLabel(adjustment.settings)
            return (
            <li key={adjustment.id} className={adjustment.enabled ? '' : 'is-off'}>
              <button type="button" className="icon-button quiet" aria-label={adjustment.enabled ? `关闭${label}` : `打开${label}`} title={adjustment.enabled ? '关闭' : '打开'}
                disabled={element.locked}
                onClick={() => void changeLayerAdjustments(element, (current) => current.map((candidate) => candidate.id === adjustment.id ? { ...candidate, enabled: !adjustment.enabled } : candidate), adjustment.enabled ? '关闭调整' : '打开调整')}>
                {adjustment.enabled ? <Eye size={13} /> : <EyeOff size={13} />}
              </button>
              <span className="adjustment-name" title={describeLayerSettings(adjustment.settings)}>
                {label}{adjustment.clip !== undefined && <small>选区</small>}
              </span>
              {adjustment.settings.kind !== 'invert' && adjustment.settings.kind !== 'desaturate' && (
                <button type="button" className="icon-button quiet" aria-label={`编辑${label}`} title="编辑" disabled={element.locked} onClick={() => editLayerAdjustment(element, adjustment.id)}><Pencil size={13} /></button>
              )}
              <button type="button" className="icon-button quiet" aria-label="上移" title="上移（后应用）" disabled={element.locked || index === list.length - 1} onClick={() => move(adjustment.id, 1)}><ArrowDown size={13} /></button>
              <button type="button" className="icon-button quiet" aria-label="下移" title="下移（先应用）" disabled={element.locked || index === 0} onClick={() => move(adjustment.id, -1)}><ArrowUp size={13} /></button>
              <button type="button" className="icon-button quiet" aria-label={`删除${label}`} title="删除" disabled={element.locked}
                onClick={() => void changeLayerAdjustments(element, (current) => current.filter((candidate) => candidate.id !== adjustment.id), `删除${label}`)}><Trash2 size={13} /></button>
            </li>
            )
          })}
        </ol>
      )}
      <label className="wide-field">
        <span>添加调整</span>
        <select aria-label="添加调整" value="" disabled={element.locked} onChange={(event) => {
          const kind = event.currentTarget.value as AdjustmentKind
          if (kind.length > 0) void adjustSelectedLayer(kind)
        }}>
          <option value="">选择…</option>
          {ADJUSTMENT_KINDS.map((kind) => <option key={kind} value={kind}>{ADJUSTMENT_LABELS[kind]}{SHORTCUTS[kind] === undefined ? '' : `（${SHORTCUTS[kind]}）`}</option>)}
        </select>
      </label>
      <label className="wide-field">
        <span>添加滤镜</span>
        <select aria-label="添加滤镜" value="" disabled={element.locked} onChange={(event) => {
          const kind = event.currentTarget.value as FilterKind
          if (kind.length > 0) filterSelectedLayer(kind)
        }}>
          <option value="">选择…</option>
          {FILTER_KINDS.map((kind) => <option key={kind} value={kind}>{FILTER_LABELS[kind]}</option>)}
        </select>
      </label>
    </div>
  )
}

/** How long the picture must stay still before the histogram below an adjustment layer is measured again. */
const HISTOGRAM_SETTLE_MS = 400

/**
 * An adjustment layer's settings, as Photoshop's properties panel shows
 * them: the canvas follows the controls as they move, and letting go
 * records one step.
 */
export function AdjustmentLayerSection({ element }: { readonly element: AdjustmentLayer }): React.JSX.Element {
  const settings = useAdjustmentPreview((state) => adjustmentLayerSettings(element, state.preview))
  const revision = useWorkspaceStore((state) => state.scene.revision)
  const [histogram, setHistogram] = useState<Histogram | null>(null)
  const measures = settings.kind === 'levels' || settings.kind === 'curves'
  useEffect(() => {
    if (!measures) return
    let current = true
    const timer = window.setTimeout(() => {
      void belowHistogram(element).then((counts) => { if (current) setHistogram(counts) })
    }, HISTOGRAM_SETTLE_MS)
    return () => { current = false; window.clearTimeout(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- measured again when the picture changes, not on every preview
  }, [element.id, measures, revision])
  return (
    <div className="inspector-section adjustment-section">
      <p className="section-kicker">{ADJUSTMENT_LABELS[settings.kind]}</p>
      <p className="field-note">调整下面所有的图层。只调一部分时，给它加蒙版，或在有选区时新建。</p>
      <fieldset className="adjustment-fieldset" disabled={element.locked}>
        <AdjustmentControls settings={settings} histogram={histogram} onChange={(next, final) => void setAdjustmentLayerSettings(element, next, final)} />
      </fieldset>
    </div>
  )
}
