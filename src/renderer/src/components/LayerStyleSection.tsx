import { Eye, EyeOff, Pencil, Trash2 } from 'lucide-react'
import type { LayerStyleKind } from '../../../domain'
import { describeLayerStyle, LAYER_STYLE_LABELS, LAYER_STYLE_ORDER } from '../../../shared/layer-styles'
import { openLayerStyle, removeLayerStyle, toggleLayerStyle, type StylableElement } from '../layer-styles/style-actions'

/**
 * A layer's styles in the properties, as Photoshop lists them under the
 * layer: each can be turned off, opened in the 图层样式 dialog or taken out.
 */
export function LayerStyleSection({ element }: { readonly element: StylableElement }): React.JSX.Element {
  const kinds = LAYER_STYLE_ORDER.filter((kind) => element.style?.[kind] !== undefined)
  return (
    <div className="inspector-section adjustment-section layer-style-section">
      <p className="section-kicker">图层样式</p>
      {kinds.length === 0 && <p className="field-note">投影、描边、外发光等，不改图层本身，随时能关掉。</p>}
      {kinds.length > 0 && (
        <ul className="adjustment-list" aria-label="这一层的图层样式">
          {kinds.map((kind) => {
            const entry = element.style![kind]!
            const label = LAYER_STYLE_LABELS[kind]
            return (
              <li key={kind} className={entry.enabled ? '' : 'is-off'}>
                <button type="button" className="icon-button quiet" aria-label={entry.enabled ? `关闭${label}` : `打开${label}`} title={entry.enabled ? '关闭' : '打开'} disabled={element.locked}
                  onClick={() => void toggleLayerStyle(element, kind)}>{entry.enabled ? <Eye size={13} /> : <EyeOff size={13} />}</button>
                <span className="adjustment-name" title={describeLayerStyle({ [kind]: { ...entry, enabled: true } })}>{label}</span>
                <button type="button" className="icon-button quiet" aria-label={`编辑${label}`} title="编辑" disabled={element.locked} onClick={() => openLayerStyle(element.id, kind)}><Pencil size={13} /></button>
                <button type="button" className="icon-button quiet" aria-label={`删除${label}`} title="删除" disabled={element.locked} onClick={() => void removeLayerStyle(element, kind)}><Trash2 size={13} /></button>
              </li>
            )
          })}
        </ul>
      )}
      <label className="wide-field">
        <span>添加图层样式</span>
        <select aria-label="添加图层样式" value="" disabled={element.locked} onChange={(event) => {
          const kind = event.currentTarget.value as LayerStyleKind
          if (kind.length > 0) openLayerStyle(element.id, kind)
        }}>
          <option value="">选择…</option>
          {LAYER_STYLE_ORDER.map((kind) => <option key={kind} value={kind}>{LAYER_STYLE_LABELS[kind]}</option>)}
        </select>
      </label>
    </div>
  )
}
