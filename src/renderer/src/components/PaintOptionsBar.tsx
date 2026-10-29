import { Lock, LockOpen } from 'lucide-react'
import { useRef } from 'react'
import type { SceneElement } from '../../../domain'
import { useWorkspaceStore, type PaintTool } from '../store/workspace-store'

/*
 * Photoshop's options bar for the painting tools: the brush's size,
 * hardness, opacity and flow, the bucket's tolerance, the gradient's
 * shape, and the selected layer's transparency lock. Every value here also
 * has its Photoshop key ([ ], Shift+[ ], digits, /).
 */

const TOOL_NAMES: Readonly<Record<PaintTool, string>> = { brush: '画笔', eraser: '橡皮擦', bucket: '油漆桶', gradient: '渐变' }

interface AmountProps {
  readonly label: string
  readonly value: number
  readonly min: number
  readonly max: number
  readonly unit: string
  onChange(value: number): void
}

/** A number field whose label drags the value left and right, Photoshop's scrubby slider. */
export function Amount({ label, value, min, max, unit, onChange }: AmountProps): React.JSX.Element {
  const clamp = (next: number): number => Math.max(min, Math.min(max, Math.round(next)))
  const scrub = useRef<{ readonly x: number; readonly value: number } | null>(null)
  return (
    <span className="paint-amount">
      <span
        className="paint-amount-label"
        title={`左右拖动调整${label}`}
        onPointerDown={(event) => {
          if (event.button !== 0) return
          event.preventDefault()
          event.currentTarget.setPointerCapture(event.pointerId)
          scrub.current = { x: event.clientX, value }
        }}
        onPointerMove={(event) => {
          const start = scrub.current
          // Shift scrubs ten times faster, as in Photoshop.
          if (start !== null) onChange(clamp(start.value + (event.clientX - start.x) * (event.shiftKey ? 10 : 1)))
        }}
        onPointerUp={() => { scrub.current = null }}
        onPointerCancel={() => { scrub.current = null }}
      >
        {label}
      </span>
      <span className="paint-amount-field">
        <input
          type="number"
          aria-label={label}
          min={min}
          max={max}
          value={value}
          onChange={(event) => { if (event.currentTarget.value !== '') onChange(clamp(Number(event.currentTarget.value))) }}
          // Enter or Escape hands the keys back to the canvas, as Photoshop's options bar does.
          onKeyDown={(event) => { if (event.key === 'Enter' || event.key === 'Escape') event.currentTarget.blur() }}
        />
        {unit !== '' && <i aria-hidden="true">{unit}</i>}
      </span>
    </span>
  )
}

const percent = (value: number): number => Math.round(value * 100)

export function PaintOptionsBar({ tool }: { readonly tool: PaintTool }): React.JSX.Element {
  const settings = useWorkspaceStore((state) => state.paintSettings)
  const setPaintSettings = useWorkspaceStore((state) => state.setPaintSettings)
  const target = useWorkspaceStore((state) => {
    if (state.selectedIds.length !== 1) return null
    return state.scene.elements.find((element) => element.id === state.selectedIds[0]) ?? null
  })
  const updateElement = useWorkspaceStore((state) => state.updateElement)
  const image = target?.type === 'image' ? target as Extract<SceneElement, { type: 'image' }> : null
  const locked = image?.transparencyLocked === true

  return (
    <div className="paint-options" role="toolbar" aria-label={`${TOOL_NAMES[tool]}选项`}>
      {(tool === 'brush' || tool === 'eraser') && (
        <>
          <Amount label="大小" unit="px" min={1} max={5000} value={Math.round(settings[tool].size)} onChange={(size) => setPaintSettings(tool, { size })} />
          <Amount label="硬度" unit="%" min={0} max={100} value={percent(settings[tool].hardness)} onChange={(value) => setPaintSettings(tool, { hardness: value / 100 })} />
          <Amount label="不透明度" unit="%" min={1} max={100} value={percent(settings[tool].opacity)} onChange={(value) => setPaintSettings(tool, { opacity: value / 100 })} />
          <Amount label="流量" unit="%" min={1} max={100} value={percent(settings[tool].flow)} onChange={(value) => setPaintSettings(tool, { flow: value / 100 })} />
        </>
      )}
      {tool === 'bucket' && (
        <>
          <Amount label="容差" unit="" min={0} max={255} value={settings.bucket.tolerance} onChange={(tolerance) => setPaintSettings('bucket', { tolerance })} />
          <label className="paint-check"><input type="checkbox" checked={settings.bucket.contiguous} onChange={(event) => setPaintSettings('bucket', { contiguous: event.currentTarget.checked })} />连续的</label>
          <Amount label="不透明度" unit="%" min={1} max={100} value={percent(settings.bucket.opacity)} onChange={(value) => setPaintSettings('bucket', { opacity: value / 100 })} />
        </>
      )}
      {tool === 'gradient' && (
        <>
          <span className="paint-segmented" role="radiogroup" aria-label="渐变形状">
            {(['linear', 'radial'] as const).map((shape) => (
              <button key={shape} type="button" role="radio" aria-checked={settings.gradient.shape === shape} onClick={() => setPaintSettings('gradient', { shape })}>{shape === 'linear' ? '线性' : '径向'}</button>
            ))}
          </span>
          <Amount label="不透明度" unit="%" min={1} max={100} value={percent(settings.gradient.opacity)} onChange={(value) => setPaintSettings('gradient', { opacity: value / 100 })} />
        </>
      )}
      <button
        type="button"
        className="paint-lock"
        aria-label="锁定透明像素"
        aria-pressed={locked}
        aria-keyshortcuts="/"
        disabled={image === null || image.locked}
        title={image === null ? '锁定透明像素 /（先选中一个图片图层）' : `${locked ? '解锁' : '锁定'}「${image.name}」的透明像素 /`}
        onClick={() => { if (image !== null) void updateElement(image.id, { transparencyLocked: !locked }, locked ? '解锁透明像素' : '锁定透明像素') }}
      >
        {locked ? <Lock size={14} aria-hidden="true" /> : <LockOpen size={14} aria-hidden="true" />}
        <span className="paint-lock-checker" aria-hidden="true" />
      </button>
    </div>
  )
}
