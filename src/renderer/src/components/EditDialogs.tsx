import { useRef, useState } from 'react'
import { useModalScope } from '../interaction/use-modal-scope'
import { fillLayer } from '../canvas/paint-controller'
import { featherSelection } from '../selection/selection-actions'
import { useWorkspaceStore } from '../store/workspace-store'
import { showAppNotice } from './app-notice'
import { useEditDialog } from './edit-dialog-store'

/*
 * Photoshop's small edit dialogs: Shift+F6 feathers the selection, Shift+F5
 * fills the selected layer (inside the selection when there is one).
 */


/** Remembered between openings, as Photoshop remembers them. */
let lastFeather = 10
let lastFill: { readonly use: 'foreground' | 'background' | 'color'; readonly color: string; readonly opacity: number } = { use: 'foreground', color: '#808080', opacity: 100 }

function FeatherDialog({ onClose }: { readonly onClose: () => void }): React.JSX.Element {
  const ref = useRef<HTMLFormElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const [radius, setRadius] = useState(lastFeather)
  useModalScope(ref, onClose, { initialFocus: input })
  return (
    <div className="settings-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <form
        ref={ref}
        className="edit-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="羽化选区"
        onSubmit={(event) => {
          event.preventDefault()
          lastFeather = radius
          if (!featherSelection(radius)) showAppNotice('没有选区可以羽化。')
          onClose()
        }}
      >
        <h2>羽化选区</h2>
        <label className="edit-dialog-field">
          <span>羽化半径</span>
          <input ref={input} type="number" min={0.1} max={1000} step={0.1} value={radius} onChange={(event) => setRadius(Math.max(0.1, Math.min(1000, Number(event.currentTarget.value) || 0.1)))} />
          <i>像素</i>
        </label>
        <footer>
          <button type="button" onClick={onClose}>取消</button>
          <button type="submit" className="is-primary">确定</button>
        </footer>
      </form>
    </div>
  )
}

function FillDialog({ onClose }: { readonly onClose: () => void }): React.JSX.Element {
  const ref = useRef<HTMLFormElement>(null)
  const first = useRef<HTMLSelectElement>(null)
  const [use, setUse] = useState(lastFill.use)
  const [color, setColor] = useState(lastFill.color)
  const [opacity, setOpacity] = useState(lastFill.opacity)
  useModalScope(ref, onClose, { initialFocus: first })
  return (
    <div className="settings-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <form
        ref={ref}
        className="edit-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="填充"
        onSubmit={(event) => {
          event.preventDefault()
          lastFill = { use, color, opacity }
          const { scene, selectedIds, foregroundColor, backgroundColor } = useWorkspaceStore.getState()
          const element = selectedIds.length === 1 ? scene.elements.find((candidate) => candidate.id === selectedIds[0]) : undefined
          const fillColor = use === 'foreground' ? foregroundColor : use === 'background' ? backgroundColor : color
          onClose()
          if (element === undefined) { showAppNotice('先选中一个图片图层再填充。'); return }
          void fillLayer(element, fillColor, '填充', opacity / 100).then((filled) => {
            if (!filled && element.type !== 'image') showAppNotice(`「${element.name}」要先栅格化才能填充像素。`)
          })
        }}
      >
        <h2>填充</h2>
        <label className="edit-dialog-field">
          <span>内容</span>
          <select ref={first} value={use} onChange={(event) => setUse(event.currentTarget.value as typeof use)}>
            <option value="foreground">前景色</option>
            <option value="background">背景色</option>
            <option value="color">颜色…</option>
          </select>
          {use === 'color' && <input type="color" aria-label="填充颜色" value={color} onChange={(event) => setColor(event.currentTarget.value.toUpperCase())} />}
        </label>
        <label className="edit-dialog-field">
          <span>不透明度</span>
          <input type="number" min={1} max={100} value={opacity} onChange={(event) => setOpacity(Math.max(1, Math.min(100, Math.round(Number(event.currentTarget.value) || 1))))} />
          <i>%</i>
        </label>
        <footer>
          <button type="button" onClick={onClose}>取消</button>
          <button type="submit" className="is-primary">确定</button>
        </footer>
      </form>
    </div>
  )
}

export function EditDialogs(): React.JSX.Element | null {
  const open = useEditDialog((state) => state.open)
  const close = useEditDialog((state) => state.close)
  if (open === 'feather') return <FeatherDialog onClose={close} />
  if (open === 'fill') return <FillDialog onClose={close} />
  return null
}
