import { useRef, useState } from 'react'
import type { AdjustmentSettings, CurvePoints, LevelsChannel } from '../../../domain'
import { autoCurves, autoLevels, curveTable, type Histogram } from '../../../shared/adjustments'

/*
 * The controls of each adjustment, as Photoshop's dialogs and properties
 * lay them out. Moving a control reports the settings as it goes (final
 * false) and once more when it is let go (final true): a dialog shows both
 * on the canvas, an adjustment layer records only the last.
 */

type Change = (next: AdjustmentSettings, final: boolean) => void
type Channel = 'rgb' | 'red' | 'green' | 'blue'

const CHANNELS: readonly { readonly id: Channel; readonly label: string }[] = [
  { id: 'rgb', label: 'RGB' }, { id: 'red', label: '红' }, { id: 'green', label: '绿' }, { id: 'blue', label: '蓝' }
]

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function decimals(step: number): number {
  return step >= 1 ? 0 : Math.min(4, Math.ceil(-Math.log10(step)))
}

/** A slider with its number, as Photoshop pairs them; the number is typed and taken on Enter or leaving it. */
export function AdjustSlider({ label, min, max, step = 1, value, onChange }: {
  readonly label: string
  readonly min: number
  readonly max: number
  readonly step?: number
  readonly value: number
  readonly onChange: (value: number, final: boolean) => void
}): React.JSX.Element {
  const [typing, setTyping] = useState<string | null>(null)
  const round = (raw: number): number => Number(clamp(raw, min, max).toFixed(decimals(step)))
  const typed = (): void => {
    if (typing === null) return
    const number = Number(typing)
    setTyping(null)
    if (typing.trim() !== '' && Number.isFinite(number)) onChange(round(number), true)
  }
  return (
    <div className="adjust-row">
      <span>{label}</span>
      <input
        type="range" aria-label={label} min={min} max={max} step={step} value={value}
        onChange={(event) => onChange(round(Number(event.currentTarget.value)), false)}
        onPointerUp={(event) => onChange(round(Number(event.currentTarget.value)), true)}
        onKeyUp={(event) => onChange(round(Number(event.currentTarget.value)), true)}
      />
      <input
        type="number" aria-label={`${label}数值`} min={min} max={max} step={step}
        value={typing ?? value.toFixed(decimals(step))}
        onChange={(event) => setTyping(event.currentTarget.value)}
        onBlur={typed}
        // Enter takes the typed value; it does not also confirm a dialog with the value before it.
        onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); typed() } }}
      />
    </div>
  )
}

function ChannelPicker({ value, onChange }: { readonly value: Channel; readonly onChange: (channel: Channel) => void }): React.JSX.Element {
  return (
    <label className="adjust-row is-select">
      <span>通道</span>
      <select aria-label="通道" value={value} onChange={(event) => onChange(event.currentTarget.value as Channel)}>
        {CHANNELS.map((channel) => <option key={channel.id} value={channel.id}>{channel.label}</option>)}
      </select>
    </label>
  )
}

/** The histogram as bars, square-rooted so a few full bins do not flatten the rest. */
function histogramPath(counts: Uint32Array | undefined, height: number): string {
  if (counts === undefined) return ''
  let peak = 0
  for (let value = 0; value < 256; value += 1) peak = Math.max(peak, Math.sqrt(counts[value]!))
  if (peak === 0) return ''
  let path = `M0 ${height}`
  for (let value = 0; value < 256; value += 1) path += ` L${value} ${height - Math.sqrt(counts[value]!) / peak * height} L${value + 1} ${height - Math.sqrt(counts[value]!) / peak * height}`
  return `${path} L256 ${height} Z`
}

function HistogramView({ counts }: { readonly counts: Uint32Array | undefined }): React.JSX.Element {
  return (
    <svg className="adjust-histogram" viewBox="0 0 256 72" preserveAspectRatio="none" role="img" aria-label="直方图">
      <path d={histogramPath(counts, 72)} />
    </svg>
  )
}

function LevelsControls({ settings, onChange, histogram }: { readonly settings: Extract<AdjustmentSettings, { kind: 'levels' }>; readonly onChange: Change; readonly histogram: Histogram | null }): React.JSX.Element {
  const [channel, setChannel] = useState<Channel>('rgb')
  const current = settings.channels[channel]
  const set = (changes: Partial<LevelsChannel>, final: boolean): void => {
    const next = { ...current, ...changes }
    // The white point stays at least two levels above the black, as in Photoshop.
    if (changes.inputBlack !== undefined) next.inputBlack = Math.min(next.inputBlack, next.inputWhite - 2)
    if (changes.inputWhite !== undefined) next.inputWhite = Math.max(next.inputWhite, next.inputBlack + 2)
    onChange({ ...settings, channels: { ...settings.channels, [channel]: next } }, final)
  }
  return (
    <>
      <div className="adjust-heading">
        <ChannelPicker value={channel} onChange={setChannel} />
        <button type="button" disabled={histogram === null} onClick={() => { if (histogram !== null) onChange(autoLevels(histogram, 'tone'), true) }}>自动</button>
      </div>
      <HistogramView counts={histogram?.[channel]} />
      <AdjustSlider label="输入黑场" min={0} max={253} value={current.inputBlack} onChange={(value, final) => set({ inputBlack: value }, final)} />
      <AdjustSlider label="中间调" min={0.1} max={9.99} step={0.01} value={current.gamma} onChange={(value, final) => set({ gamma: value }, final)} />
      <AdjustSlider label="输入白场" min={2} max={255} value={current.inputWhite} onChange={(value, final) => set({ inputWhite: value }, final)} />
      <AdjustSlider label="输出黑场" min={0} max={255} value={current.outputBlack} onChange={(value, final) => set({ outputBlack: value }, final)} />
      <AdjustSlider label="输出白场" min={0} max={255} value={current.outputWhite} onChange={(value, final) => set({ outputWhite: value }, final)} />
    </>
  )
}

/** How far outside the graph a point is dragged to take it off, as in Photoshop. */
const REMOVE_BEYOND = 28

function CurvesControls({ settings, onChange, histogram }: { readonly settings: Extract<AdjustmentSettings, { kind: 'curves' }>; readonly onChange: Change; readonly histogram: Histogram | null }): React.JSX.Element {
  const [channel, setChannel] = useState<Channel>('rgb')
  const [active, setActive] = useState<number | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  /** The point being dragged, among the points as they were when the drag began. */
  const drag = useRef<{ readonly index: number; readonly base: CurvePoints; removing: boolean } | null>(null)
  const points = settings.channels[channel]
  const table = curveTable(points)
  const withPoints = (next: CurvePoints, final: boolean): void => onChange({ ...settings, channels: { ...settings.channels, [channel]: next } }, final)

  const at = (event: React.PointerEvent): { readonly x: number; readonly y: number; readonly outside: boolean } => {
    const box = svgRef.current!.getBoundingClientRect()
    const x = (event.clientX - box.left) / box.width * 255
    const y = 255 - (event.clientY - box.top) / box.height * 255
    const margin = REMOVE_BEYOND / box.width * 255
    return { x: Math.round(clamp(x, 0, 255)), y: Math.round(clamp(y, 0, 255)), outside: x < -margin || x > 255 + margin || y < -margin || y > 255 + margin }
  }

  /** The points with one moved, kept between its neighbours, or left out while it is dragged away. */
  const moved = (base: CurvePoints, index: number, x: number, y: number, removing: boolean): CurvePoints => {
    if (removing) return base.filter((_, at) => at !== index) as CurvePoints
    const low = index === 0 ? 0 : base[index - 1]![0] + 1
    const high = index === base.length - 1 ? 255 : base[index + 1]![0] - 1
    return base.map((point, at) => at === index ? [clamp(x, low, high), y] as [number, number] : point) as CurvePoints
  }

  const onDown = (event: React.PointerEvent<SVGSVGElement>): void => {
    if (event.button !== 0) return
    const { x, y } = at(event)
    const near = points.findIndex(([px, py]) => Math.abs(px - x) <= 6 && Math.abs(py - y) <= 10)
    let index = near
    let base = points
    if (index < 0) {
      if (points.length >= 16 || points.some(([px]) => px === x)) return
      // A click on the graph adds a point on the curve there and picks it up.
      base = [...points, [x, Math.round(clamp(table[x]!, 0, 255))] as [number, number]].sort((left, right) => left[0] - right[0]) as CurvePoints
      index = base.findIndex(([px]) => px === x)
      withPoints(base, false)
    }
    setActive(index)
    drag.current = { index, base, removing: false }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const onMove = (event: React.PointerEvent<SVGSVGElement>): void => {
    const current = drag.current
    if (current === null) return
    const { x, y, outside } = at(event)
    current.removing = outside && current.base.length > 2
    withPoints(moved(current.base, current.index, x, y, current.removing), false)
  }
  const onUp = (event: React.PointerEvent<SVGSVGElement>): void => {
    const current = drag.current
    if (current === null) return
    drag.current = null
    const { x, y } = at(event)
    if (current.removing) setActive(null)
    withPoints(moved(current.base, current.index, x, y, current.removing), true)
  }

  const selected = active !== null && active < points.length ? points[active]! : null
  const curve = Array.from({ length: 256 }, (_, value) => `${value},${255 - clamp(table[value]!, 0, 255)}`).join(' ')
  return (
    <>
      <div className="adjust-heading">
        <ChannelPicker value={channel} onChange={(next) => { setChannel(next); setActive(null) }} />
        <button type="button" disabled={histogram === null} onClick={() => { if (histogram !== null) { setActive(null); onChange(autoCurves(histogram), true) } }}>自动</button>
      </div>
      <svg
        ref={svgRef} className="adjust-curves" viewBox="0 0 255 255" role="application" aria-label="曲线"
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}
      >
        <path className="adjust-curves-histogram" d={histogramPath(histogram?.[channel], 255)} />
        {[64, 128, 191].map((line) => <g key={line} className="adjust-curves-grid"><line x1={line} y1={0} x2={line} y2={255} /><line x1={0} y1={line} x2={255} y2={line} /></g>)}
        <line className="adjust-curves-diagonal" x1={0} y1={255} x2={255} y2={0} />
        <polyline className={`adjust-curves-line is-${channel}`} points={curve} />
        {points.map(([x, y], index) => <rect key={`${index}-${x}`} className={index === active ? 'is-active' : ''} x={x - 4} y={255 - y - 4} width={8} height={8} />)}
      </svg>
      {selected !== null && active !== null && (
        <div className="adjust-point">
          <AdjustSlider label="输入" min={0} max={255} value={selected[0]} onChange={(value, final) => withPoints(moved(points, active, value, selected[1], false), final)} />
          <AdjustSlider label="输出" min={0} max={255} value={selected[1]} onChange={(value, final) => withPoints(moved(points, active, selected[0], value, false), final)} />
        </div>
      )}
      <p className="field-note">单击曲线加点，拖动调整，拖出框外删掉。</p>
    </>
  )
}

const BALANCE_RANGES = [
  { id: 'shadows', label: '阴影' }, { id: 'midtones', label: '中间调' }, { id: 'highlights', label: '高光' }
] as const

function ColorBalanceControls({ settings, onChange }: { readonly settings: Extract<AdjustmentSettings, { kind: 'color-balance' }>; readonly onChange: Change }): React.JSX.Element {
  const [range, setRange] = useState<(typeof BALANCE_RANGES)[number]['id']>('midtones')
  const values = settings[range]
  const set = (index: number, value: number, final: boolean): void => onChange({ ...settings, [range]: values.map((current, at) => at === index ? value : current) as [number, number, number] }, final)
  return (
    <>
      <div className="adjust-tones" role="radiogroup" aria-label="色调">
        {BALANCE_RANGES.map((option) => (
          <label key={option.id}><input type="radio" name="color-balance-range" checked={range === option.id} onChange={() => setRange(option.id)} />{option.label}</label>
        ))}
      </div>
      <AdjustSlider label="青色 – 红色" min={-100} max={100} value={values[0]} onChange={(value, final) => set(0, value, final)} />
      <AdjustSlider label="洋红 – 绿色" min={-100} max={100} value={values[1]} onChange={(value, final) => set(1, value, final)} />
      <AdjustSlider label="黄色 – 蓝色" min={-100} max={100} value={values[2]} onChange={(value, final) => set(2, value, final)} />
      <label className="checkbox-field"><input type="checkbox" checked={settings.preserveLuminosity} onChange={(event) => onChange({ ...settings, preserveLuminosity: event.currentTarget.checked }, true)} /><span>保持明度</span></label>
    </>
  )
}

const DEFAULT_TINT = '#E1D3B3'

function BlackWhiteControls({ settings, onChange }: { readonly settings: Extract<AdjustmentSettings, { kind: 'black-white' }>; readonly onChange: Change }): React.JSX.Element {
  const weights = [['reds', '红色'], ['yellows', '黄色'], ['greens', '绿色'], ['cyans', '青色'], ['blues', '蓝色'], ['magentas', '洋红']] as const
  return (
    <>
      {weights.map(([key, label]) => <AdjustSlider key={key} label={label} min={-200} max={300} value={settings[key]} onChange={(value, final) => onChange({ ...settings, [key]: value }, final)} />)}
      <div className="adjust-row is-select">
        <label className="checkbox-field"><input type="checkbox" checked={settings.tint !== null} onChange={(event) => onChange({ ...settings, tint: event.currentTarget.checked ? DEFAULT_TINT : null }, true)} /><span>色调</span></label>
        {settings.tint !== null && <input type="color" aria-label="色调颜色" value={settings.tint} onChange={(event) => onChange({ ...settings, tint: event.currentTarget.value.toUpperCase() }, false)} onBlur={(event) => onChange({ ...settings, tint: event.currentTarget.value.toUpperCase() }, true)} />}
      </div>
    </>
  )
}

function HueSaturationControls({ settings, onChange }: { readonly settings: Extract<AdjustmentSettings, { kind: 'hue-saturation' }>; readonly onChange: Change }): React.JSX.Element {
  const colorize = settings.colorize
  return (
    <>
      {colorize === null ? (
        <>
          <AdjustSlider label="色相" min={-180} max={180} value={settings.hue} onChange={(value, final) => onChange({ ...settings, hue: value }, final)} />
          <AdjustSlider label="饱和度" min={-100} max={100} value={settings.saturation} onChange={(value, final) => onChange({ ...settings, saturation: value }, final)} />
          <AdjustSlider label="明度" min={-100} max={100} value={settings.lightness} onChange={(value, final) => onChange({ ...settings, lightness: value }, final)} />
        </>
      ) : (
        <>
          <AdjustSlider label="色相" min={0} max={360} value={colorize.hue} onChange={(value, final) => onChange({ ...settings, colorize: { ...colorize, hue: value } }, final)} />
          <AdjustSlider label="饱和度" min={0} max={100} value={colorize.saturation} onChange={(value, final) => onChange({ ...settings, colorize: { ...colorize, saturation: value } }, final)} />
          <AdjustSlider label="明度" min={-100} max={100} value={colorize.lightness} onChange={(value, final) => onChange({ ...settings, colorize: { ...colorize, lightness: value } }, final)} />
        </>
      )}
      <label className="checkbox-field"><input type="checkbox" checked={colorize !== null} onChange={(event) => onChange({ ...settings, colorize: event.currentTarget.checked ? { hue: 30, saturation: 25, lightness: 0 } : null }, true)} /><span>着色</span></label>
    </>
  )
}

/** The controls of one adjustment. */
export function AdjustmentControls({ settings, onChange, histogram }: {
  readonly settings: AdjustmentSettings
  readonly onChange: Change
  /** What the adjustment works on, for 色阶 and 曲线; null while it is being worked out. */
  readonly histogram: Histogram | null
}): React.JSX.Element {
  switch (settings.kind) {
    case 'brightness-contrast':
      return (
        <div className="adjust-controls">
          <AdjustSlider label="亮度" min={-150} max={150} value={settings.brightness} onChange={(value, final) => onChange({ ...settings, brightness: value }, final)} />
          <AdjustSlider label="对比度" min={-50} max={100} value={settings.contrast} onChange={(value, final) => onChange({ ...settings, contrast: value }, final)} />
        </div>
      )
    case 'levels':
      return <div className="adjust-controls"><LevelsControls settings={settings} onChange={onChange} histogram={histogram} /></div>
    case 'curves':
      return <div className="adjust-controls"><CurvesControls settings={settings} onChange={onChange} histogram={histogram} /></div>
    case 'exposure':
      return (
        <div className="adjust-controls">
          <AdjustSlider label="曝光度" min={-20} max={20} step={0.01} value={settings.exposure} onChange={(value, final) => onChange({ ...settings, exposure: value }, final)} />
          <AdjustSlider label="位移" min={-0.5} max={0.5} step={0.0001} value={settings.offset} onChange={(value, final) => onChange({ ...settings, offset: value }, final)} />
          <AdjustSlider label="灰度系数" min={0.01} max={9.99} step={0.01} value={settings.gamma} onChange={(value, final) => onChange({ ...settings, gamma: value }, final)} />
        </div>
      )
    case 'vibrance':
      return (
        <div className="adjust-controls">
          <AdjustSlider label="自然饱和度" min={-100} max={100} value={settings.vibrance} onChange={(value, final) => onChange({ ...settings, vibrance: value }, final)} />
          <AdjustSlider label="饱和度" min={-100} max={100} value={settings.saturation} onChange={(value, final) => onChange({ ...settings, saturation: value }, final)} />
        </div>
      )
    case 'hue-saturation':
      return <div className="adjust-controls"><HueSaturationControls settings={settings} onChange={onChange} /></div>
    case 'color-balance':
      return <div className="adjust-controls"><ColorBalanceControls settings={settings} onChange={onChange} /></div>
    case 'black-white':
      return <div className="adjust-controls"><BlackWhiteControls settings={settings} onChange={onChange} /></div>
    case 'invert':
    case 'desaturate':
      return <div className="adjust-controls"><p className="field-note">这个调整没有参数。</p></div>
  }
}
