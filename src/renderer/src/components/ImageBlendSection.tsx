import { useState } from 'react'
import type { ImageEffects, SceneElement } from '../../../domain'
import { softShadow, softShadowStrength } from '../../../shared/layer-effects'

type ImageElement = Extract<SceneElement, { type: 'image' }>

const NO_EFFECTS: ImageEffects = { colorMatch: null, feather: 0, shadow: null }
const TONE_STRENGTHS = [
  { label: '轻', strength: 0.25 },
  { label: '中', strength: 0.4 },
  { label: '强', strength: 0.7 }
] as const

/** Layer effects that blend an image into the picture: tone, edge fade and a soft shadow. The asset is never changed. */
export function ImageBlendSection({ element, onChange }: {
  readonly element: ImageElement
  readonly onChange: (effects: ImageEffects) => void
}): React.JSX.Element {
  const effects = element.effects ?? NO_EFFECTS
  const [busy, setBusy] = useState<number | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const set = (changes: Partial<ImageEffects>): void => onChange({ ...effects, ...changes })

  const matchTone = async (strength: number): Promise<void> => {
    setBusy(strength)
    setProblem(null)
    try {
      const measured = await window.desktop.matchImageTone({ elementId: element.id, strength })
      if (measured === null) setProblem('量不了这张图周围的颜色，可以只调羽化和投影。')
      else set({ colorMatch: measured.colorMatch })
    } catch {
      setProblem('色调匹配没有完成，请稍后再试。')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="inspector-section image-blend-section">
      <p className="section-kicker">融入画面</p>
      <div className="blend-row" role="group" aria-label="色调匹配">
        <span>色调</span>
        <div className="blend-tone-buttons">
          {TONE_STRENGTHS.map(({ label, strength }) => (
            <button key={label} type="button" disabled={busy !== null} aria-label={`色调往周围靠：${label}`} onClick={() => void matchTone(strength)}>
              {busy === strength ? '…' : label}
            </button>
          ))}
          {effects.colorMatch !== null && <button type="button" className="is-quiet" onClick={() => set({ colorMatch: null })}>还原</button>}
        </div>
      </div>
      <label className="blend-row">
        <span>边缘羽化</span>
        <input aria-label="边缘羽化" type="range" min={0} max={0.3} step={0.005} value={effects.feather} onChange={(event) => set({ feather: Number(event.currentTarget.value) })} />
        <output>{Math.round(effects.feather * 100)}%</output>
      </label>
      <label className="blend-row">
        <span>投影</span>
        <input aria-label="投影" type="range" min={0} max={1} step={0.05} value={softShadowStrength(effects.shadow)} onChange={(event) => {
          const strength = Number(event.currentTarget.value)
          set({ shadow: strength === 0 ? null : softShadow(strength) })
        }} />
        <output>{Math.round(softShadowStrength(effects.shadow) * 100)}%</output>
      </label>
      {problem !== null && <p className="field-note is-problem" role="alert">{problem}</p>}
      <p className="field-note">只改显示，不改原图，可以随时调回。投影适合背景透明的主体。</p>
    </div>
  )
}
