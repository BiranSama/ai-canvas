import { Sparkles, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { maskBounds } from '../../../shared/mask-raster'
import { submitGenerativeFill } from './generative-fill'
import { useSelectionStore } from './selection-store'

/*
 * Photoshop's Generative Fill under the selection: a sentence of what to
 * paint, or nothing to fill from what is around it. The image service
 * repaints only the selected part of the picture; the result comes back as
 * a new layer masked by the selection, placed from the generation view.
 */

const BAR_WIDTH = 360
const BAR_HEIGHT = 40

interface GenerativeFillBarProps {
  /** The artboard on the stage, and the stage pixels per canvas pixel. */
  readonly originX: number
  readonly originY: number
  readonly zoom: number
  readonly stageWidth: number
  readonly stageHeight: number
}

export function GenerativeFillBar({ originX, originY, zoom, stageWidth, stageHeight }: GenerativeFillBarProps): React.JSX.Element | null {
  const mask = useSelectionStore((state) => state.mask)
  const version = useSelectionStore((state) => state.version)
  const [open, setOpen] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [dismissed, setDismissed] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const bounds = useMemo(() => mask === null ? null : maskBounds(mask), [mask])
  if (mask === null || bounds === null || dismissed === version) return null

  const below = originY + (bounds.y + bounds.height) * zoom + 12
  const top = below + BAR_HEIGHT <= stageHeight - 8 ? below : Math.max(8, originY + bounds.y * zoom - BAR_HEIGHT - 12)
  const left = Math.max(8, Math.min(stageWidth - BAR_WIDTH - 8, originX + (bounds.x + bounds.width / 2) * zoom - BAR_WIDTH / 2))

  const submit = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const selection = useSelectionStore.getState().mask
      if (selection === null) return
      if (await submitGenerativeFill(selection, prompt)) {
        setOpen(false)
        setPrompt('')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="generative-fill-bar glass-surface"
      role="toolbar"
      aria-label="选区操作"
      style={{ left, top, width: open ? BAR_WIDTH : undefined }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {open ? (
        <form className="generative-fill-form" onSubmit={(event) => { event.preventDefault(); void submit() }}>
          <input
            aria-label="生成式填充描述"
            autoFocus
            placeholder="要画什么？留空则按周围画面补全"
            value={prompt}
            maxLength={2000}
            onChange={(event) => setPrompt(event.currentTarget.value)}
            onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); event.currentTarget.blur(); setOpen(false) } }}
          />
          <button type="submit" className="is-primary" disabled={busy}>{busy ? '正在提交' : '生成'}</button>
        </form>
      ) : (
        <button type="button" className="generative-fill-open" onClick={() => setOpen(true)}><Sparkles size={13} aria-hidden="true" />生成式填充</button>
      )}
      <button type="button" className="generative-fill-close" aria-label="收起选区操作" title="收起" onClick={() => { setOpen(false); setDismissed(version) }}><X size={12} /></button>
    </div>
  )
}
