import { ArrowLeftRight, Check, X } from 'lucide-react'
import { CROP_RATIOS, cropAspect, frameExtends, useCrop, type CropRatio } from '../canvas/crop-store'

/*
 * The crop tool's options, in the options bar beside the canvas size as
 * Photoshop's are: the ratio, the frame's size in pixels, what fills area
 * the frame adds (the background colour or 生成式扩展, with what to paint),
 * and reset or apply. Enter in a field applies too.
 */

const MIN_SIDE = 64
const MAX_SIDE = 16384

function clampSide(value: number): number {
  return Math.max(MIN_SIDE, Math.min(MAX_SIDE, value))
}

export function CropOptionsBar(): React.JSX.Element | null {
  const frame = useCrop((state) => state.frame)
  const ratio = useCrop((state) => state.ratio)
  const portrait = useCrop((state) => state.portrait)
  const fill = useCrop((state) => state.fill)
  const prompt = useCrop((state) => state.prompt)
  const busy = useCrop((state) => state.busy)
  if (frame === null) return null
  const { setFrame, setRatio, setFill, setPrompt, commit, reset } = useCrop.getState()
  const setSize = (axis: 'width' | 'height', value: number): void => {
    if (!Number.isFinite(value) || value <= 0) return
    const aspect = cropAspect(ratio, portrait)
    const next = clampSide(Math.round(value))
    const width = axis === 'width' ? next : aspect === null ? frame.width : clampSide(next * aspect)
    const height = axis === 'height' ? next : aspect === null ? frame.height : clampSide(next / aspect)
    setFrame({ left: frame.left + (frame.width - width) / 2, top: frame.top + (frame.height - height) / 2, width, height })
  }
  const applyOnEnter = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
    event.preventDefault()
    // Out of the field, so Ctrl+Z and the tool keys reach the canvas again.
    event.currentTarget.blur()
    void commit()
  }
  const grows = frameExtends(frame)
  return (
    <div className="crop-options" role="toolbar" aria-label="裁剪" data-testid="crop-bar">
      <select aria-label="裁剪比例" value={ratio} onChange={(event) => setRatio(event.currentTarget.value as CropRatio)}>
        {CROP_RATIOS.map(({ key, label }) => <option key={key} value={key}>{label}</option>)}
      </select>
      <button type="button" aria-label="横竖互换" title="横竖互换" disabled={ratio === 'free'} onClick={() => setRatio(ratio, !portrait)}><ArrowLeftRight size={12} /></button>
      <input aria-label="裁剪宽度" title="宽（像素）" type="number" min={MIN_SIDE} max={MAX_SIDE} value={Math.round(frame.width)} onChange={(event) => setSize('width', Number(event.currentTarget.value))} onKeyDown={applyOnEnter} />
      <span className="crop-times" aria-hidden="true">×</span>
      <input aria-label="裁剪高度" title="高（像素）" type="number" min={MIN_SIDE} max={MAX_SIDE} value={Math.round(frame.height)} onChange={(event) => setSize('height', Number(event.currentTarget.value))} onKeyDown={applyOnEnter} />
      <select aria-label="扩出部分填充" title="画布扩出的部分怎么填" value={fill} onChange={(event) => setFill(event.currentTarget.value as 'background' | 'generative')}>
        <option value="background">扩出：背景色</option>
        <option value="generative">扩出：生成式扩展</option>
      </select>
      {fill === 'generative' && grows && (
        <input className="crop-prompt" aria-label="生成式扩展描述" placeholder="扩出什么？留空按周围延伸" value={prompt} maxLength={2000} onChange={(event) => setPrompt(event.currentTarget.value)} onKeyDown={applyOnEnter} />
      )}
      <button type="button" aria-label="复位裁剪框" title="复位（Esc）" onClick={reset} disabled={busy}><X size={13} /></button>
      <button type="button" className="is-primary" aria-label="应用裁剪" title="应用（Enter）" onClick={() => { void commit() }} disabled={busy}><Check size={13} /></button>
    </div>
  )
}
