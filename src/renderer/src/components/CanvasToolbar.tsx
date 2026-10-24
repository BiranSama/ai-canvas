import {
  ArrowLeftRight,
  BoxSelect,
  Hand,
  ImagePlus,
  MousePointer2,
  Pencil,
  Pipette,
  Shapes,
  SquareDashed,
  SunMedium,
  Type
} from 'lucide-react'
import { useWorkspaceStore, type CanvasTool } from '../store/workspace-store'

const tools: ReadonlyArray<{ tool: CanvasTool; label: string; shortcut?: string; icon: typeof MousePointer2 }> = [
  { tool: 'select', label: '选择 V', shortcut: 'V', icon: MousePointer2 },
  { tool: 'hand', label: '抓手 H', shortcut: 'H', icon: Hand },
  { tool: 'image', label: '导入图片', icon: ImagePlus },
  { tool: 'text', label: '文字 T', shortcut: 'T', icon: Type },
  { tool: 'sketch', label: '草图 B', shortcut: 'B', icon: Pencil },
  { tool: 'shape', label: '形状', shortcut: 'U', icon: Shapes },
  { tool: 'eyedropper', label: '吸管', shortcut: 'I', icon: Pipette },
  { tool: 'placeholder', label: '主体占位', icon: BoxSelect },
  { tool: 'light', label: '光影', icon: SunMedium },
  { tool: 'mask', label: '蒙版', icon: SquareDashed }
]

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
  return (
    <nav className="canvas-toolbar" aria-label="画布工具">
      {tools.map(({ tool, label, shortcut, icon: Icon }) => (
        <button
          key={tool}
          type="button"
          className={`tool-button${activeTool === tool ? ' is-active' : ''}`}
          aria-label={label}
          aria-keyshortcuts={shortcut}
          aria-pressed={activeTool === tool}
          title={shortcut === undefined || label.endsWith(` ${shortcut}`) ? label : `${label} ${shortcut}`}
          onClick={() => onChoose(tool)}
        >
          <Icon size={18} strokeWidth={1.65} aria-hidden="true" />
        </button>
      ))}
      <ColorSwatches />
    </nav>
  )
}
