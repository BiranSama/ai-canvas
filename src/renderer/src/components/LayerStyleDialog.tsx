import { useEffect, useRef, useState } from 'react'
import type { BlendMode, LayerStyle, LayerStyleKind } from '../../../domain'
import { LAYER_STYLE_LABELS, LAYER_STYLE_ORDER } from '../../../shared/layer-styles'
import { useModalScope } from '../interaction/use-modal-scope'
import { commitLayerStyle, isStylable, startingStyle, useStyleDialog, useStylePreview, type StyleDialogState } from '../layer-styles/style-actions'
import { useWorkspaceStore } from '../store/workspace-store'
import { AdjustSlider } from './AdjustmentControls'
import { BlendModeOptions } from './BlendModeOptions'

/*
 * Photoshop's 图层样式 dialog: the styles on the left, each with its switch,
 * the one picked on the right with its settings. The canvas shows them as
 * they change; 确定 records one step, 取消 leaves the layer as it was.
 */

type Change = (next: LayerStyle) => void

function ColorField({ label, value, onChange }: { readonly label: string; readonly value: string; readonly onChange: (color: string) => void }): React.JSX.Element {
  return (
    <label className="adjust-row is-select">
      <span>{label}</span>
      <input type="color" aria-label={label} value={value.toLowerCase()} onChange={(event) => onChange(event.currentTarget.value.toUpperCase())} />
    </label>
  )
}

function BlendField({ value, onChange }: { readonly value: BlendMode; readonly onChange: (mode: BlendMode) => void }): React.JSX.Element {
  return (
    <label className="adjust-row is-select">
      <span>混合模式</span>
      <select aria-label="混合模式" value={value} onChange={(event) => onChange(event.currentTarget.value as BlendMode)}><BlendModeOptions /></select>
    </label>
  )
}

const percent = (value: number): number => Math.round(value * 100)

function StyleControls({ kind, style, onChange }: { readonly kind: LayerStyleKind; readonly style: LayerStyle; readonly onChange: Change }): React.JSX.Element {
  switch (kind) {
    case 'dropShadow':
    case 'innerShadow': {
      const entry = style[kind]!
      const set = (patch: Partial<typeof entry>): void => onChange({ ...style, [kind]: { ...entry, ...patch } })
      const amount = 'spread' in entry ? entry.spread : entry.choke
      return (
        <div className="adjust-controls">
          <BlendField value={entry.blendMode} onChange={(blendMode) => set({ blendMode })} />
          <ColorField label="颜色" value={entry.color} onChange={(color) => set({ color })} />
          <AdjustSlider label="不透明度（%）" min={0} max={100} value={percent(entry.opacity)} onChange={(value) => set({ opacity: value / 100 })} />
          <AdjustSlider label="角度（度）" min={-180} max={180} value={entry.angle} onChange={(angle) => set({ angle })} />
          <AdjustSlider label="距离（像素）" min={0} max={3000} value={entry.distance} onChange={(distance) => set({ distance })} />
          <AdjustSlider label={kind === 'dropShadow' ? '扩展（%）' : '阻塞（%）'} min={0} max={100} value={amount}
            onChange={(value) => set((kind === 'dropShadow' ? { spread: value } : { choke: value }) as Partial<typeof entry>)} />
          <AdjustSlider label="大小（像素）" min={0} max={250} value={entry.size} onChange={(size) => set({ size })} />
        </div>
      )
    }
    case 'outerGlow': {
      const entry = style.outerGlow!
      const set = (patch: Partial<typeof entry>): void => onChange({ ...style, outerGlow: { ...entry, ...patch } })
      return (
        <div className="adjust-controls">
          <BlendField value={entry.blendMode} onChange={(blendMode) => set({ blendMode })} />
          <ColorField label="颜色" value={entry.color} onChange={(color) => set({ color })} />
          <AdjustSlider label="不透明度（%）" min={0} max={100} value={percent(entry.opacity)} onChange={(value) => set({ opacity: value / 100 })} />
          <AdjustSlider label="扩展（%）" min={0} max={100} value={entry.spread} onChange={(spread) => set({ spread })} />
          <AdjustSlider label="大小（像素）" min={0} max={250} value={entry.size} onChange={(size) => set({ size })} />
        </div>
      )
    }
    case 'stroke': {
      const entry = style.stroke!
      const set = (patch: Partial<typeof entry>): void => onChange({ ...style, stroke: { ...entry, ...patch } })
      return (
        <div className="adjust-controls">
          <AdjustSlider label="大小（像素）" min={1} max={250} value={entry.size} onChange={(size) => set({ size })} />
          <label className="adjust-row is-select">
            <span>位置</span>
            <select aria-label="位置" value={entry.position} onChange={(event) => set({ position: event.currentTarget.value as typeof entry.position })}>
              <option value="outside">外部</option>
              <option value="inside">内部</option>
              <option value="center">居中</option>
            </select>
          </label>
          <ColorField label="颜色" value={entry.color} onChange={(color) => set({ color })} />
          <AdjustSlider label="不透明度（%）" min={0} max={100} value={percent(entry.opacity)} onChange={(value) => set({ opacity: value / 100 })} />
        </div>
      )
    }
    case 'colorOverlay': {
      const entry = style.colorOverlay!
      const set = (patch: Partial<typeof entry>): void => onChange({ ...style, colorOverlay: { ...entry, ...patch } })
      return (
        <div className="adjust-controls">
          <BlendField value={entry.blendMode} onChange={(blendMode) => set({ blendMode })} />
          <ColorField label="颜色" value={entry.color} onChange={(color) => set({ color })} />
          <AdjustSlider label="不透明度（%）" min={0} max={100} value={percent(entry.opacity)} onChange={(value) => set({ opacity: value / 100 })} />
        </div>
      )
    }
    case 'gradientOverlay': {
      const entry = style.gradientOverlay!
      const set = (patch: Partial<typeof entry>): void => onChange({ ...style, gradientOverlay: { ...entry, ...patch } })
      const stops = [...entry.stops].sort((a, b) => a.offset - b.offset)
      const setStop = (index: number, patch: Partial<(typeof stops)[number]>): void => set({ stops: stops.map((stop, at) => at === index ? { ...stop, ...patch } : stop) })
      return (
        <div className="adjust-controls">
          <BlendField value={entry.blendMode} onChange={(blendMode) => set({ blendMode })} />
          <AdjustSlider label="不透明度（%）" min={0} max={100} value={percent(entry.opacity)} onChange={(value) => set({ opacity: value / 100 })} />
          <div className="gradient-preview" aria-hidden="true" style={{ background: `linear-gradient(90deg, ${stops.map((stop) => `${stop.color} ${percent(stop.offset)}%`).join(', ')})` }} />
          {stops.map((stop, index) => (
            <div className="gradient-stop" key={index}>
              <input type="color" aria-label={`色标 ${index + 1} 颜色`} value={stop.color.toLowerCase()} onChange={(event) => setStop(index, { color: event.currentTarget.value.toUpperCase() })} />
              <AdjustSlider label={`色标 ${index + 1}（%）`} min={0} max={100} value={percent(stop.offset)} onChange={(value) => setStop(index, { offset: value / 100 })} />
              <button type="button" className="icon-button quiet" aria-label={`删除色标 ${index + 1}`} disabled={stops.length <= 2} onClick={() => set({ stops: stops.filter((_, at) => at !== index) })}>−</button>
            </div>
          ))}
          <button type="button" className="text-action" disabled={stops.length >= 8} onClick={() => set({ stops: [...stops, { offset: 0.5, color: stops[0]!.color }] })}>添加色标</button>
          <label className="checkbox-field"><input type="checkbox" checked={entry.reverse} onChange={(event) => set({ reverse: event.currentTarget.checked })} /><span>反向</span></label>
          <label className="adjust-row is-select">
            <span>样式</span>
            <select aria-label="样式" value={entry.style} onChange={(event) => set({ style: event.currentTarget.value as typeof entry.style })}>
              <option value="linear">线性</option>
              <option value="radial">径向</option>
            </select>
          </label>
          <AdjustSlider label="角度（度）" min={-180} max={180} value={entry.angle} onChange={(angle) => set({ angle })} />
          <AdjustSlider label="缩放（%）" min={10} max={150} value={entry.scale} onChange={(scale) => set({ scale })} />
        </div>
      )
    }
  }
}

function DialogBody({ open }: { readonly open: StyleDialogState }): React.JSX.Element {
  const close = useStyleDialog((state) => state.close)
  const element = useWorkspaceStore((state) => state.scene.elements.find((candidate) => candidate.id === open.elementId))
  const [style, setStyle] = useState<LayerStyle>(() => {
    const own = isStylable(element) ? element.style ?? {} : {}
    return { ...own, [open.kind]: { ...startingStyle(own, open.kind), enabled: true } }
  })
  const [kind, setKind] = useState<LayerStyleKind>(open.kind)
  const [busy, setBusy] = useState(false)
  const ref = useRef<HTMLFormElement>(null)
  const confirm = useRef<HTMLButtonElement>(null)

  useEffect(() => { useStylePreview.getState().show(open.elementId, style) }, [open.elementId, style])
  useEffect(() => () => useStylePreview.getState().clear(open.elementId), [open.elementId])

  const cancel = (): void => {
    useStylePreview.getState().clear(open.elementId)
    close()
  }
  useModalScope(ref, cancel, { initialFocus: confirm })

  const toggle = (which: LayerStyleKind, on: boolean): void => {
    setStyle((current) => ({ ...current, [which]: { ...startingStyle(current, which), enabled: on } }))
    setKind(which)
  }

  return (
    <div className="adjustment-dialog-layer" role="presentation">
      <form
        ref={ref}
        className="edit-dialog adjustment-dialog layer-style-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="图层样式"
        onSubmit={(event) => {
          event.preventDefault()
          if (busy) return
          setBusy(true)
          void commitLayerStyle(open.elementId, style, '图层样式').finally(() => {
            useStylePreview.getState().clear(open.elementId)
            close()
          })
        }}
      >
        <h2>图层样式</h2>
        {element !== undefined && <p className="field-note">{`「${element.name}」`}</p>}
        <div className="layer-style-body">
          <ul className="layer-style-list" aria-label="样式">
            {LAYER_STYLE_ORDER.map((which) => (
              <li key={which} className={which === kind ? 'is-current' : ''}>
                <input type="checkbox" aria-label={`启用${LAYER_STYLE_LABELS[which]}`} checked={style[which]?.enabled === true} onChange={(event) => toggle(which, event.currentTarget.checked)} />
                <button type="button" onClick={() => { if (style[which] === undefined) toggle(which, true); else setKind(which) }}>{LAYER_STYLE_LABELS[which]}</button>
              </li>
            ))}
          </ul>
          <div className="layer-style-settings">
            <p className="section-kicker">{LAYER_STYLE_LABELS[kind]}</p>
            {style[kind] === undefined
              ? <p className="field-note">勾选左边的「{LAYER_STYLE_LABELS[kind]}」来加上它。</p>
              : <StyleControls kind={kind} style={style} onChange={setStyle} />}
          </div>
        </div>
        <footer>
          <button type="button" onClick={cancel}>取消</button>
          <button ref={confirm} type="submit" className="is-primary" disabled={busy}>确定</button>
        </footer>
      </form>
    </div>
  )
}

export function LayerStyleDialog(): React.JSX.Element | null {
  const open = useStyleDialog((state) => state.open)
  return open === null ? null : <DialogBody key={`${open.elementId}:${open.kind}`} open={open} />
}
