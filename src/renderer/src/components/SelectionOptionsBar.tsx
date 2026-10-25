import { Square, SquareMinus, SquarePlus, SquaresIntersect, type LucideIcon } from 'lucide-react'
import type { MaskCombine } from '../../../shared/mask-raster'
import { selectSubject } from '../selection/subject-selection'
import { useSelectionStore } from '../selection/selection-store'
import type { SelectionTool } from '../store/workspace-store'
import { Amount } from './PaintOptionsBar'

/*
 * Photoshop's options bar for the selection tools: new, add, subtract and
 * intersect, the feather for new shapes, the magic wand's tolerance, and
 * Select Subject.
 */

const TOOL_NAMES: Readonly<Record<SelectionTool, string>> = {
  'marquee-rect': '矩形选框',
  'marquee-ellipse': '椭圆选框',
  lasso: '套索',
  'lasso-polygon': '多边形套索',
  'object-select': '对象选择',
  'magic-wand': '魔棒'
}

const MODES: ReadonlyArray<{ readonly mode: MaskCombine; readonly label: string; readonly hint: string; readonly icon: LucideIcon }> = [
  { mode: 'replace', label: '新选区', hint: '', icon: Square },
  { mode: 'add', label: '添加到选区', hint: '（按住 Shift）', icon: SquarePlus },
  { mode: 'subtract', label: '从选区减去', hint: '（按住 Alt）', icon: SquareMinus },
  { mode: 'intersect', label: '与选区交叉', hint: '（按住 Shift+Alt）', icon: SquaresIntersect }
]

export function SelectionOptionsBar({ tool }: { readonly tool: SelectionTool }): React.JSX.Element {
  const settings = useSelectionStore((state) => state.settings)
  const setSettings = useSelectionStore((state) => state.setSettings)
  const shapeTool = tool === 'marquee-rect' || tool === 'marquee-ellipse' || tool === 'lasso' || tool === 'lasso-polygon'
  return (
    <div className="paint-options selection-options" role="toolbar" aria-label={`${TOOL_NAMES[tool]}选项`}>
      <span className="selection-modes" role="radiogroup" aria-label="选区方式">
        {MODES.map(({ mode, label, hint, icon: Icon }) => (
          <button key={mode} type="button" role="radio" aria-checked={settings.mode === mode} aria-label={label} title={`${label}${hint}`} onClick={() => setSettings({ mode })}>
            <Icon size={14} aria-hidden="true" />
          </button>
        ))}
      </span>
      {shapeTool && <Amount label="羽化" unit="px" min={0} max={1000} value={settings.feather} onChange={(feather) => setSettings({ feather })} />}
      {tool !== 'marquee-rect' && tool !== 'object-select' && (
        <label className="paint-check"><input type="checkbox" checked={settings.antialias} onChange={(event) => setSettings({ antialias: event.currentTarget.checked })} />消除锯齿</label>
      )}
      {tool === 'magic-wand' && (
        <>
          <Amount label="容差" unit="" min={0} max={255} value={settings.wandTolerance} onChange={(wandTolerance) => setSettings({ wandTolerance })} />
          <label className="paint-check"><input type="checkbox" checked={settings.wandContiguous} onChange={(event) => setSettings({ wandContiguous: event.currentTarget.checked })} />连续的</label>
        </>
      )}
      {(tool === 'magic-wand' || tool === 'object-select') && (
        <label className="paint-check"><input type="checkbox" checked={settings.sampleAllLayers} onChange={(event) => setSettings({ sampleAllLayers: event.currentTarget.checked })} />对所有图层取样</label>
      )}
      <button type="button" className="selection-subject" title="选中图片图层时选这一层的主体，否则选整张画面的主体" onClick={() => { void selectSubject() }}>选择主体</button>
    </div>
  )
}
