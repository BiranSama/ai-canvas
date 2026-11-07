import type { FilterSettings } from '../../../domain'
import { AdjustSlider } from './AdjustmentControls'

/*
 * The controls of each filter, as Photoshop's filter dialogs have them.
 * Sizes are output pixels. Like the adjustments, a control reports as it
 * moves (final false) and once more when it is let go.
 */

type Change = (next: FilterSettings, final: boolean) => void

export function FilterControls({ settings, onChange }: { readonly settings: FilterSettings; readonly onChange: Change }): React.JSX.Element {
  switch (settings.kind) {
    case 'gaussian-blur':
      return (
        <div className="adjust-controls">
          <AdjustSlider label="半径（像素）" min={0.1} max={250} step={0.1} value={settings.radius} onChange={(value, final) => onChange({ ...settings, radius: value }, final)} />
        </div>
      )
    case 'unsharp-mask':
      return (
        <div className="adjust-controls">
          <AdjustSlider label="数量（%）" min={1} max={500} value={settings.amount} onChange={(value, final) => onChange({ ...settings, amount: value }, final)} />
          <AdjustSlider label="半径（像素）" min={0.1} max={250} step={0.1} value={settings.radius} onChange={(value, final) => onChange({ ...settings, radius: value }, final)} />
          <AdjustSlider label="阈值（色阶）" min={0} max={255} value={settings.threshold} onChange={(value, final) => onChange({ ...settings, threshold: value }, final)} />
        </div>
      )
    case 'add-noise':
      return (
        <div className="adjust-controls">
          <AdjustSlider label="数量（%）" min={0.1} max={400} step={0.1} value={settings.amount} onChange={(value, final) => onChange({ ...settings, amount: value }, final)} />
          <fieldset className="adjust-choice" aria-label="分布">
            <legend>分布</legend>
            <label><input type="radio" name="noise-distribution" checked={settings.distribution === 'uniform'} onChange={() => onChange({ ...settings, distribution: 'uniform' }, true)} />平均分布</label>
            <label><input type="radio" name="noise-distribution" checked={settings.distribution === 'gaussian'} onChange={() => onChange({ ...settings, distribution: 'gaussian' }, true)} />高斯分布</label>
          </fieldset>
          <label className="checkbox-field"><input type="checkbox" checked={settings.monochromatic} onChange={(event) => onChange({ ...settings, monochromatic: event.currentTarget.checked }, true)} /><span>单色</span></label>
        </div>
      )
    case 'motion-blur':
      return (
        <div className="adjust-controls">
          <AdjustSlider label="角度（度）" min={-90} max={90} value={Math.round(settings.angle)} onChange={(value, final) => onChange({ ...settings, angle: value }, final)} />
          <AdjustSlider label="距离（像素）" min={1} max={1000} value={settings.distance} onChange={(value, final) => onChange({ ...settings, distance: value }, final)} />
        </div>
      )
  }
}
