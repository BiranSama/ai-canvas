import { Ruler } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { MAX_GUIDES, type Guide } from '../../../domain'
import { editGuides, useView } from '../canvas/view-store'
import { useWorkspaceStore } from '../store/workspace-store'

/*
 * Photoshop's 视图 menu in small: rulers, guides, grid and snapping, the
 * grid's spacing, a guide at an exact place (新建参考线), and clearing them.
 */

const SWITCHES = [
  { key: 'rulers', label: '标尺', keys: 'Ctrl+R' },
  { key: 'guides', label: '参考线', keys: 'Ctrl+;' },
  { key: 'grid', label: '网格', keys: "Ctrl+'" },
  { key: 'snap', label: '对齐', keys: 'Ctrl+Shift+;' }
] as const

const NO_GUIDES: readonly Guide[] = []

export function ViewMenu(): React.JSX.Element {
  const view = useView()
  const stored = useWorkspaceStore((state) => state.scene.canvas.guides)
  const guides = stored ?? NO_GUIDES
  const [open, setOpen] = useState(false)
  const [place, setPlace] = useState<{ x: number; y: number } | null>(null)
  const [axis, setAxis] = useState<Guide['axis']>('x')
  const [position, setPosition] = useState('')
  const button = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent): void => {
      if (!panel.current?.contains(event.target as Node) && !button.current?.contains(event.target as Node)) setOpen(false)
    }
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape') setOpen(false) }
    window.addEventListener('pointerdown', close, true)
    window.addEventListener('keydown', escape, true)
    return () => {
      window.removeEventListener('pointerdown', close, true)
      window.removeEventListener('keydown', escape, true)
    }
  }, [open])

  const toggleOpen = (): void => {
    const rect = button.current?.getBoundingClientRect()
    // Below the button, in the options bar at the top of the canvas.
    if (rect !== undefined) setPlace({ x: Math.max(12, Math.min(window.innerWidth - 248, rect.left)), y: rect.bottom + 8 })
    setOpen((value) => !value)
  }

  const value = Number(position)
  const canAdd = position.trim() !== '' && Number.isFinite(value) && guides.length < MAX_GUIDES

  return (
    <>
      <button ref={button} type="button" className="view-menu-button" aria-label="视图" aria-expanded={open} title="视图：标尺、参考线、网格、对齐" onClick={toggleOpen}><Ruler size={14} /></button>
      {open && place !== null && createPortal(
        <div ref={panel} className="view-menu glass-surface" role="dialog" aria-label="视图设置" style={{ left: place.x, top: place.y }}>
          {SWITCHES.map(({ key, label, keys }) => (
            <label key={key} className="view-menu-switch">
              <input type="checkbox" checked={view[key]} onChange={() => view.toggle(key)} />
              <span>{label}</span>
              <kbd>{keys}</kbd>
            </label>
          ))}
          <div className="view-menu-row">
            <label><span>网格间距</span><input aria-label="网格间距" type="number" min={2} max={4096} value={view.gridSpacing} onChange={(event) => view.setGrid(Number(event.currentTarget.value) || view.gridSpacing, view.gridDivisions)} /></label>
            <label><span>子网格</span><input aria-label="子网格" type="number" min={1} max={32} value={view.gridDivisions} onChange={(event) => view.setGrid(view.gridSpacing, Number(event.currentTarget.value) || view.gridDivisions)} /></label>
          </div>
          <form className="view-menu-row" onSubmit={(event) => {
            event.preventDefault()
            if (!canAdd) return
            void editGuides('新建参考线', (current) => [...current, { axis, position: Math.round(value) }])
            if (!view.guides) view.toggle('guides')
            setPosition('')
          }}>
            <select aria-label="参考线方向" value={axis} onChange={(event) => setAxis(event.currentTarget.value as Guide['axis'])}>
              <option value="x">垂直参考线</option>
              <option value="y">水平参考线</option>
            </select>
            <input aria-label="参考线位置" type="number" placeholder="像素" value={position} onChange={(event) => setPosition(event.currentTarget.value)} />
            <button type="submit" disabled={!canAdd}>新建</button>
          </form>
          <button type="button" className="view-menu-clear" disabled={guides.length === 0} onClick={() => void editGuides('清除参考线', (current) => current.length === 0 ? null : [])}>清除参考线（{guides.length}）</button>
        </div>,
        document.body
      )}
    </>
  )
}
