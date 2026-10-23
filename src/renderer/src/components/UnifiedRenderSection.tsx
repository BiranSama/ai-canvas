import { useEffect, useState } from 'react'

interface ImageService {
  readonly label: string
  readonly model: string
  readonly pricePerImageCny: number | null
}

type Step = 'idle' | 'confirming' | 'submitting' | 'submitted'

/**
 * Redraws every layer but text as one picture. A real request costs money,
 * so it names the service and the estimated price and waits for a second
 * click before anything is sent.
 */
export function UnifiedRenderSection(): React.JSX.Element {
  const [service, setService] = useState<ImageService | null | undefined>(undefined)
  const [requirement, setRequirement] = useState('')
  const [step, setStep] = useState<Step>('idle')
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
    let current = true
    void Promise.resolve().then(() => window.desktop.getProviderSettings()).then((settings) => {
      const image = settings.providers.find((provider) => provider.kind === 'image' && provider.id === settings.defaultImageProviderId)
      if (!current) return
      setService(image === undefined || image.kind !== 'image' || !image.configured || image.protocol === 'unconfigured'
        ? null
        : { label: image.label, model: image.defaultModel, pricePerImageCny: image.pricePerImageCny })
    }).catch(() => { if (current) setService(null) })
    return () => { current = false }
  }, [])

  const submit = async (): Promise<void> => {
    setStep('submitting')
    setProblem(null)
    try {
      await window.desktop.startUnifiedRender({ requirement: requirement.trim(), count: 1 })
      setStep('submitted')
    } catch (error) {
      setProblem(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : '统一重绘没有提交成功。')
      setStep('idle')
    }
  }

  return (
    <div className="inspector-section unified-render-section">
      <p className="section-kicker">统一重绘</p>
      <p className="field-note">把除文字外的整张画面交给生图模型重绘成一张统一的图：构图不变，光线和质感统一。放回后盖在原图层上面，文字留在最上层，隐藏它就能看到原来的样子。</p>
      <label className="wide-field">
        <span>想统一成的样子（可不填）</span>
        <input aria-label="统一重绘的要求" value={requirement} maxLength={2_000} placeholder="例如：清晨柔和的自然光，胶片质感" onChange={(event) => setRequirement(event.currentTarget.value)} />
      </label>
      {service === null && <p className="field-note is-problem">还没有配置生图服务，先在设置里配置。</p>}
      {step === 'idle' && <button type="button" className="unified-render-start" disabled={service == null} onClick={() => setStep('confirming')}>统一重绘…</button>}
      {(step === 'confirming' || step === 'submitting') && service != null && (
        <div className="unified-render-confirm" role="group" aria-label="确认统一重绘">
          <p>会向 {service.label}（{service.model}）发 1 个真实请求{service.pricePerImageCny === null ? '' : `，约 ¥${service.pricePerImageCny.toFixed(2)}`}。</p>
          <div>
            <button type="button" disabled={step === 'submitting'} onClick={() => setStep('idle')}>取消</button>
            <button type="button" className="is-primary" disabled={step === 'submitting'} onClick={() => void submit()}>{step === 'submitting' ? '正在提交…' : '确认重绘'}</button>
          </div>
        </div>
      )}
      {step === 'submitted' && (
        <p className="field-note" role="status">已提交。完成后在生成结果里点「放入画布」，它会盖在原图层上面。<button type="button" className="unified-render-again" onClick={() => setStep('idle')}>再来一次</button></p>
      )}
      {problem !== null && <p className="field-note is-problem" role="alert">{problem}</p>}
    </div>
  )
}
