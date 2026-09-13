import {
  BoxSelect,
  Hand,
  ImagePlus,
  MousePointer2,
  Pencil,
  Shapes,
  SquareDashed,
  SunMedium,
  Type
} from 'lucide-react'
import type { CanvasTool } from '../store/workspace-store'

const tools: ReadonlyArray<{ tool: CanvasTool; label: string; icon: typeof MousePointer2 }> = [
  { tool: 'select', label: '选择 V', icon: MousePointer2 },
  { tool: 'hand', label: '抓手 H', icon: Hand },
  { tool: 'image', label: '导入图片', icon: ImagePlus },
  { tool: 'text', label: '文字 T', icon: Type },
  { tool: 'sketch', label: '草图 B', icon: Pencil },
  { tool: 'shape', label: '形状', icon: Shapes },
  { tool: 'placeholder', label: '主体占位', icon: BoxSelect },
  { tool: 'light', label: '光影', icon: SunMedium },
  { tool: 'mask', label: '蒙版', icon: SquareDashed }
]

interface CanvasToolbarProps {
  activeTool: CanvasTool
  onChoose(tool: CanvasTool): void
}

export function CanvasToolbar({ activeTool, onChoose }: CanvasToolbarProps): React.JSX.Element {
  return (
    <nav className="canvas-toolbar" aria-label="画布工具">
      {tools.map(({ tool, label, icon: Icon }) => (
        <button
          key={tool}
          type="button"
          className={`tool-button${activeTool === tool ? ' is-active' : ''}`}
          aria-label={label}
          aria-pressed={activeTool === tool}
          title={label}
          onClick={() => onChoose(tool)}
        >
          <Icon size={18} strokeWidth={1.65} aria-hidden="true" />
        </button>
      ))}
    </nav>
  )
}
