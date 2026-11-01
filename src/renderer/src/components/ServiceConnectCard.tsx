import { Check, KeyRound, Plug } from 'lucide-react'
import { useEffect, useState } from 'react'
import { PRIMARY_IMAGE_PROVIDER_ID, providerPublicConfigSchema, type ProviderConnectionTestResult, type ProviderSettingsSnapshot } from '../../../shared/provider-settings'
import { applyLlmVendor, LLM_VENDOR_PRESETS, llmVendorPreset } from '../../../shared/vendor-presets'
import { useFirstRunStore } from '../store/first-run-store'

type Phase = { readonly kind: 'idle' } | { readonly kind: 'working'; readonly step: string } | { readonly kind: 'connected'; readonly model: string }
  | { readonly kind: 'failed'; readonly title: string; readonly detail: string }

/**
 * The first thing a new install asks for: a text model, in three steps. It
 * sits in the project library rather than over it, and 「先用示例看看」 puts
 * it away for good; the settings stay the place to change it later.
 */
export function ServiceConnectCard({ onCreateBlank, onShowExamples }: {
  readonly onCreateBlank: () => void
  readonly onShowExamples: () => void
}): React.JSX.Element | null {
  const [snapshot, setSnapshot] = useState<ProviderSettingsSnapshot | null>(null)
  const dismissed = useFirstRunStore((state) => state.serviceCardDismissed)
  const dismiss = useFirstRunStore((state) => state.dismissServiceCard)
  const [vendorId, setVendorId] = useState('ark')
  const vendor = llmVendorPreset(vendorId)
  const [model, setModel] = useState(vendor.model)
  const [baseUrl, setBaseUrl] = useState(vendor.baseUrl)
  const [apiKey, setApiKey] = useState('')
  const [shareWithImage, setShareWithImage] = useState(true)
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  /** Connecting began here: the key is saved before the test, so the card stays up to show how it went. */
  const [engaged, setEngaged] = useState(false)

  useEffect(() => {
    let current = true
    window.desktop.getProviderSettings().then((value) => { if (current) setSnapshot(value) }).catch(() => undefined)
    return () => { current = false }
  }, [])

  const llm = snapshot?.providers.find((provider) => provider.kind === 'llm')
  // Shown while the text model has no key, and kept on screen once connecting began here so the outcome and the next step stay in view.
  if (snapshot === null || llm === undefined || dismissed || (llm.configured && !engaged)) return null

  const chooseVendor = (id: string): void => {
    const next = llmVendorPreset(id)
    setVendorId(id)
    setModel(next.model)
    setBaseUrl(next.baseUrl)
    setPhase({ kind: 'idle' })
  }

  const ready = apiKey.trim().length >= 8 && model.trim() !== '' && baseUrl.trim() !== ''

  const connect = async (): Promise<void> => {
    if (!ready || phase.kind === 'working') return
    setEngaged(true)
    try {
      setPhase({ kind: 'working', step: '正在保存设置…' })
      const saved = providerPublicConfigSchema.parse(llm)
      if (saved.kind !== 'llm') throw new Error('没有找到文字模型的设置。')
      await window.desktop.setProviderConfig(applyLlmVendor(saved, vendor, model, baseUrl))
      setPhase({ kind: 'working', step: '正在加密保存 Key…' })
      await window.desktop.setProviderSecret({ providerId: llm.id, apiKey: apiKey.trim() })
      const image = snapshot.providers.find((provider) => provider.id === PRIMARY_IMAGE_PROVIDER_ID)
      if (vendor.sharesKeyWithImage === true && shareWithImage && image?.kind === 'image' && image.protocol === 'ark-seedream') {
        await window.desktop.setProviderSecret({ providerId: image.id, apiKey: apiKey.trim() })
      }
      setPhase({ kind: 'working', step: '正在测试连接…' })
      const result: ProviderConnectionTestResult = await window.desktop.validateProviderConnection({ providerId: 'openai-compatible-llm', confirmed: true, scope: 'tool_call' })
      setApiKey('')
      const refreshed = await window.desktop.getProviderSettings()
      setSnapshot(refreshed)
      window.dispatchEvent(new CustomEvent('ai-canvas:provider-settings-changed', { detail: { snapshot: refreshed } }))
      setPhase(result.ok
        ? { kind: 'connected', model: result.model }
        : { kind: 'failed', title: result.failure.title, detail: `${result.failure.detail} ${result.failure.nextAction}` })
    } catch (error) {
      setPhase({ kind: 'failed', title: '没有连上', detail: error instanceof Error ? error.message : '请检查 Key 和网络后再试。' })
    }
  }

  if (phase.kind === 'connected') {
    return (
      <section className="service-connect glass-surface is-connected" aria-label="连上服务">
        <span className="service-connect-mark"><Check size={18} /></span>
        <div>
          <strong>连好了</strong>
          <p>{vendor.label} · {phase.model}。打开或新建作品后，Agent 会看着画面一步步做。</p>
        </div>
        <div className="service-connect-next">
          <button type="button" onClick={onShowExamples}>从示例开始</button>
          <button type="button" className="is-primary" onClick={onCreateBlank}>新建空白作品</button>
          <button type="button" className="quiet-choice" onClick={dismiss}>收起</button>
        </div>
      </section>
    )
  }

  return (
    <section className="service-connect glass-surface" aria-label="连上服务">
      <header>
        <span className="service-connect-mark"><Plug size={18} /></span>
        <div>
          <strong>先连上服务</strong>
          <p>Agent 要用文字模型，才能听懂你的话、看着画面一步步做。选一个你有 Key 的厂商，三步就好。</p>
        </div>
        <button type="button" className="quiet-choice" onClick={() => { dismiss(); onShowExamples() }}>先用示例看看</button>
      </header>
      <ol>
        <li>
          <span className="service-connect-step">1 选厂商</span>
          <div className="service-connect-vendors" role="group" aria-label="选厂商">
            {LLM_VENDOR_PRESETS.map((preset) => (
              <button key={preset.id} type="button" aria-pressed={vendorId === preset.id} onClick={() => chooseVendor(preset.id)}>
                <strong>{preset.label}</strong><small>{preset.note}</small>
              </button>
            ))}
          </div>
        </li>
        <li>
          <span className="service-connect-step">2 填 Key</span>
          <div className="service-connect-fields">
            {vendor.id === 'custom' && <label><span>接口地址</span><input aria-label="接口地址" placeholder="https://…/v1" value={baseUrl} onChange={(event) => setBaseUrl(event.currentTarget.value)} /></label>}
            {(vendor.model === '' || vendor.id === 'custom') && <label><span>模型名</span><input aria-label="模型名" placeholder="照厂商控制台里的模型名填" value={model} onChange={(event) => setModel(event.currentTarget.value)} /></label>}
            <label>
              <span>Key</span>
              <input aria-label="Key" type="password" autoComplete="new-password" placeholder={vendor.keyHint} value={apiKey} onChange={(event) => setApiKey(event.currentTarget.value)} />
            </label>
            <small><KeyRound size={11} />{vendor.keyHint}。Key 由系统加密保存在这台电脑上，不会写进作品。</small>
            {vendor.sharesKeyWithImage === true && (
              <label className="service-connect-share"><input type="checkbox" checked={shareWithImage} onChange={(event) => setShareWithImage(event.currentTarget.checked)} />同一个 Key 也用来生图（火山方舟 Seedream）</label>
            )}
          </div>
        </li>
        <li>
          <span className="service-connect-step">3 测试连接</span>
          <div className="service-connect-test">
            <button type="button" className="is-primary" disabled={!ready || phase.kind === 'working'} onClick={() => void connect()}>
              {phase.kind === 'working' ? phase.step : '保存并测试连接'}
            </button>
            <small>会发 1 个很小的文字请求，费用预留上限 ¥0.05，不生成图片。</small>
          </div>
        </li>
      </ol>
      {phase.kind === 'failed' && <p className="service-connect-problem" role="alert"><strong>{phase.title}</strong>{phase.detail}</p>}
    </section>
  )
}
