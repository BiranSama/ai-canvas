import {
  ArrowLeftRight,
  BoxSelect,
  Brush,
  CircleDashed,
  Eraser,
  Hand,
  ImagePlus,
  Lasso,
  LassoSelect,
  MousePointer2,
  PaintBucket,
  Pencil,
  Pipette,
  Shapes,
  Sparkles,
  SquareDashed,
  SquareDashedMousePointer,
  SunMedium,
  Type,
  WandSparkles,
  type LucideIcon
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useWorkspaceStore, type CanvasTool, type ToolMemory } from '../store/workspace-store'

interface ToolInfo {
  readonly label: string
  readonly shortcut?: string
  readonly icon: LucideIcon
}

/** A linear gradient swatch, as Photoshop's gradient tool shows it. */
const GradientIcon = (({ size = 18, ...props }: { size?: number | string } & React.SVGProps<SVGSVGElement>) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.65} {...props}>
    <defs><linearGradient id="toolbar-gradient-icon" x1="0" x2="1"><stop offset="0" stopColor="currentColor" /><stop offset="1" stopColor="currentColor" stopOpacity="0" /></linearGradient></defs>
    <rect x="3.5" y="5.5" width="17" height="13" rx="2" />
    <rect x="5" y="7" width="14" height="10" rx="1" fill="url(#toolbar-gradient-icon)" stroke="none" />
  </svg>
)) as unknown as LucideIcon

const TOOLS: Readonly<Record<CanvasTool, ToolInfo>> = {
  select: { label: '选择 V', shortcut: 'V', icon: MousePointer2 },
  'marquee-rect': { label: '矩形选框', shortcut: 'M', icon: SquareDashed },
  'marquee-ellipse': { label: '椭圆选框', shortcut: 'M', icon: CircleDashed },
  lasso: { label: '套索', shortcut: 'L', icon: Lasso },
  'lasso-polygon': { label: '多边形套索', shortcut: 'L', icon: LassoSelect },
  'object-select': { label: '对象选择', shortcut: 'W', icon: SquareDashedMousePointer },
  'magic-wand': { label: '魔棒', shortcut: 'W', icon: WandSparkles },
  hand: { label: '抓手 H', shortcut: 'H', icon: Hand },
  image: { label: '导入图片', icon: ImagePlus },
  text: { label: '文字 T', shortcut: 'T', icon: Type },
  shape: { label: '形状', shortcut: 'U', icon: Shapes },
  brush: { label: '画笔', shortcut: 'B', icon: Brush },
  eraser: { label: '橡皮擦', shortcut: 'E', icon: Eraser },
  bucket: { label: '油漆桶', shortcut: 'G', icon: PaintBucket },
  gradient: { label: '渐变', shortcut: 'G', icon: GradientIcon },
  eyedropper: { label: '吸管', shortcut: 'I', icon: Pipette },
  // The AI's repaint and protect regions; 蒙版 is Photoshop's layer mask, in the layers panel.
  mask: { label: 'AI 重绘区域', icon: Sparkles },
  sketch: { label: '草图', icon: Pencil },
  placeholder: { label: '主体占位', icon: BoxSelect },
  light: { label: '光影', icon: SunMedium }
}

/** Toolbar slots top to bottom; a slot of several tools shows the one last used and lists the rest on right-click or a long press. */
const SLOTS: ReadonlyArray<{ readonly tools: readonly CanvasTool[]; readonly memory?: keyof ToolMemory; readonly name?: string }> = [
  { tools: ['select'] },
  { tools: ['marquee-rect', 'marquee-ellipse'], memory: 'marquee', name: '选框工具' },
  { tools: ['lasso', 'lasso-polygon'], memory: 'lasso', name: '套索工具' },
  { tools: ['object-select', 'magic-wand'], memory: 'wand', name: '对象选择和魔棒' },
  { tools: ['hand'] },
  { tools: ['image'] },
  { tools: ['text'] },
  { tools: ['shape'] },
  { tools: ['brush'] },
  { tools: ['eraser'] },
  { tools: ['bucket', 'gradient'], memory: 'fill', name: '油漆桶和渐变' },
  { tools: ['eyedropper'] },
  { tools: ['sketch', 'placeholder', 'light', 'mask'], memory: 'annotate', name: 'AI 标注' }
]

const LONG_PRESS_MS = 350

interface CanvasToolbarProps {
  activeTool: CanvasTool
  onChoose(tool: CanvasTool): void
}

/** Foreground over background, as in Photoshop's toolbar: click a swatch to pick, X swaps, D resets. */
function ColorSwatches(): React.JSX.Element {
  const foreground = useWorkspaceStore((state) => state.foregroundColor)
  const background = useWorkspaceStore((state) => state.backgroundColor)
  const setForeground = useWorkspaceStore((state) => state.setForegroundColor)
  const setBackground = useWorkspaceStore((state) => state.setBackgroundColor)
  const swap = useWorkspaceStore((state) => state.swapColors)
  const reset = useWorkspaceStore((state) => state.resetColors)
  return (
    <div className="color-swatches" role="group" aria-label="前景色和背景色">
      <label className="color-swatch is-background" title={`背景色 ${background}`} style={{ background }}>
        <input type="color" aria-label="背景色" value={background} onChange={(event) => setBackground(event.currentTarget.value.toUpperCase())} />
      </label>
      <label className="color-swatch is-foreground" title={`前景色 ${foreground}`} style={{ background: foreground }}>
        <input type="color" aria-label="前景色" value={foreground} onChange={(event) => setForeground(event.currentTarget.value.toUpperCase())} />
      </label>
      <button type="button" className="color-swap" aria-label="交换前景色和背景色" aria-keyshortcuts="X" title="交换 X" onClick={swap}><ArrowLeftRight size={10} aria-hidden="true" /></button>
      <button type="button" className="color-reset" aria-label="默认前景色和背景色" aria-keyshortcuts="D" title="默认颜色 D" onClick={reset}><span aria-hidden="true" /></button>
    </div>
  )
}

export function CanvasToolbar({ activeTool, onChoose }: CanvasToolbarProps): React.JSX.Element {
  const toolMemory = useWorkspaceStore((state) => state.toolMemory)
  const [flyout, setFlyout] = useState<{ readonly index: number; readonly x: number; readonly y: number } | null>(null)
  const flyoutRef = useRef<HTMLDivElement>(null)
  const pressTimer = useRef<number | null>(null)

  useEffect(() => {
    if (flyout === null) return
    const close = (event: PointerEvent): void => { if (!flyoutRef.current?.contains(event.target as Node)) setFlyout(null) }
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape') setFlyout(null) }
    window.addEventListener('pointerdown', close, true)
    window.addEventListener('keydown', escape, true)
    return () => {
      window.removeEventListener('pointerdown', close, true)
      window.removeEventListener('keydown', escape, true)
    }
  }, [flyout])

  const clearPress = (): void => {
    if (pressTimer.current !== null) window.clearTimeout(pressTimer.current)
    pressTimer.current = null
  }
  // The island clips what overflows it, so the flyout lives on the body beside the slot.
  const openFlyout = (index: number, button: HTMLElement): void => {
    const rect = button.getBoundingClientRect()
    setFlyout({ index, x: rect.right + 8, y: rect.top })
  }

  return (
    <nav className="canvas-toolbar" aria-label="画布工具">
      {SLOTS.map((slot, index) => {
        const shown = slot.tools.includes(activeTool) ? activeTool : slot.memory === undefined ? slot.tools[0]! : toolMemory[slot.memory]
        const { label, shortcut, icon: Icon } = TOOLS[shown]
        const grouped = slot.tools.length > 1
        return (
          <div key={shown + index} className={`tool-slot${grouped ? ' is-grouped' : ''}`}>
            <button
              type="button"
              className={`tool-button${slot.tools.includes(activeTool) ? ' is-active' : ''}`}
              aria-label={label}
              aria-keyshortcuts={shortcut}
              aria-pressed={activeTool === shown}
              aria-haspopup={grouped ? 'menu' : undefined}
              title={grouped ? `${label}${shortcut === undefined || label.endsWith(shortcut) ? '' : ` ${shortcut}`} · 右键或长按选同组工具` : shortcut === undefined || label.endsWith(` ${shortcut}`) ? label : `${label} ${shortcut}`}
              onClick={() => onChoose(shown)}
              onContextMenu={(event) => { if (grouped) { event.preventDefault(); openFlyout(index, event.currentTarget) } }}
              onPointerDown={(event) => {
                if (!grouped) return
                clearPress()
                const button = event.currentTarget
                pressTimer.current = window.setTimeout(() => openFlyout(index, button), LONG_PRESS_MS)
              }}
              onPointerUp={clearPress}
              onPointerLeave={clearPress}
            >
              <Icon size={18} strokeWidth={1.65} aria-hidden="true" />
            </button>
            {grouped && flyout?.index === index && createPortal(
              <div ref={flyoutRef} className="tool-flyout" role="menu" aria-label={slot.name} style={{ left: flyout.x, top: flyout.y }}>
                {slot.tools.map((tool) => {
                  const info = TOOLS[tool]
                  const ToolIcon = info.icon
                  return (
                    <button key={tool} type="button" role="menuitemradio" aria-checked={tool === shown} onClick={() => { setFlyout(null); onChoose(tool) }}>
                      <ToolIcon size={16} strokeWidth={1.65} aria-hidden="true" />
                      <span>{info.label}</span>
                      {info.shortcut !== undefined && !info.label.endsWith(info.shortcut) && <kbd>{`Shift+${info.shortcut}`}</kbd>}
                    </button>
                  )
                })}
              </div>,
              document.body
            )}
          </div>
        )
      })}
      <ColorSwatches />
    </nav>
  )
}
