import { Check, FlipHorizontal2, FlipVertical2, RotateCcw, RotateCw, X } from 'lucide-react'
import { FREE_TRANSFORM_MODES, useFreeTransform } from '../canvas/free-transform-store'

/*
 * Free transform's options, in the options bar beside the canvas size as
 * Photoshop's are: the four modes (scale, skew, distort, perspective, which
 * Ctrl and Ctrl+Alt+Shift also give while dragging), flips and turns, and
 * cancel or apply.
 */

export function FreeTransformBar(): React.JSX.Element | null {
  const session = useFreeTransform((state) => state.session)
  if (session === null) return null
  const { setMode, flip, rotate, apply, cancel } = useFreeTransform.getState()
  return (
    <div className="free-transform-options" role="toolbar" aria-label="自由变换" data-testid="free-transform-bar">
      <span className="free-transform-modes" role="radiogroup" aria-label="变换方式" title="Ctrl 拖角扭曲 · Ctrl 拖边斜切 · Ctrl+Alt+Shift 拖角透视">
        {FREE_TRANSFORM_MODES.map(({ mode, label }) => (
          <button key={mode} type="button" role="radio" aria-checked={session.mode === mode}
            disabled={(mode === 'distort' || mode === 'perspective') ? session.reach !== 'full' : mode === 'skew' ? session.reach === 'box' : false}
            onClick={() => setMode(mode)}>{label}</button>
        ))}
      </span>
      <button type="button" aria-label="水平翻转" title="水平翻转" onClick={() => flip('horizontal')} disabled={session.reach === 'box'}><FlipHorizontal2 size={13} /></button>
      <button type="button" aria-label="垂直翻转" title="垂直翻转" onClick={() => flip('vertical')} disabled={session.reach === 'box'}><FlipVertical2 size={13} /></button>
      <button type="button" aria-label="旋转 180 度" title="旋转 180°" onClick={() => rotate(180)}>180°</button>
      <button type="button" aria-label="顺时针旋转 90 度" title="顺时针旋转 90°" onClick={() => rotate(90)}><RotateCw size={13} /></button>
      <button type="button" aria-label="逆时针旋转 90 度" title="逆时针旋转 90°" onClick={() => rotate(-90)}><RotateCcw size={13} /></button>
      <button type="button" aria-label="取消变换" title="取消（Esc）" onClick={cancel}><X size={13} /></button>
      <button type="button" className="is-primary" aria-label="应用变换" title="应用（Enter）" onClick={() => { void apply() }}><Check size={13} /></button>
    </div>
  )
}
