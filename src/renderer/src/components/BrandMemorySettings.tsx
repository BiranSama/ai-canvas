import { Check, CircleOff, ImagePlus, Plus, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  MAX_BRAND_COLORS,
  MAX_BRAND_COPY,
  type UserMemoryEntry,
  type UserMemoryKind,
  type UserMemorySnapshot
} from '../../../shared/user-memory'
import { brandInputOf, draftOf, type BrandDraft } from './brand-draft'
import { FontPicker } from './FontPicker'

const KIND_LABELS: Record<UserMemoryKind, string> = { preference: '偏好', fact: '事实' }
const SOURCE_LABELS: Record<UserMemoryEntry['source'], string> = { user: '你写的', agent: 'Agent 提议', learned: '从使用中学到' }
const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const

/**
 * 品牌与记忆: the brand and the preferences and facts every project reads,
 * kept on this computer. Learned preferences wait here until confirmed.
 */
export function BrandMemorySettings({ onStatus }: { readonly onStatus: (message: string) => void }): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<UserMemorySnapshot | null>(null)
  const [draft, setDraft] = useState<BrandDraft | null>(null)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [memoryText, setMemoryText] = useState('')
  const [memoryKind, setMemoryKind] = useState<UserMemoryKind>('preference')
  const [editing, setEditing] = useState<UserMemoryEntry | null>(null)
  const logoInput = useRef<HTMLInputElement>(null)
  const dirtyRef = useRef(false)
  useEffect(() => { dirtyRef.current = dirty }, [dirty])

  const receive = useCallback((value: UserMemorySnapshot, keepDraft = false): void => {
    setSnapshot(value)
    if (!keepDraft) {
      setDraft(draftOf(value))
      setDirty(false)
    }
  }, [])

  useEffect(() => {
    let mounted = true
    const load = (): void => {
      void window.desktop.getUserMemory()
        .then((value) => { if (mounted) receive(value, dirtyRef.current) })
        .catch((error: unknown) => onStatus(error instanceof Error ? error.message : '没有读到品牌与记忆。'))
    }
    load()
    const off = (window.desktop as Partial<typeof window.desktop>).onUserMemoryChanged?.(load)
    return () => { mounted = false; off?.() }
  }, [onStatus, receive])

  const mutate = async (operation: () => Promise<UserMemorySnapshot>, success: string, keepDraft = true): Promise<boolean> => {
    if (busy) return false
    setBusy(true)
    try {
      receive(await operation(), keepDraft)
      onStatus(success)
      return true
    } catch (error) {
      onStatus(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : '没有保存。')
      return false
    } finally {
      setBusy(false)
    }
  }

  const edit = (changes: Partial<BrandDraft>): void => {
    setDraft((current) => current === null ? current : { ...current, ...changes })
    setDirty(true)
  }

  const saveBrand = (): void => {
    if (draft === null) return
    const input = brandInputOf(draft)
    if (typeof input === 'string') {
      onStatus(input)
      return
    }
    void mutate(() => window.desktop.saveBrandKit(input), '品牌已保存，之后每一轮 Agent 都会参考。', false)
  }

  const uploadLogo = async (file: File): Promise<void> => {
    const mimeType = LOGO_TYPES.find((type) => type === file.type)
    if (mimeType === undefined) {
      onStatus('Logo 要是 PNG、JPG 或 WebP。')
      return
    }
    const bytes = new Uint8Array(await file.arrayBuffer())
    await mutate(() => window.desktop.setBrandLogo({ mimeType, bytes }), 'Logo 已换上。')
  }

  if (snapshot === null || draft === null) return <div className="settings-loading">正在读取品牌与记忆…</div>

  const pending = snapshot.candidates.filter((candidate) => candidate.status === 'pending')

  return (
    <section className="agent-context-settings brand-memory-settings" data-testid="brand-memory-settings">
      <div className="agent-context-heading">
        <div>
          <span className="settings-kicker">所有作品共用</span>
          <h2>品牌与记忆</h2>
          <p>这里的品牌和偏好存在这台电脑上，每个作品的 Agent 都会参考；和你本轮的要求或项目规则冲突时，以本轮和项目规则为准。某个作品不想用品牌，到「项目记忆」里关掉。</p>
        </div>
      </div>

      <article className="knowledge-card brand-card" aria-label="品牌">
        <header><div><span>品牌</span><strong>{snapshot.brand.name === '' ? '还没有品牌名' : snapshot.brand.name}</strong></div><small>{dirty ? '有改动没保存' : '已保存'}</small></header>
        <div className="brand-form">
          <label className="brand-field"><span>品牌名</span><input aria-label="品牌名" maxLength={80} placeholder="例如：晨雾咖啡" value={draft.name} onChange={(event) => edit({ name: event.currentTarget.value })} /></label>
          <div className="brand-field">
            <span>Logo</span>
            <div className="brand-logo-row">
              <div className="brand-logo-preview" data-testid="brand-logo-preview">
                {snapshot.logoPreview === null ? <small>没有 Logo</small> : <img src={snapshot.logoPreview} alt="品牌 Logo" />}
              </div>
              <input ref={logoInput} type="file" hidden accept={LOGO_TYPES.join(',')} aria-label="选择 Logo 文件" onChange={(event) => {
                const file = event.currentTarget.files?.[0]
                event.currentTarget.value = ''
                if (file !== undefined) void uploadLogo(file)
              }} />
              <button type="button" disabled={busy} onClick={() => logoInput.current?.click()}><ImagePlus size={13} />{snapshot.brand.logo === null ? '上传 Logo' : '换一个'}</button>
              {snapshot.brand.logo !== null && <button type="button" disabled={busy} aria-label="删除 Logo" onClick={() => void mutate(() => window.desktop.clearBrandLogo(), 'Logo 已删除。')}><Trash2 size={13} /></button>}
            </div>
          </div>
          <div className="brand-field">
            <span>主色（最多 {MAX_BRAND_COLORS} 个）</span>
            <div className="brand-colors">
              {draft.colors.map((color, index) => (
                <span key={index} className="brand-color">
                  <input type="color" aria-label={`主色 ${index + 1}`} value={color} onChange={(event) => edit({ colors: draft.colors.map((value, at) => at === index ? event.currentTarget.value : value) })} />
                  <button type="button" aria-label={`去掉主色 ${index + 1}`} onClick={() => edit({ colors: draft.colors.filter((_, at) => at !== index) })}><X size={11} /></button>
                </span>
              ))}
              {draft.colors.length < MAX_BRAND_COLORS && <button type="button" onClick={() => edit({ colors: [...draft.colors, '#3b6fb6'] })}><Plus size={12} />加一个颜色</button>}
            </div>
          </div>
          {(['titleFont', 'bodyFont'] as const).map((field) => (
            <div key={field} className="brand-field">
              <span>{field === 'titleFont' ? '标题字体' : '正文字体'}</span>
              <div className="brand-font-row">
                <FontPicker value={draft[field]} onChange={(family) => edit({ [field]: family })} />
                {draft[field] !== '' && <button type="button" aria-label={`不指定${field === 'titleFont' ? '标题' : '正文'}字体`} onClick={() => edit({ [field]: '' })}><X size={12} />不指定</button>}
              </div>
            </div>
          ))}
          <label className="brand-field"><span>常用文案（一行一条，最多 {MAX_BRAND_COPY} 条）</span><textarea aria-label="常用文案" rows={3} placeholder={'例如：每天新鲜烘焙\n营业时间 8:00–20:00'} value={draft.copy} onChange={(event) => edit({ copy: event.currentTarget.value })} /></label>
          <label className="brand-field"><span>禁用词（画面上的字不出现，用逗号或顿号隔开）</span><textarea aria-label="禁用词" rows={2} placeholder="例如：最、第一、全网最低" value={draft.bannedWords} onChange={(event) => edit({ bannedWords: event.currentTarget.value })} /></label>
          <div className="brand-actions">
            {dirty && <button type="button" disabled={busy} onClick={() => { setDraft(draftOf(snapshot)); setDirty(false) }}>不保存</button>}
            <button type="button" className="is-primary" disabled={busy || !dirty} onClick={saveBrand}><Check size={13} />保存品牌</button>
          </div>
        </div>
      </article>

      {pending.length > 0 && (
        <article className="knowledge-card memory-candidate-card" aria-label="等你确认的偏好">
          <header><div><span>候选</span><strong>有 {pending.length} 条偏好等你确认</strong></div><small>确认才会生效；忽略的不再提</small></header>
          <div className="knowledge-list">
            {pending.map((candidate) => (
              <div key={candidate.id}>
                <span className="knowledge-copy"><small>{KIND_LABELS[candidate.kind]} · {candidate.source === 'learned' ? '从使用中学到' : 'Agent 提议'}</small><strong>{candidate.content}</strong></span>
                <button type="button" disabled={busy} aria-label={`确认 ${candidate.content}`} onClick={() => void mutate(() => window.desktop.changeUserMemory({ action: 'confirm', id: candidate.id }), '已记下，之后所有作品都会参考。')}><Check size={13} /></button>
                <button type="button" disabled={busy} aria-label={`忽略 ${candidate.content}`} onClick={() => void mutate(() => window.desktop.changeUserMemory({ action: 'ignore', id: candidate.id }), '已忽略，不会再提。')}><X size={13} /></button>
              </div>
            ))}
          </div>
        </article>
      )}

      <article className="knowledge-card" aria-label="偏好与事实">
        <header><div><span>所有作品</span><strong>偏好与事实</strong></div><small>{snapshot.memories.filter((entry) => entry.enabled).length} 条在用</small></header>
        <div className="knowledge-compose">
          <textarea aria-label={editing === null ? '新增偏好或事实' : '修改偏好或事实'} rows={2} maxLength={1_000} placeholder="例如：版面喜欢留白多一些；店在杭州，卖手冲咖啡" value={memoryText} onChange={(event) => setMemoryText(event.currentTarget.value)} />
          <div>
            <select aria-label="偏好或事实" value={memoryKind} onChange={(event) => setMemoryKind(event.currentTarget.value as UserMemoryKind)}>
              {(Object.keys(KIND_LABELS) as UserMemoryKind[]).map((kind) => <option key={kind} value={kind}>{KIND_LABELS[kind]}</option>)}
            </select>
            {editing !== null && <button type="button" className="knowledge-cancel" onClick={() => { setEditing(null); setMemoryText('') }}><X size={12} />取消</button>}
            <button type="button" disabled={busy || memoryText.trim() === ''} onClick={() => void mutate(() => window.desktop.changeUserMemory(editing === null
              ? { action: 'add', kind: memoryKind, content: memoryText.trim() }
              : { action: 'edit', id: editing.id, kind: memoryKind, content: memoryText.trim() }), editing === null ? '已记下。' : '已改好。').then((done) => {
              if (!done) return
              setEditing(null)
              setMemoryText('')
            })}>
              {editing === null ? <Plus size={13} /> : <Check size={13} />}{editing === null ? '添加' : '保存'}
            </button>
          </div>
        </div>
        <div className="knowledge-list">
          {snapshot.memories.length === 0 && <p className="knowledge-empty">还没有。可以在这里写，也可以对 Agent 说「以后都……」。</p>}
          {snapshot.memories.map((entry) => (
            <div key={entry.id} className={entry.enabled ? '' : 'is-disabled'}>
              <button type="button" className="knowledge-copy" onClick={() => { setEditing(entry); setMemoryText(entry.content); setMemoryKind(entry.kind) }}>
                <small>{KIND_LABELS[entry.kind]} · {SOURCE_LABELS[entry.source]}{entry.enabled ? '' : ' · 已停用'}</small><strong>{entry.content}</strong>
              </button>
              <button type="button" disabled={busy} aria-label={`${entry.enabled ? '停用' : '启用'} ${entry.content}`} onClick={() => void mutate(() => window.desktop.changeUserMemory({ action: 'enable', id: entry.id, enabled: !entry.enabled }), entry.enabled ? '已停用。' : '已启用。')}>
                {entry.enabled ? <CircleOff size={13} /> : <Check size={13} />}
              </button>
              <button type="button" disabled={busy} aria-label={`删除 ${entry.content}`} onClick={() => void mutate(() => window.desktop.changeUserMemory({ action: 'remove', id: entry.id }), '已删除。')}><Trash2 size={13} /></button>
            </div>
          ))}
        </div>
      </article>

      <label className="settings-switch-row">
        <input aria-label="从使用中学偏好" type="checkbox" checked={snapshot.learning.enabled} disabled={busy} onChange={(event) => {
          const enabled = event.currentTarget.checked
          // The switch moves at once; a failed save puts it back.
          const before = snapshot
          setSnapshot({ ...snapshot, learning: { ...snapshot.learning, enabled } })
          void mutate(() => window.desktop.changeUserMemory({ action: 'learning', enabled }), enabled ? '会从使用中学偏好。' : '不再记新的信号。')
            .then((saved) => { if (!saved) setSnapshot(before) })
        }} />
        <span>
          <strong>从使用中学偏好</strong>
          <small>记下你采用、撤销了哪一轮，手动改了什么，对作品说了什么（只有文字，没有图片）。每攒够 12 条，用快模型总结成偏好候选，等你确认才生效。已记 {snapshot.learning.signals} 条。</small>
        </span>
      </label>
      <div className="brand-actions">
        <button type="button" disabled={busy || snapshot.learning.signals === 0} onClick={() => void mutate(() => window.desktop.changeUserMemory({ action: 'clear-signals' }), '已清空记下的信号。')}>清空记下的信号</button>
      </div>
    </section>
  )
}
