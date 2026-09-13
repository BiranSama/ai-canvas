import { AlertCircle, BrainCircuit, Check, FileDown, FolderInput, FolderOpen, ImageIcon, KeyRound, Layers3, Palette, Pencil, Server, ShieldCheck, Trash2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useModalScope } from '../interaction/use-modal-scope'
import type {
  AppearanceSettingsSnapshot,
  AppearanceSettingsUpdate,
  AppearanceTheme,
  GlassMaterial,
  OpticalQuality
} from '../../../shared/appearance-settings'
import type { RuntimeInfo } from '../../../shared/desktop-api'
import type { DiagnosticExportResult } from '../../../shared/diagnostics'
import type { GenerationProfileSnapshot } from '../../../shared/generation'
import {
  providerPublicConfigSchema,
  resolveImageEndpoint,
  resolveLlmEndpoint,
  type ConfigurableProviderId,
  type ImageProtocol,
  type LlmImageDetail,
  type LlmProtocol,
  type LlmReasoningEffort,
  type LlmTransportMode,
  type ProviderConnectionTestResult,
  type ProviderExecutionPolicy,
  type ProviderPublicConfig,
  type ProviderSettingsSnapshot
} from '../../../shared/provider-settings'
import { useCreationSessionStore } from '../store/creation-session-store'
import { applyAppearanceSnapshot, defaultAppearanceSnapshot } from '../appearance/apply-appearance'
import { AgentContextSettings } from './AgentContextSettings'

type ProviderDrafts = Partial<Record<ConfigurableProviderId, ProviderPublicConfig>>
type DiagnosticDisplayResult = DiagnosticExportResult | {
  readonly status: 'failed'
  readonly fileName: null
  readonly correlationId: null
  readonly message: string
}

const LLM_PROTOCOL_LABELS: Record<LlmProtocol, string> = {
  'ark-responses': '火山方舟 Responses',
  'openai-responses': 'Responses 兼容',
  'openai-chat-completions': 'Chat Completions 兼容'
}

const IMAGE_PROTOCOL_LABELS: Record<ImageProtocol, string> = {
  'ark-seedream': '火山方舟 Seedream',
  'openai-images': 'OpenAI Images 兼容',
  'task-images': '异步任务式 Images',
  unconfigured: '请选择图片协议'
}

const LLM_REASONING_LABELS: Record<LlmReasoningEffort, string> = {
  auto: '供应商默认',
  none: '关闭思考',
  minimal: '最轻量',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最大'
}

const LLM_IMAGE_DETAIL_LABELS: Record<LlmImageDetail, string> = {
  auto: '自动',
  low: '低成本 · 512px',
  original: '保留原图细节'
}

const IMAGE_PROTOCOL_CAPABILITIES: Record<ImageProtocol, ReadonlySet<keyof Extract<ProviderPublicConfig, { kind: 'image' }>['capabilities']>> = {
  'ark-seedream': new Set(['textToImage', 'imageReferences', 'maskEditing', 'multipleReferences']),
  'openai-images': new Set(['textToImage', 'imageReferences', 'maskEditing', 'multipleReferences', 'transparentOutput']),
  'task-images': new Set(['textToImage']),
  unconfigured: new Set()
}

const APPEARANCE_THEMES: readonly { id: AppearanceTheme; label: string; description: string }[] = [
  { id: 'system', label: '跟随系统', description: '随 Windows 自动切换' },
  { id: 'pearl', label: '月白', description: '明亮的珍珠雾工作室' },
  { id: 'obsidian', label: '夜墨', description: '克制的深墨蓝工作室' },
  { id: 'dusk', label: '暮蓝', description: '低亮度蓝灰创作环境' }
]

const GLASS_MATERIALS: readonly { id: GlassMaterial; label: string; description: string }[] = [
  { id: 'crystal', label: '晶澈', description: '高透明、折射边缘与镜面' },
  { id: 'satin', label: '雾绸', description: '柔和雾化，适合长时间使用' },
  { id: 'solid', label: '实色', description: '最高可读性，不使用透明滤镜' }
]

const OPTICAL_QUALITY_LABELS: Record<OpticalQuality, string> = {
  auto: '自动选择',
  fine: '精细折射',
  balanced: '平衡',
  performance: '流畅优先'
}

function budgetStatus(snapshot: ProviderSettingsSnapshot): string {
  const policy = snapshot.executionPolicy
  const approval = policy.approvalMode === 'confirm_each' ? '逐次确认' : '本次会话授权'
  return `每任务最多 ${policy.maxRequestsPerJob} 个传输请求、${policy.maxImagesPerJob} 张图，预约额度 ¥${policy.maxCostCnyPerJob.toFixed(2)}，${approval}。价格未知时，预约不保证实际人民币扣费上限。`
}

export function ProviderSettingsSheet({
  onClose,
  initialProviderId = null
}: {
  readonly onClose: () => void
  readonly initialProviderId?: ConfigurableProviderId | null
}): React.JSX.Element {
  const modalRef = useRef<HTMLElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const [snapshot, setSnapshot] = useState<ProviderSettingsSnapshot | null>(null)
  const [policyDraft, setPolicyDraft] = useState<ProviderExecutionPolicy | null>(null)
  const [profileSnapshot, setProfileSnapshot] = useState<GenerationProfileSnapshot | null>(null)
  const [drafts, setDrafts] = useState<ProviderDrafts>({})
  const [secrets, setSecrets] = useState<Record<ConfigurableProviderId, string>>({
    'openai-compatible-llm': '',
    'image-provider': ''
  })
  const [busy, setBusy] = useState<ConfigurableProviderId | null>(null)
  const [expandedProvider, setExpandedProvider] = useState<ConfigurableProviderId | null>(initialProviderId)
  const [section, setSection] = useState<'providers' | 'agent' | 'profiles' | 'projects' | 'appearance' | 'privacy'>('providers')
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null)
  const [status, setStatus] = useState('正在读取本地授权与预算状态…')
  const [libraryBusy, setLibraryBusy] = useState(false)
  const [migrationSummary, setMigrationSummary] = useState<string | null>(null)
  const [connectionConfirming, setConnectionConfirming] = useState(false)
  const [connectionResult, setConnectionResult] = useState<ProviderConnectionTestResult | null>(null)
  const [appearance, setAppearance] = useState<AppearanceSettingsSnapshot>(() => defaultAppearanceSnapshot())
  const [appearanceBusy, setAppearanceBusy] = useState(false)
  const [diagnosticBusy, setDiagnosticBusy] = useState(false)
  const [diagnosticResult, setDiagnosticResult] = useState<DiagnosticDisplayResult | null>(null)
  useModalScope(modalRef, () => connectionConfirming ? setConnectionConfirming(false) : onClose(), { initialFocus: closeButtonRef })

  const receiveSnapshot = (value: ProviderSettingsSnapshot): void => {
    setSnapshot(value)
    setPolicyDraft(value.executionPolicy)
    setDrafts(Object.fromEntries(value.providers.map((provider) => [
      provider.id,
      providerPublicConfigSchema.parse(provider)
    ])) as ProviderDrafts)
    useCreationSessionStore.getState().setProviderAutoGenerationAllowed(value.executionPolicy.autoGenerate)
  }

  const publishSnapshot = (value: ProviderSettingsSnapshot): void => {
    receiveSnapshot(value)
    window.dispatchEvent(new CustomEvent('ai-canvas:provider-settings-changed', { detail: { snapshot: value } }))
  }

  useEffect(() => {
    void window.desktop.getProviderSettings().then((value) => {
      receiveSnapshot(value)
      setStatus(budgetStatus(value))
    }).catch(() => setStatus('无法读取本地供应商设置。'))
    void window.desktop.getRuntimeInfo().then(setRuntime).catch(() => undefined)
    const desktop = window.desktop as Partial<typeof window.desktop>
    if (desktop.getAppearanceSettings !== undefined) {
      void desktop.getAppearanceSettings().then((value) => {
        setAppearance(value)
        applyAppearanceSnapshot(value)
      }).catch(() => setAppearance(defaultAppearanceSnapshot()))
    }
    void window.desktop.listGenerationProfiles().then(setProfileSnapshot).catch(() => undefined)
  }, [onClose])

  const updateAppearance = async (changes: Partial<AppearanceSettingsUpdate>): Promise<void> => {
    if (appearanceBusy) return
    const desktop = window.desktop as Partial<typeof window.desktop>
    if (desktop.setAppearanceSettings === undefined) return
    const input: AppearanceSettingsUpdate = { ...appearance.settings, ...changes }
    setAppearanceBusy(true)
    try {
      const next = await desktop.setAppearanceSettings(input)
      setAppearance(next)
      applyAppearanceSnapshot(next)
      setRuntime((current) => current === null ? current : {
        ...current,
        systemTheme: next.effectiveTheme === 'pearl' ? 'light' : 'dark'
      })
      setStatus('外观已保存并应用到当前工作室。')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '外观设置没有更改。')
    } finally {
      setAppearanceBusy(false)
    }
  }

  const updateDraft = (providerId: ConfigurableProviderId, update: (current: ProviderPublicConfig) => ProviderPublicConfig): void => {
    setDrafts((current) => {
      const draft = current[providerId]
      return draft === undefined ? current : { ...current, [providerId]: update(draft) }
    })
  }

  const saveConfig = async (providerId: ConfigurableProviderId): Promise<void> => {
    const draft = drafts[providerId]
    if (draft === undefined || busy !== null) return
    setBusy(providerId)
    try {
      publishSnapshot(await window.desktop.setProviderConfig(draft))
      setProfileSnapshot(await window.desktop.listGenerationProfiles())
      setConnectionResult(null)
      setConnectionConfirming(false)
      setStatus('公开配置已版本化保存；未发起网络请求。')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '未能保存公开配置。')
    } finally {
      setBusy(null)
    }
  }

  const validateConnection = async (): Promise<void> => {
    if (busy !== null) return
    setConnectionConfirming(false)
    setBusy('openai-compatible-llm')
    setStatus('正在验证已保存的文字模型连接；不会生成图片，也不会自动重试…')
    try {
      const result = await window.desktop.validateProviderConnection({
        providerId: 'openai-compatible-llm',
        confirmed: true
      })
      setConnectionResult(result)
      setStatus(result.ok
        ? '连接与结构化工具调用均已验证。'
        : `${result.failure.title}：${result.failure.nextAction}`)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '连接验证未完成；没有自动重试。')
    } finally {
      setBusy(null)
    }
  }

  const validateLocal = (providerId: ConfigurableProviderId): void => {
    const draft = drafts[providerId]
    if (draft === undefined) return
    try {
      providerPublicConfigSchema.parse(draft)
      setStatus(draft.baseUrl.length === 0 || draft.defaultModel.length === 0
        ? '格式有效；API 地址或默认模型尚未填写。没有发起网络请求。'
        : '格式检查通过；本地检查不会连接该地址，也不会产生费用。')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '公开配置格式无效。')
    }
  }

  const saveExecutionPolicy = async (): Promise<void> => {
    if (policyDraft === null || busy !== null) return
    setBusy('image-provider')
    try {
      publishSnapshot(await window.desktop.setProviderExecutionPolicy(policyDraft))
      setProfileSnapshot(await window.desktop.listGenerationProfiles())
      setStatus('执行边界已保存；新的任务会在联网前按此策略预留请求、图片与费用。')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '未能保存执行边界。')
    } finally {
      setBusy(null)
    }
  }

  const saveSecret = async (providerId: ConfigurableProviderId): Promise<void> => {
    const apiKey = secrets[providerId].trim()
    if (apiKey.length < 8 || busy !== null) return
    setBusy(providerId)
    try {
      publishSnapshot(await window.desktop.setProviderSecret({ providerId, apiKey }))
      setSecrets((current) => ({ ...current, [providerId]: '' }))
      setStatus('已由操作系统加密保存；界面不会再次显示密钥。')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '未能保存本地凭据。')
    } finally {
      setBusy(null)
    }
  }

  const removeSecret = async (providerId: ConfigurableProviderId): Promise<void> => {
    if (busy !== null) return
    setBusy(providerId)
    try {
      publishSnapshot(await window.desktop.deleteProviderSecret(providerId))
      setSecrets((current) => ({ ...current, [providerId]: '' }))
      setStatus('本地凭据已删除，应用不再能恢复它。')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '未能删除本地凭据。')
    } finally {
      setBusy(null)
    }
  }

  const changeLibrary = async (mode: 'future' | 'migrate'): Promise<void> => {
    if (libraryBusy) return
    setLibraryBusy(true)
    setMigrationSummary(null)
    try {
      const result = await window.desktop.changeProjectLibraryLocation(mode)
      if (result.cancelled) {
        setStatus('没有更改项目库位置。')
        return
      }
      setRuntime((current) => current === null ? current : { ...current, projectLibraryPath: result.settings.rootDirectory })
      if (result.migration === null) {
        setStatus('以后新建的项目将保存在新位置；旧项目不受影响。')
      } else {
        const copied = result.migration.items.filter((item) => item.status === 'copied').length
        const failed = result.migration.items.filter((item) => item.status === 'failed').length
        setMigrationSummary(`已复制并校验 ${copied} 个项目，失败 ${failed} 个；原项目库完整保留。`)
        setStatus(result.migration.switched ? '迁移验证通过，已切换新项目库。原目录未删除。' : '有项目未通过验证，未切换位置；原项目库保持不变。')
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '项目库位置没有更改。')
    } finally {
      setLibraryBusy(false)
    }
  }

  const exportDiagnostics = async (): Promise<void> => {
    if (diagnosticBusy) return
    setDiagnosticBusy(true)
    setDiagnosticResult(null)
    try {
      const result = await window.desktop.exportDiagnostics()
      setDiagnosticResult(result)
    } catch {
      setDiagnosticResult({
        status: 'failed',
        fileName: null,
        correlationId: null,
        message: '诊断包没有写入。请关闭设置后重试。'
      })
    } finally {
      setDiagnosticBusy(false)
    }
  }

  return (
    <div className="settings-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <section ref={modalRef} tabIndex={-1} className="provider-settings-sheet" role="dialog" aria-label="供应商设置" aria-modal="true">
        <header>
          <div>
            <span className="settings-kicker">本地创作系统</span>
            <h1 id="provider-settings-title">设置</h1>
            <p>语言模型与图片模型是两个可替换模块。先看当前引擎，需要时再展开协议、地址、能力与本机凭据。</p>
          </div>
          <button ref={closeButtonRef} type="button" className="icon-button" aria-label="关闭供应商设置" onClick={onClose}><X size={17} /></button>
        </header>
        <div className="settings-layout">
          <nav className="settings-navigation" aria-label="设置分类">
            <button type="button" className={section === 'providers' ? 'is-active' : ''} onClick={() => setSection('providers')}><Server size={15} />供应商</button>
            <button type="button" className={section === 'agent' ? 'is-active' : ''} onClick={() => setSection('agent')}><BrainCircuit size={15} />Agent 上下文</button>
            <button type="button" className={section === 'profiles' ? 'is-active' : ''} onClick={() => setSection('profiles')}><Layers3 size={15} />生成档位</button>
            <button type="button" className={section === 'projects' ? 'is-active' : ''} onClick={() => setSection('projects')}><FolderOpen size={15} />项目与存储</button>
            <button type="button" className={section === 'appearance' ? 'is-active' : ''} onClick={() => setSection('appearance')}><Palette size={15} />外观</button>
            <button type="button" className={section === 'privacy' ? 'is-active' : ''} onClick={() => setSection('privacy')}><ShieldCheck size={15} />隐私与高级</button>
          </nav>
          <div className="provider-settings-list">
          {section === 'agent' && <AgentContextSettings onStatus={setStatus} />}
          {section !== 'providers' && section !== 'agent' && (
            <section className="settings-section-summary">
              {section === 'profiles' && <>
                <span className="settings-kicker">生成档位与预算</span>
                <h2>生成档位</h2>
                <p>本地档用于离线预演；配置图片服务后，可按其能力选择多候选探索、单张生成和局部编辑。任务仍受项目授权和预算约束。</p>
                <div className="profile-summary-list">
                  {profileSnapshot?.profiles.map((entry) => (
                    <div key={entry.profile.id} data-profile-id={entry.profile.id}>
                      <span className="profile-setting-name">
                        <strong>{entry.profile.label}</strong>
                        <small>{entry.profile.simulated ? '本地离线' : entry.profile.modelId}</small>
                      </span>
                      <span className={`provider-state${entry.status === 'available' ? ' is-configured' : ''}`} title={entry.reason ?? undefined}>
                        {entry.status === 'available' ? <Check size={11} /> : <KeyRound size={11} />}
                        {entry.status === 'available'
                          ? entry.profile.simulated
                            ? `可用 · 本地模拟 · 实际 ¥0.00`
                            : '可用 · 费用未知；有可靠回执时显示实际金额'
                          : entry.reason ?? '当前配置不支持'}
                      </span>
                    </div>
                  )) ?? <div><strong>正在读取档位…</strong></div>}
                </div>
              </>}
              {section === 'projects' && <><span className="settings-kicker">项目库</span><h2>项目与存储</h2><p>新项目无需选择路径，会自动建立唯一的 .aicanvas 项目包。更改以后位置和迁移已有项目是两个独立动作。</p><div className="storage-location-card"><FolderOpen size={17} /><span><small>当前项目库</small><strong>{runtime?.projectLibraryPath ?? '正在读取…'}</strong></span></div><div className="storage-location-actions"><button type="button" disabled={libraryBusy} onClick={() => void changeLibrary('future')}><FolderInput size={14} />只更改以后的位置</button><button type="button" disabled={libraryBusy} onClick={() => void changeLibrary('migrate')}><FolderOpen size={14} />复制并迁移现有项目</button></div><small className="storage-safety-note">迁移会逐项复制和校验，全部通过后才切换；软件不会删除原项目库。</small>{migrationSummary !== null && <div className="migration-summary" role="status">{migrationSummary}</div>}</>}
              {section === 'appearance' && <>
                <span className="settings-kicker">光学工作室</span><h2>外观</h2>
                <p>作品保持实体，主题与玻璃只改变功能层。高质量折射会在拖动和低能力设备上自动降级。</p>
                <div className="appearance-heading"><strong>工作室主题</strong><small>{runtime?.backgroundMaterial === 'mica' ? 'Windows Mica 已启用' : '当前使用实色窗口回退'}</small></div>
                <div className="appearance-choice-grid theme-choices">
                  {APPEARANCE_THEMES.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      data-appearance-preview={option.id}
                      className={appearance?.settings.theme === option.id ? 'is-active' : ''}
                      disabled={appearanceBusy}
                      onClick={() => void updateAppearance({ theme: option.id })}
                    >
                      <span className="appearance-preview-art" aria-hidden="true"><i /><i /><i /></span>
                      <strong>{option.label}</strong><small>{option.description}</small>
                    </button>
                  ))}
                </div>
                <div className="appearance-heading"><strong>玻璃质感</strong><small>透明度降低时自动切换实色</small></div>
                <div className="appearance-choice-grid material-choices">
                  {GLASS_MATERIALS.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      data-glass-preview={option.id}
                      className={appearance?.settings.glassMaterial === option.id ? 'is-active' : ''}
                      disabled={appearanceBusy}
                      onClick={() => void updateAppearance({ glassMaterial: option.id })}
                    ><span className="material-preview" aria-hidden="true" /><strong>{option.label}</strong><small>{option.description}</small></button>
                  ))}
                </div>
                <details className="appearance-advanced">
                  <summary>光学与动态</summary>
                  <div className="appearance-advanced-grid">
                    <label><span>光学质量</span><select value={appearance?.settings.opticalQuality ?? 'auto'} disabled={appearanceBusy} onChange={(event) => void updateAppearance({ opticalQuality: event.currentTarget.value as OpticalQuality })}>{Object.entries(OPTICAL_QUALITY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                    <label><span>动态</span><select value={appearance?.settings.motion ?? 'system'} disabled={appearanceBusy} onChange={(event) => void updateAppearance({ motion: event.currentTarget.value as AppearanceSettingsUpdate['motion'] })}><option value="system">跟随系统</option><option value="full">完整</option><option value="reduced">减弱</option></select></label>
                    <label><span>环境反射</span><select value={appearance?.settings.sceneReflection ?? 'artwork'} disabled={appearanceBusy} onChange={(event) => void updateAppearance({ sceneReflection: event.currentTarget.value as AppearanceSettingsUpdate['sceneReflection'] })}><option value="artwork">跟随作品</option><option value="neutral">中性</option></select></label>
                  </div>
                </details>
              </>}
              {section === 'privacy' && <>
                <span className="settings-kicker">本地与隐私</span>
                <h2>隐私与高级</h2>
                <p>密钥由操作系统安全存储，不写入项目、界面记录或诊断内容。图片和文字只发往你保存的服务地址；作品修改保留撤销记录。</p>
                <div className="privacy-lock-card"><ShieldCheck size={19} /><span><strong>按本机授权范围访问</strong><small>不开放任意系统目录、命令执行、凭据明文或无边界自动付费</small></span></div>
                <div className="diagnostic-export-card">
                  <div className="diagnostic-export-copy">
                    <span className="diagnostic-export-icon" aria-hidden="true"><FileDown size={18} /></span>
                    <span>
                      <strong>导出脱敏诊断包</strong>
                      <small>只含设备与运行状态、公共配置、数量统计，以及最近 7 天最多 500 条再次脱敏记录。最大 2 MiB。</small>
                    </span>
                  </div>
                  <p>不包含密钥、完整提示词、对话正文、绝对路径、图片、Base64、签名链接、项目数据库或完整画布。文件只保存到你选择的位置，不会自动上传。</p>
                  <button
                    type="button"
                    data-testid="export-diagnostics"
                    disabled={diagnosticBusy}
                    onClick={() => void exportDiagnostics()}
                  ><FileDown size={14} />{diagnosticBusy ? '正在整理…' : '选择位置并导出'}</button>
                  {diagnosticResult !== null && (
                    <div
                      className={`diagnostic-export-result is-${diagnosticResult.status}`}
                      role="status"
                      data-testid="diagnostic-export-result"
                    >
                      <strong>{diagnosticResult.status === 'saved'
                        ? `已保存 ${diagnosticResult.fileName}`
                        : diagnosticResult.status === 'cancelled'
                          ? '没有创建文件'
                          : '导出未完成'}</strong>
                      <small>{diagnosticResult.message}{diagnosticResult.correlationId === null ? '' : ` · 关联编号 ${diagnosticResult.correlationId}`}</small>
                    </div>
                  )}
                </div>
              </>}
            </section>
          )}
          {section === 'providers' && <>
          {snapshot !== null && policyDraft !== null && (
            <aside className="provider-budget-card" aria-label="Provider 执行边界">
              <label><span>每任务请求数</span><input aria-label="每任务最大请求数" type="number" min={1} max={100} value={policyDraft.maxRequestsPerJob} onChange={(event) => {
                const value = Number(event.currentTarget.value)
                setPolicyDraft((current) => current === null ? null : { ...current, maxRequestsPerJob: value })
              }} /></label>
              <label><span>每任务图片数</span><input aria-label="每任务最大图片数" type="number" min={1} max={16} value={policyDraft.maxImagesPerJob} onChange={(event) => {
                const value = Number(event.currentTarget.value)
                setPolicyDraft((current) => current === null ? null : { ...current, maxImagesPerJob: value })
              }} /></label>
              <label><span>预约额度（元）</span><input aria-label="每任务预约额度" type="number" min={0} max={10000} step={1} value={policyDraft.maxCostCnyPerJob} onChange={(event) => {
                const value = Number(event.currentTarget.value)
                setPolicyDraft((current) => current === null ? null : { ...current, maxCostCnyPerJob: value })
              }} /></label>
              <div className="provider-policy-actions">
                <label className="provider-auto-generation-policy"><input aria-label="允许 Agent 自动发起图片任务" type="checkbox" checked={policyDraft.autoGenerate} onChange={(event) => {
                  const checked = event.currentTarget.checked
                  setPolicyDraft((current) => current === null ? null : { ...current, autoGenerate: checked })
                }} /><span><strong>允许自动图片任务</strong><small>这是全局权限上限；每一轮是否继续生成，由创作输入单独决定。</small></span></label>
                <select aria-label="真实任务确认方式" value={policyDraft.approvalMode} onChange={(event) => {
                  const approvalMode = event.currentTarget.value as ProviderExecutionPolicy['approvalMode']
                  setPolicyDraft((current) => current === null ? null : { ...current, approvalMode })
                }}><option value="confirm_each">逐次确认</option><option value="session">本次会话授权</option></select>
                <button type="button" disabled={busy !== null} onClick={() => void saveExecutionPolicy()}>保存执行边界</button>
              </div>
              <p>{budgetStatus({ ...snapshot, executionPolicy: policyDraft })}</p>
            </aside>
          )}
          {snapshot?.providers.map((provider) => {
            const draft = drafts[provider.id]
            if (draft === undefined) return null
            const prefix = provider.kind === 'llm' ? 'LLM Provider' : 'Image Provider'
            return (
              <article key={provider.id} className="provider-setting-row" data-provider-slot={provider.kind}>
                <div className="provider-setting-copy">
                  <span className="provider-slot-mark" aria-hidden="true">{provider.kind === 'llm' ? <BrainCircuit size={17} /> : <ImageIcon size={17} />}</span>
                  <div>
                    <span className="provider-slot-label">{provider.kind === 'llm' ? '语言模型' : '图片模型'}</span>
                    <strong>{draft.label}</strong>
                    <small>{draft.kind === 'llm' ? `${LLM_PROTOCOL_LABELS[draft.protocol]} · ${LLM_REASONING_LABELS[draft.reasoningEffort]}思考` : `${IMAGE_PROTOCOL_LABELS[draft.protocol]} · 能力由协议与下方声明共同决定`}</small>
                  </div>
                  <span className="provider-model-summary">{draft.defaultModel || '未指定模型'}</span>
                  <div className="provider-summary-actions">
                    <span className={`provider-state${provider.configured ? ' is-configured' : ''}`}>
                      {provider.configured ? <Check size={11} /> : <KeyRound size={11} />}
                      {provider.configured ? '已配置' : '无凭据'}</span>
                    <button type="button" className="provider-edit-toggle" aria-expanded={expandedProvider === provider.id} onClick={() => setExpandedProvider((current) => current === provider.id ? null : provider.id)}><Pencil size={11} />{expandedProvider === provider.id ? '收起' : '编辑'}</button>
                  </div>
                </div>

                {expandedProvider === provider.id && <div className="provider-editor">
                <div className="provider-public-grid">
                  <label><span>名称</span><input aria-label={`${prefix} 名称`} value={draft.label} onChange={(event) => {
                    const value = event.currentTarget.value
                    updateDraft(provider.id, (current) => ({ ...current, label: value }))
                  }} /></label>
                  {draft.kind === 'llm' && <label><span>调用协议</span><select aria-label="LLM Provider 调用协议" value={draft.protocol} onChange={(event) => {
                    const protocol = event.currentTarget.value as LlmProtocol
                    updateDraft(provider.id, (current) => current.kind === 'llm' ? { ...current, protocol } : current)
                  }}>
                    <option value="ark-responses">火山方舟 Responses</option>
                    <option value="openai-responses">Responses 兼容</option>
                    <option value="openai-chat-completions">Chat Completions 兼容</option>
                  </select></label>}
                  {draft.kind === 'image' && <label><span>调用协议</span><select aria-label="Image Provider 调用协议" value={draft.protocol} onChange={(event) => {
                    const protocol = event.currentTarget.value as ImageProtocol
                    updateDraft(provider.id, (current) => current.kind === 'image' ? {
                      ...current,
                      protocol,
                      capabilities: Object.fromEntries(Object.entries(current.capabilities).map(([key, value]) => [
                        key,
                        IMAGE_PROTOCOL_CAPABILITIES[protocol].has(key as keyof typeof current.capabilities) && value
                      ])) as typeof current.capabilities
                    } : current)
                  }}>
                    <option value="unconfigured">请选择协议（不会联网）</option>
                    <option value="ark-seedream">火山方舟 Seedream</option>
                    <option value="openai-images">OpenAI Images 兼容</option>
                    <option value="task-images">异步任务式 Images</option>
                  </select></label>}
                  <label className="provider-endpoint"><span>Base URL（也支持完整接口地址）</span><input aria-label={`${prefix} API 地址`} placeholder="https://…/v1" value={draft.baseUrl} onChange={(event) => {
                    const value = event.currentTarget.value
                    updateDraft(provider.id, (current) => ({ ...current, baseUrl: value }))
                  }} /></label>
                  {draft.kind === 'llm' && <div className="provider-resolved-endpoint"><span>实际请求地址</span><code>{draft.baseUrl === '' ? '填写地址后显示' : resolveLlmEndpoint(draft)}</code></div>}
                  {draft.kind === 'image' && <div className="provider-resolved-endpoint"><span>实际生成地址</span><code>{draft.baseUrl === '' || draft.protocol === 'unconfigured' ? '选择协议并填写地址后显示' : resolveImageEndpoint(draft, 'generate')}</code>{draft.protocol === 'openai-images' && <small>参考与编辑：{resolveImageEndpoint(draft, 'edit')}</small>}{draft.protocol === 'task-images' && <small>状态查询与下载地址会根据该服务的任务标识构造；每任务请求上限至少为 3 才能使用此服务。</small>}</div>}
                  <label><span>默认模型</span><input aria-label={`${prefix} 默认模型`} placeholder="未指定" value={draft.defaultModel} onChange={(event) => {
                    const value = event.currentTarget.value
                    updateDraft(provider.id, (current) => ({ ...current, defaultModel: value }))
                  }} /></label>
                  {draft.kind === 'llm' && <label><span>思考强度</span><select aria-label="LLM Provider 思考强度" value={draft.reasoningEffort} onChange={(event) => {
                    const reasoningEffort = event.currentTarget.value as LlmReasoningEffort
                    updateDraft(provider.id, (current) => current.kind === 'llm' ? { ...current, reasoningEffort } : current)
                  }}>{Object.entries(LLM_REASONING_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>}
                  {draft.kind === 'llm' && <label><span>图像理解细节</span><select aria-label="LLM Provider 图像细节" disabled={!draft.capabilities.vision} value={draft.imageDetail} onChange={(event) => {
                    const imageDetail = event.currentTarget.value as LlmImageDetail
                    updateDraft(provider.id, (current) => current.kind === 'llm' ? { ...current, imageDetail } : current)
                  }}>{Object.entries(LLM_IMAGE_DETAIL_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>}
                  {draft.kind === 'llm' && <label><span>输出上限 tokens</span><input aria-label="LLM Provider 输出上限" type="number" min={256} max={131072} step={256} value={draft.maxOutputTokens} onChange={(event) => {
                    const maxOutputTokens = Number(event.currentTarget.value)
                    updateDraft(provider.id, (current) => current.kind === 'llm' ? { ...current, maxOutputTokens } : current)
                  }} /></label>}
                  <label><span>{draft.kind === 'image' ? '图片任务总时限（秒）' : '单次请求上限（秒）'}</span><input aria-label={`${prefix} 超时`} type="number" min={1} max={300} step={1} value={draft.timeoutMs / 1000} onChange={(event) => {
                    const value = Number(event.currentTarget.value) * 1000
                    updateDraft(provider.id, (current) => ({ ...current, timeoutMs: value }))
                  }} /></label>
                </div>

                <p className="provider-time-policy" data-testid={`${provider.id}-effective-timeout`}>已保存：{provider.timeoutMs / 1000} 秒。{draft.kind === 'image'
                  ? '自任务首次开始起计时，包含准备、轮询和下载，排队不计入。单次网络请求也受此上限及任务剩余时间约束。重启保留原截止时间；新配置只影响新任务。'
                  : '每次请求自开始后计时；连接、首个响应和响应空闲还有各自上限。本轮剩余时间更短时会先停止请求。新配置不延长已经开始的 Agent 轮次。'}</p>

                {draft.kind === 'llm' && <details className="provider-transport-advanced">
                  <summary><span>传输与分层超时</span><small>高级 · 保存前严格校验</small></summary>
                  <div className="provider-public-grid">
                    <label><span>响应方式</span><select aria-label="LLM Provider 响应方式" value={draft.transport.mode} onChange={(event) => {
                      const mode = event.currentTarget.value as LlmTransportMode
                      updateDraft(provider.id, (current) => current.kind === 'llm' ? { ...current, transport: { ...current.transport, mode } } : current)
                    }}>
                      <option value="auto">自动（按已保存能力）</option>
                      <option value="stream">流式 SSE</option>
                      <option value="buffered">完整 JSON 响应</option>
                    </select></label>
                    {([
                      ['connectTimeoutMs', '连接上限（秒）', 60_000],
                      ['firstEventTimeoutMs', '首个响应上限（秒）', 120_000],
                      ['idleTimeoutMs', '响应空闲上限（秒）', 180_000]
                    ] as const).map(([field, label, max]) => <label key={field}>
                      <span>{label}</span>
                      <input
                        aria-label={`LLM Provider ${label}`}
                        type="number"
                        min={1}
                        max={max / 1000}
                        step={1}
                        value={draft.transport[field] / 1000}
                        aria-invalid={draft.transport[field] > draft.timeoutMs}
                        onChange={(event) => {
                          const value = Number(event.currentTarget.value) * 1000
                          updateDraft(provider.id, (current) => current.kind === 'llm'
                            ? { ...current, transport: { ...current.transport, [field]: value } }
                            : current)
                        }}
                      />
                    </label>)}
                  </div>
                  <p className={`provider-transport-note${[
                    draft.transport.connectTimeoutMs,
                    draft.transport.firstEventTimeoutMs,
                    draft.transport.idleTimeoutMs
                  ].some((value) => value > draft.timeoutMs) ? ' is-error' : ''}`}>
                    {[
                      draft.transport.connectTimeoutMs,
                      draft.transport.firstEventTimeoutMs,
                      draft.transport.idleTimeoutMs
                    ].some((value) => value > draft.timeoutMs)
                      ? '局部超时不能大于单次请求总上限；请修改后再保存。'
                      : draft.transport.mode === 'auto'
                        ? `能力声明为${draft.capabilities.streaming ? '支持' : '不支持'}流式，因此会使用${draft.capabilities.streaming ? '流式 SSE' : '完整 JSON 响应'}。失败后不会自动切换并重发 POST。`
                        : '响应方式在发送前唯一确定；失败后不会自动换协议或重复 POST。'}
                  </p>
                </details>}

                <div className="provider-capabilities" aria-label={`${prefix} 能力`}>
                  {draft.kind === 'llm' ? <>
                    <label><input type="checkbox" checked={draft.capabilities.streaming} onChange={(event) => {
                      const checked = event.currentTarget.checked
                      updateDraft(provider.id, (current) => current.kind === 'llm' ? { ...current, capabilities: { ...current.capabilities, streaming: checked } } : current)
                    }} />流式</label>
                    <label><input type="checkbox" checked={draft.capabilities.toolCalling} onChange={(event) => {
                      const checked = event.currentTarget.checked
                      updateDraft(provider.id, (current) => current.kind === 'llm' ? { ...current, capabilities: { ...current.capabilities, toolCalling: checked } } : current)
                    }} />工具调用</label>
                    <label><input type="checkbox" checked={draft.capabilities.vision} onChange={(event) => {
                      const checked = event.currentTarget.checked
                      updateDraft(provider.id, (current) => current.kind === 'llm' ? { ...current, capabilities: { ...current.capabilities, vision: checked } } : current)
                    }} />图像理解</label>
                  </> : <>
                    {([
                      ['textToImage', '文生图'],
                      ['imageReferences', '参考图'],
                      ['maskEditing', '蒙版编辑'],
                      ['multipleReferences', '多参考'],
                      ['transparentOutput', '透明输出']
                    ] as const).map(([capability, label]) => {
                      const supported = IMAGE_PROTOCOL_CAPABILITIES[draft.protocol].has(capability)
                      return <label key={capability} title={supported ? undefined : '当前协议实现不支持此能力'}><input type="checkbox" checked={supported && draft.capabilities[capability]} disabled={!supported} onChange={(event) => {
                      const checked = event.currentTarget.checked
                      updateDraft(provider.id, (current) => current.kind === 'image' ? { ...current, capabilities: { ...current.capabilities, [capability]: checked } } : current)
                    }} />{label}</label>
                    })}
                  </>}
                  <button type="button" onClick={() => validateLocal(provider.id)}>本地检查</button>
                  <button type="button" className="settings-save" disabled={busy !== null} onClick={() => void saveConfig(provider.id)}>保存公开配置</button>
                </div>

                <div className="provider-secret-controls">
                  <label>
                    <span className="visually-hidden">{provider.label} API Key</span>
                    <input
                      autoFocus={expandedProvider === provider.id}
                      type="password"
                      autoComplete="new-password"
                      aria-label={`${provider.label} API Key`}
                      value={secrets[provider.id]}
                      placeholder={provider.configured ? '输入新 Key 以替换' : 'Key 仅在本机输入'}
                      onChange={(event) => {
                        const nextValue = event.currentTarget.value
                        setSecrets((current) => ({ ...current, [provider.id]: nextValue }))
                      }}
                    />
                  </label>
                  <button type="button" className="settings-save" aria-label={`安全保存 ${provider.label} 凭据`} disabled={secrets[provider.id].trim().length < 8 || busy !== null} onClick={() => void saveSecret(provider.id)}>
                    {busy === provider.id ? '保存中' : '安全保存'}
                  </button>
                  {provider.configured && <button type="button" className="settings-delete" aria-label={`删除 ${provider.label} 凭据`} disabled={busy !== null} onClick={() => void removeSecret(provider.id)}><Trash2 size={14} /></button>}
                </div>
                <small className="provider-secret-note">更改公开配置不会读取、清除或迁移现有 Key；切换供应商时请在此主动替换凭据。思考强度与图像细节只有在目标协议支持时才会生效。</small>
                {draft.kind === 'llm' && (() => {
                  const saved = providerPublicConfigSchema.parse(provider)
                  const draftSaved = JSON.stringify(draft) === JSON.stringify(saved)
                  const canValidate = provider.configured && draftSaved && draft.baseUrl !== '' && draft.defaultModel !== '' && draft.capabilities.toolCalling
                  return <div className="provider-connection-check">
                    <div className="provider-connection-heading">
                      <span><strong>连接与工具调用</strong><small>{draftSaved ? '使用上方已保存配置' : '先保存更改，再验证连接'}</small></span>
                      <button type="button" disabled={!canValidate || busy !== null} onClick={() => setConnectionConfirming(true)}>验证工具调用</button>
                    </div>
                    {connectionConfirming && <div className="provider-connection-confirm" role="alert">
                      <AlertCircle size={16} />
                      <span><strong>将发出 1 个真实文字请求</strong><small>不生成图片；费用预留上限 ¥0.05；失败后不会自动重试。</small></span>
                      <button type="button" onClick={() => setConnectionConfirming(false)}>取消</button>
                      <button type="button" className="settings-save" onClick={() => void validateConnection()}>确认验证</button>
                    </div>}
                    {connectionResult !== null && <div className={`provider-connection-result${connectionResult.ok ? ' is-success' : ' is-failure'}`} role="status">
                      {connectionResult.ok ? <Check size={16} /> : <AlertCircle size={16} />}
                      <span>
                        <strong>{connectionResult.ok ? '连接正常，工具调用可用' : connectionResult.failure.title}</strong>
                        <small>{connectionResult.ok
                          ? `${LLM_PROTOCOL_LABELS[connectionResult.protocol]} · ${connectionResult.model} · 1 个请求`
                          : `${connectionResult.failure.detail} ${connectionResult.failure.nextAction}（本次已提交 ${connectionResult.requestsUsed} 个请求）`}</small>
                      </span>
                    </div>}
                  </div>
                })()}
                </div>}
              </article>
            )
          }) ?? <div className="settings-loading">正在读取本地安全状态…</div>}
          </>}
          </div>
        </div>
        <footer>
          <ShieldCheck size={15} />
          <span data-testid="provider-settings-status">{status}</span>
        </footer>
      </section>
    </div>
  )
}
