import { ArrowRightLeft, Check, ChevronDown } from 'lucide-react'
import { type CSSProperties, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  calculateOutputSize,
  createCanvasResizeCommands,
  parseAspectRatio,
  type CanvasResizeStrategy
} from '../../../domain'
import { useWorkspaceStore } from '../store/workspace-store'

const presets = ['1:1', '4:5', '3:2', '16:9'] as const

const strategyCopy: Record<CanvasResizeStrategy, { readonly label: string; readonly detail: string }> = {
  'keep-position': { label: '保持位置', detail: '保留元素的标准化位置与尺寸' },
  'fit-content': { label: '适应内容', detail: '缩放并居中，避免现有内容被裁出' },
  'keep-center': { label: '保持中心', detail: '维持像素尺寸，以画布中心扩展或裁切' }
}

export function CanvasSizeControl({ inspector = false }: { readonly inspector?: boolean }): React.JSX.Element {
  const scene = useWorkspaceStore((state) => state.scene)
  const execute = useWorkspaceStore((state) => state.execute)
  const [open, setOpen] = useState(inspector)
  const [ratioInput, setRatioInput] = useState(`${scene.canvas.aspectWidth}:${scene.canvas.aspectHeight}`)
  const [outputWidth, setOutputWidth] = useState(scene.canvas.outputWidth)
  const [outputHeight, setOutputHeight] = useState(scene.canvas.outputHeight)
  const [strategy, setStrategy] = useState<CanvasResizeStrategy>('keep-position')
  const rootRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [panelStyle, setPanelStyle] = useState<CSSProperties>()
  const parsed = parseAspectRatio(ratioInput)

  useLayoutEffect(() => {
    if (!open || inspector) return
    const place = (): void => {
      const root = rootRef.current?.getBoundingClientRect()
      const panel = panelRef.current?.getBoundingClientRect()
      if (root === undefined || panel === undefined) return
      const maxHeight = Math.max(120, window.innerHeight - 32)
      const height = Math.min((panelRef.current?.scrollHeight ?? panel.height) + 2, maxHeight)
      const width = Math.min(316, window.innerWidth - 32)
      const x = Math.max(16, Math.min(root.left, window.innerWidth - width - 16))
      const y = root.bottom + height + 8 <= window.innerHeight - 16 ? root.bottom + 8 : Math.max(16, root.top - height - 8)
      setPanelStyle({ left: x - root.left, top: y - root.top, width, maxHeight })
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [inspector, open])

  useEffect(() => {
    if (!open || inspector) return
    const close = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [inspector, open])

  const chooseRatio = (input: string): void => {
    const result = parseAspectRatio(input)
    if (result.value === null) return
    const output = calculateOutputSize(result.value, Math.max(outputWidth, outputHeight))
    setRatioInput(input)
    setOutputWidth(output.width)
    setOutputHeight(output.height)
  }

  const editRatio = (input: string): void => {
    setRatioInput(input)
    const result = parseAspectRatio(input)
    if (result.value === null) return
    const output = calculateOutputSize(result.value, Math.max(outputWidth, outputHeight))
    setOutputWidth(output.width)
    setOutputHeight(output.height)
  }

  const toggleOpen = (): void => {
    if (!open) {
      setRatioInput(`${scene.canvas.aspectWidth}:${scene.canvas.aspectHeight}`)
      setOutputWidth(scene.canvas.outputWidth)
      setOutputHeight(scene.canvas.outputHeight)
    }
    setOpen((value) => !value)
  }

  const swap = (): void => {
    if (parsed.value === null) return
    chooseRatio(`${parsed.value.height}:${parsed.value.width}`)
  }

  const apply = (): void => {
    if (parsed.value === null) return
    const nextCanvas = {
      ...scene.canvas,
      aspectWidth: parsed.value.width,
      aspectHeight: parsed.value.height,
      outputWidth: Math.max(64, Math.min(16384, Math.round(outputWidth))),
      outputHeight: Math.max(64, Math.min(16384, Math.round(outputHeight)))
    }
    execute(
      `调整画布为 ${parsed.value.width}:${parsed.value.height} · ${strategyCopy[strategy].label}`,
      createCanvasResizeCommands(scene, nextCanvas, strategy)
    )
    if (!inspector) setOpen(false)
  }

  return (
    <div ref={rootRef} className={`canvas-size-control${inspector ? ' is-inspector' : ''}`}>
      {!inspector && (
        <button
          type="button"
          className="canvas-size-trigger"
          aria-label="画布尺寸"
          aria-expanded={open}
          onClick={toggleOpen}
        >
          {scene.canvas.aspectWidth}:{scene.canvas.aspectHeight} · {scene.canvas.outputWidth} × {scene.canvas.outputHeight}<ChevronDown size={11} />
        </button>
      )}
      {open && (
        <div ref={panelRef} className="canvas-size-panel glass-surface" style={inspector ? undefined : panelStyle} role="dialog" aria-label="画布尺寸设置">
          <div className="size-panel-heading">
            <div><strong>画布尺寸</strong><span>构图比例与输出像素分别设置</span></div>
            <button type="button" aria-label="横竖互换" title="横竖互换" onClick={swap}><ArrowRightLeft size={15} /></button>
          </div>
          <div className="ratio-presets" aria-label="画布比例预设">
            {presets.map((preset) => <button key={preset} type="button" className={ratioInput === preset ? 'is-active' : ''} onClick={() => chooseRatio(preset)}>{preset}</button>)}
            <button type="button" className={!presets.includes(ratioInput as typeof presets[number]) ? 'is-active' : ''} onClick={() => setRatioInput('7:5')}>自由</button>
          </div>
          <label className="size-ratio-field">
            <span>自由比例 W:H</span>
            <input aria-label="自由画布比例" value={ratioInput} onChange={(event) => editRatio(event.currentTarget.value)} />
            {parsed.value !== null && <small>化简为 {parsed.value.width}:{parsed.value.height}</small>}
          </label>
          <div className="size-output-grid">
            <label><span>输出宽度</span><input aria-label="画布输出宽度" type="number" min={64} max={16384} value={outputWidth} onChange={(event) => setOutputWidth(Number(event.currentTarget.value))} /></label>
            <label><span>输出高度</span><input aria-label="画布输出高度" type="number" min={64} max={16384} value={outputHeight} onChange={(event) => setOutputHeight(Number(event.currentTarget.value))} /></label>
          </div>
          <fieldset className="resize-strategies">
            <legend>已有内容如何适配</legend>
            {(Object.keys(strategyCopy) as CanvasResizeStrategy[]).map((key) => (
              <button key={key} type="button" className={strategy === key ? 'is-active' : ''} onClick={() => setStrategy(key)}>
                <span className="strategy-check">{strategy === key && <Check size={11} />}</span>
                <span><strong>{strategyCopy[key].label}</strong><small>{strategyCopy[key].detail}</small></span>
              </button>
            ))}
          </fieldset>
          {parsed.error !== null && <p className="size-error" role="alert">{parsed.error}</p>}
          <button type="button" className="size-apply" disabled={parsed.value === null || !Number.isFinite(outputWidth) || !Number.isFinite(outputHeight)} onClick={apply}>应用画布尺寸</button>
        </div>
      )}
    </div>
  )
}
