import { ArrowDown, ArrowUp, Eye, EyeOff, Pencil, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { ADJUSTMENT_KINDS, type AdjustmentKind, type SceneElement } from '../../../domain'
import { ADJUSTMENT_LABELS, describeAdjustment, type Histogram } from '../../../shared/adjustments'
import { adjustSelectedLayer, belowHistogram, changeLayerAdjustments, editLayerAdjustment, setAdjustmentLayerSettings } from '../adjustments/adjustment-actions'
import { adjustmentLayerSettings, useAdjustmentPreview } from '../canvas/adjustment-preview'
import { useWorkspaceStore } from '../store/workspace-store'
import { AdjustmentControls } from './AdjustmentControls'

type ImageElement = Extract<SceneElement, { type: 'image' }>
type AdjustmentLayer = Extract<SceneElement, { type: 'adjustment' }>

const SHORTCUTS: Partial<Record<AdjustmentKind, string>> = {
  levels: 'Ctrl+L', curves: 'Ctrl+M', 'hue-saturation': 'Ctrl+U', 'color-balance': 'Ctrl+B', 'black-white': 'Ctrl+Alt+Shift+B', invert: 'Ctrl+I', desaturate: 'Ctrl+Shift+U'
}

/**
 * An image layer's own adjustments, oldest first, as they apply: each can
 * be opened again, turned off, moved or taken out. 添加调整 opens the same
 * dialog as the shortcuts.
 */
export function LayerAdjustmentsSection({ element }: { readonly element: ImageElement }): React.JSX.Element {
  const list = element.adjustments ?? []
  const move = (index: number, by: number): void => {
    const next = [...list]
    const [item] = next.splice(index, 1)
    if (item === undefined) return
    next.splice(index + by, 0, item)
    void changeLayerAdjustments(element, next, '调整顺序')
  }
  return (
    <div className="inspector-section adjustment-section">
      <p className="section-kicker">调整</p>
      {list.length === 0 && <p className="field-note">只改这一层的颜色，不改原图。快捷键同 PS：Ctrl+L 色阶、Ctrl+M 曲线、Ctrl+U 色相/饱和度。</p>}
      {list.length > 0 && (
        <ol className="adjustment-list" aria-label="这一层的调整">
          {list.map((adjustment, index) => (
            <li key={adjustment.id} className={adjustment.enabled ? '' : 'is-off'}>
              <button type="button" className="icon-button quiet" aria-label={adjustment.enabled ? `关闭${ADJUSTMENT_LABELS[adjustment.settings.kind]}` : `打开${ADJUSTMENT_LABELS[adjustment.settings.kind]}`} title={adjustment.enabled ? '关闭' : '打开'}
                disabled={element.locked}
                onClick={() => void changeLayerAdjustments(element, list.map((candidate) => candidate.id === adjustment.id ? { ...candidate, enabled: !candidate.enabled } : candidate), adjustment.enabled ? '关闭调整' : '打开调整')}>
                {adjustment.enabled ? <Eye size={13} /> : <EyeOff size={13} />}
              </button>
              <span className="adjustment-name" title={describeAdjustment(adjustment.settings)}>
                {ADJUSTMENT_LABELS[adjustment.settings.kind]}{adjustment.clip !== undefined && <small>选区</small>}
              </span>
              {adjustment.settings.kind !== 'invert' && adjustment.settings.kind !== 'desaturate' && (
                <button type="button" className="icon-button quiet" aria-label={`编辑${ADJUSTMENT_LABELS[adjustment.settings.kind]}`} title="编辑" disabled={element.locked} onClick={() => editLayerAdjustment(element, adjustment.id)}><Pencil size={13} /></button>
              )}
              <button type="button" className="icon-button quiet" aria-label="上移" title="上移（后应用）" disabled={element.locked || index === list.length - 1} onClick={() => move(index, 1)}><ArrowDown size={13} /></button>
              <button type="button" className="icon-button quiet" aria-label="下移" title="下移（先应用）" disabled={element.locked || index === 0} onClick={() => move(index, -1)}><ArrowUp size={13} /></button>
              <button type="button" className="icon-button quiet" aria-label={`删除${ADJUSTMENT_LABELS[adjustment.settings.kind]}`} title="删除" disabled={element.locked}
                onClick={() => void changeLayerAdjustments(element, list.filter((candidate) => candidate.id !== adjustment.id), `删除${ADJUSTMENT_LABELS[adjustment.settings.kind]}`)}><Trash2 size={13} /></button>
            </li>
          ))}
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
