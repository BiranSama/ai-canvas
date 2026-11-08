import { ArrowRightLeft, Check, ChevronDown } from 'lucide-react'
import { type CSSProperties, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  anchoredFrame,
  calculateOutputSize,
  CANVAS_ANCHORS,
  createCanvasResizeCommands,
  parseAspectRatio,
  type CanvasAnchor,
  type CanvasResizeStrategy
} from '../../../domain'
import { reframeCanvas } from '../canvas/reframe-actions'
import { useWorkspaceStore } from '../store/workspace-store'
import { useCanvasSizePanel } from './canvas-size-panel'

const presets = ['1:1', '4:5', '3:2', '16:9'] as const

const ANCHOR_LABELS: Readonly<Record<CanvasAnchor, string>> = {
  'top-left': '左上', top: '上', 'top-right': '右上', left: '左', center: '中间', right: '右', 'bottom-left': '左下', bottom: '下', 'bottom-right': '右下'
}

const strategyCopy: Record<CanvasResizeStrategy, { readonly label: string; readonly detail: string }> = {
  'keep-position': { label: '保持位置', detail: '保留元素的标准化位置与尺寸' },
  'fit-content': { label: '适应内容', detail: '缩放并居中，避免现有内容被裁出' },
  'keep-center': { label: '扩展或裁切画布', detail: '每层按像素原地不动，按定位在四周加减（Ctrl+Alt+C）' }
}

export function CanvasSizeControl({ inspector = false }: { readonly inspector?: boolean }): React.JSX.Element {
  const scene = useWorkspaceStore((state) => state.scene)
  const execute = useWorkspaceStore((state) => state.execute)
  const [open, setOpen] = useState(inspector)
  const [ratioInput, setRatioInput] = useState(`${scene.canvas.aspectWidth}:${scene.canvas.aspectHeight}`)
  const [outputWidth, setOutputWidth] = useState(scene.canvas.outputWidth)
  const [outputHeight, setOutputHeight] = useState(scene.canvas.outputHeight)
  const [strategy, setStrategy] = useState<CanvasResizeStrategy>('keep-position')
  const [anchor, setAnchor] = useState<CanvasAnchor>('center')
  const [expand, setExpand] = useState(false)
  const [expandPrompt, setExpandPrompt] = useState('')
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

  // Ctrl+Alt+C opens the panel ready to extend or trim the canvas.
  useEffect(() => useCanvasSizePanel.subscribe((state, previous) => {
    if (inspector || state.request === null || state.request === previous.request) return
    const { canvas } = useWorkspaceStore.getState().scene
    setRatioInput(`${canvas.aspectWidth}:${canvas.aspectHeight}`)
    setOutputWidth(canvas.outputWidth)
    setOutputHeight(canvas.outputHeight)
    setStrategy(state.request.strategy)
    setOpen(true)
  }), [inspector])

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
    if (strategy === 'keep-center') {
      // Photoshop's 画布大小: every layer stays where it is in pixels, the canvas grows or shrinks about the anchor.
      const frame = anchoredFrame(scene.canvas, nextCanvas.outputWidth, nextCanvas.outputHeight, anchor)
      const grows = frame.width > scene.canvas.outputWidth || frame.height > scene.canvas.outputHeight
      void reframeCanvas(frame, grows && expand ? '画布大小并生成式扩展' : '画布大小', { expand: grows && expand ? { prompt: expandPrompt } : null })
    } else {
      execute(
        `调整画布为 ${parsed.value.width}:${parsed.value.height} · ${strategyCopy[strategy].label}`,
        createCanvasResizeCommands(scene, nextCanvas, strategy)
      )
    }
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
        <div ref={panelRef} className={`canvas-size-panel${inspector ? '' : ' glass-surface'}`} style={inspector ? undefined : panelStyle} role="dialog" aria-label="画布尺寸设置">
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
          {strategy === 'keep-center' && (
            <div className="canvas-anchor-section">
              <div className="canvas-anchor-grid" role="radiogroup" aria-label="定位">
                {CANVAS_ANCHORS.map((key) => (
                  <button key={key} type="button" role="radio" aria-checked={anchor === key} aria-label={`定位：${ANCHOR_LABELS[key]}`} title={ANCHOR_LABELS[key]} className={anchor === key ? 'is-active' : ''} onClick={() => setAnchor(key)} />
                ))}
              </div>
              <div className="canvas-anchor-expand">
                <label className="checkbox-field"><input type="checkbox" checked={expand} disabled={outputWidth <= scene.canvas.outputWidth && outputHeight <= scene.canvas.outputHeight} onChange={(event) => setExpand(event.currentTarget.checked)} /><span>新区域用 AI 扩图</span></label>
                {expand && (outputWidth > scene.canvas.outputWidth || outputHeight > scene.canvas.outputHeight) && (
                  <input aria-label="扩图描述" placeholder="留空则按周围画面延伸" value={expandPrompt} maxLength={2000} onChange={(event) => setExpandPrompt(event.currentTarget.value)} />
                )}
              </div>
            </div>
          )}
          {parsed.error !== null && <p className="size-error" role="alert">{parsed.error}</p>}
          <button type="button" className="size-apply" disabled={parsed.value === null || !Number.isFinite(outputWidth) || !Number.isFinite(outputHeight)} onClick={apply}>应用画布尺寸</button>
        </div>
      )}
    </div>
  )
}
