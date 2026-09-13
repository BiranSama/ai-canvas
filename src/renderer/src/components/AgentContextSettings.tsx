import { Check, ChevronDown, CircleOff, Plus, RotateCcw, ShieldCheck, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  OutboundContextPolicy,
  ProjectDirectiveCategory,
  ProjectKnowledgeSnapshot,
  ProjectMemoryEntry,
  ProjectMemoryKind
} from '../../../shared/agent-context'

const POLICY_LABELS: Record<OutboundContextPolicy, string> = {
  minimal: '最小必要外发',
  review_each_image: '每张图片先确认',
  local_only: '仅本地',
  custom: '自定义白名单'
}

const MEMORY_KIND_LABELS: Record<ProjectMemoryKind, string> = {
  fact: '事实',
  choice: '选择',
  direction: '方向',
  constraint: '约束'
}

const DIRECTIVE_CATEGORY_LABELS: Record<ProjectDirectiveCategory, string> = {
  creative: '创意',
  content: '内容',
  workflow: '流程',
  privacy: '隐私'
}

export function AgentContextSettings({ onStatus }: { readonly onStatus: (message: string) => void }): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<ProjectKnowledgeSnapshot | null>(null)
  const [busy, setBusy] = useState(false)
  const [directiveText, setDirectiveText] = useState('')
  const [directiveCategory, setDirectiveCategory] = useState<ProjectDirectiveCategory>('creative')
  const [memoryText, setMemoryText] = useState('')
  const [memoryKind, setMemoryKind] = useState<ProjectMemoryKind>('direction')
  const [editingMemory, setEditingMemory] = useState<ProjectMemoryEntry | null>(null)

  const load = useCallback((): void => {
    void window.desktop.getProjectKnowledge().then(setSnapshot).catch((error: unknown) => {
      onStatus(error instanceof Error ? error.message : '无法读取项目上下文。')
    })
  }, [onStatus])

  useEffect(load, [load])

  const mutate = async (operation: () => Promise<ProjectKnowledgeSnapshot>, success: string): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      setSnapshot(await operation())
      onStatus(success)
    } catch (error) {
      onStatus(error instanceof Error ? error.message : '项目上下文没有改变。')
    } finally {
      setBusy(false)
    }
  }

  const manifestStats = useMemo(() => {
    const manifest = snapshot?.latestManifest
    if (manifest === null || manifest === undefined) return null
    return {
      inline: manifest.entries.filter((entry) => entry.disposition === 'inline').length,
      onDemand: manifest.entries.filter((entry) => entry.disposition === 'tool_available').length,
      excluded: manifest.entries.filter((entry) => entry.disposition === 'excluded').length
    }
  }, [snapshot])

  if (snapshot === null) return <div className="settings-loading">正在读取 Agent 上下文与项目记忆…</div>

  return (
    <section className="agent-context-settings" data-testid="agent-context-settings">
      <div className="agent-context-heading">
        <div>
          <span className="settings-kicker">Agent 上下文</span>
          <h2>上下文与项目记忆</h2>
          <p>你能看到 Agent 本轮读取了什么。长期规则是指令；已确认事实与方向是记忆；两者都不能扩大权限。</p>
        </div>
        <button type="button" className="context-refresh" aria-label="刷新 Agent 上下文" onClick={load}><RotateCcw size={13} /></button>
      </div>

      <article className="context-policy-card">
        <div>
          <ShieldCheck size={17} />
          <span><strong>外发策略</strong><small>Owner Full 允许已配置 Provider；这里继续限定每轮哪些文字和图片可以离开本机。</small></span>
        </div>
        <label>
          <span className="visually-hidden">Agent 外发策略</span>
          <select
            aria-label="Agent 外发策略"
            value={snapshot.outboundPolicy}
            disabled={busy}
            onChange={(event) => {
              const policy = event.currentTarget.value as OutboundContextPolicy
              void mutate(() => window.desktop.setOutboundPolicy({
                policy,
                expectedVersion: snapshot.outboundPolicyVersion
              }), `外发策略已设为“${POLICY_LABELS[policy]}”；没有发起网络请求。`)
            }}
          >
            {(Object.keys(POLICY_LABELS) as OutboundContextPolicy[]).map((policy) => (
              <option key={policy} value={policy}>{POLICY_LABELS[policy]}</option>
            ))}
          </select>
        </label>
      </article>

      <div className="context-column-grid">
        <article className="knowledge-card">
          <header><div><span>长期指令</span><strong>项目规则</strong></div><small>{snapshot.directives.filter((entry) => entry.enabled).length} 条启用</small></header>
          <div className="knowledge-compose">
            <textarea aria-label="新增项目规则" rows={2} maxLength={4_000} placeholder="例如：品牌名始终保留英文" value={directiveText} onChange={(event) => setDirectiveText(event.currentTarget.value)} />
            <div>
              <select aria-label="项目规则分类" value={directiveCategory} onChange={(event) => setDirectiveCategory(event.currentTarget.value as ProjectDirectiveCategory)}>
                {(Object.keys(DIRECTIVE_CATEGORY_LABELS) as ProjectDirectiveCategory[]).map((category) => <option key={category} value={category}>{DIRECTIVE_CATEGORY_LABELS[category]}</option>)}
              </select>
              <button type="button" disabled={busy || directiveText.trim().length === 0} onClick={() => void mutate(async () => {
                const next = await window.desktop.createProjectDirective({ text: directiveText, category: directiveCategory, priority: 100, sourceMessageId: null })
                setDirectiveText('')
                return next
              }, '项目规则已保存并进入版本控制。')}><Plus size={13} />添加</button>
            </div>
          </div>
          <div className="knowledge-list">
            {snapshot.directives.length === 0 && <p className="knowledge-empty">还没有长期项目规则。</p>}
            {snapshot.directives.map((directive) => (
              <div key={directive.id} className={!directive.enabled ? 'is-disabled' : ''}>
                <span className="knowledge-copy"><small>{DIRECTIVE_CATEGORY_LABELS[directive.category]} · v{directive.version}</small><strong>{directive.text}</strong></span>
                <button type="button" disabled={busy} aria-label={`${directive.enabled ? '停用' : '启用'}规则 ${directive.text}`} onClick={() => void mutate(() => window.desktop.updateProjectDirective({
                  id: directive.id,
                  expectedVersion: directive.version,
                  enabled: !directive.enabled
                }), directive.enabled ? '项目规则已停用；历史仍保留。' : '项目规则已重新启用。')}>
                  {directive.enabled ? <CircleOff size={13} /> : <Check size={13} />}
                </button>
              </div>
            ))}
          </div>
        </article>

        <article className="knowledge-card">
          <header><div><span>长期事实</span><strong>已确认记忆</strong></div><small>{snapshot.memories.filter((entry) => entry.status === 'active').length} 条有效</small></header>
          <div className="knowledge-compose">
            <textarea aria-label={editingMemory === null ? '新增项目记忆' : '编辑项目记忆'} rows={2} maxLength={4_000} placeholder="例如：本项目采用克制的银蓝色调" value={memoryText} onChange={(event) => setMemoryText(event.currentTarget.value)} />
            <div>
              <select aria-label="项目记忆类型" value={memoryKind} onChange={(event) => setMemoryKind(event.currentTarget.value as ProjectMemoryKind)}>
                {(Object.keys(MEMORY_KIND_LABELS) as ProjectMemoryKind[]).map((kind) => <option key={kind} value={kind}>{MEMORY_KIND_LABELS[kind]}</option>)}
              </select>
              {editingMemory !== null && <button type="button" className="knowledge-cancel" onClick={() => { setEditingMemory(null); setMemoryText('') }}><X size={12} />取消</button>}
              <button type="button" disabled={busy || memoryText.trim().length === 0} onClick={() => void mutate(async () => {
                const next = editingMemory === null
                  ? await window.desktop.createProjectMemory({
                      kind: memoryKind, content: memoryText, sourceType: 'user', sourceId: 'settings', confidence: 1, supersedesId: null
                    })
                  : await window.desktop.updateProjectMemory({
                      id: editingMemory.id, expectedVersion: editingMemory.version, kind: memoryKind, content: memoryText
                    })
                setEditingMemory(null)
                setMemoryText('')
                return next
              }, editingMemory === null ? '已保存明确的项目记忆。' : '已创建新的记忆版本，旧版本保留为被替代记录。')}>
                {editingMemory === null ? <Plus size={13} /> : <Check size={13} />}{editingMemory === null ? '添加' : '保存'}
              </button>
            </div>
          </div>
          <div className="knowledge-list">
            {snapshot.memories.length === 0 && <p className="knowledge-empty">还没有已确认的项目记忆。</p>}
            {snapshot.memories.map((memory) => (
              <div key={memory.id} className={memory.status !== 'active' ? 'is-disabled' : ''}>
                <button type="button" className="knowledge-copy" disabled={memory.status !== 'active'} onClick={() => {
                  setEditingMemory(memory)
                  setMemoryText(memory.content)
                  setMemoryKind(memory.kind)
                }}>
                  <small>{MEMORY_KIND_LABELS[memory.kind]} · {memory.status} · v{memory.version}</small><strong>{memory.content}</strong>
                </button>
                {memory.status === 'active' && <>
                  <button type="button" disabled={busy} aria-label={`停用记忆 ${memory.content}`} onClick={() => void mutate(() => window.desktop.updateProjectMemory({
                    id: memory.id, expectedVersion: memory.version, status: 'disabled'
                  }), '项目记忆已停用；审计历史仍保留。')}><CircleOff size={13} /></button>
                  <button type="button" disabled={busy} aria-label={`删除记忆 ${memory.content}`} onClick={() => void mutate(() => window.desktop.updateProjectMemory({
                    id: memory.id, expectedVersion: memory.version, status: 'deleted'
                  }), '项目记忆已从未来上下文删除；审计历史仍保留。')}><Trash2 size={13} /></button>
                </>}
              </div>
            ))}
          </div>
        </article>
      </div>

      {snapshot.candidates.some((candidate) => candidate.status === 'pending') && (
        <article className="knowledge-card memory-candidate-card">
          <header><div><span>记忆候选</span><strong>等待你确认的推断</strong></div><small>不会自动进入长期上下文</small></header>
          <div className="knowledge-list">
            {snapshot.candidates.filter((candidate) => candidate.status === 'pending').map((candidate) => (
              <div key={candidate.id}>
                <span className="knowledge-copy"><small>{MEMORY_KIND_LABELS[candidate.kind]} · 置信度 {Math.round(candidate.confidence * 100)}%</small><strong>{candidate.content}</strong></span>
                <button type="button" disabled={busy} onClick={() => void mutate(() => window.desktop.resolveMemoryCandidate({ id: candidate.id, expectedVersion: candidate.version, resolution: 'confirm' }), '候选已确认并写入项目记忆。')}><Check size={13} /></button>
                <button type="button" disabled={busy} onClick={() => void mutate(() => window.desktop.resolveMemoryCandidate({ id: candidate.id, expectedVersion: candidate.version, resolution: 'reject' }), '候选已拒绝，不会进入项目记忆。')}><X size={13} /></button>
              </div>
            ))}
          </div>
        </article>
      )}

      <div className="context-audit-grid">
        <details className="context-audit-card" open={snapshot.latestManifest !== null}>
          <summary><span><ChevronDown size={13} /><strong>最近 Context Manifest</strong></span><small>{snapshot.latestManifest === null ? '尚未运行 Agent' : `${manifestStats?.inline ?? 0} 内联 · ${manifestStats?.onDemand ?? 0} 按需 · ${manifestStats?.excluded ?? 0} 排除`}</small></summary>
          {snapshot.latestManifest !== null && <div className="context-entry-list">
            <p>Scene r{snapshot.latestManifest.sceneRevision} · {snapshot.latestManifest.estimatedTextBytes} bytes · {POLICY_LABELS[snapshot.latestManifest.outboundPolicy]}</p>
            {snapshot.latestManifest.entries.map((entry) => (
              <div key={entry.id}><span>{entry.sourceType}</span><strong>{entry.scope}</strong><small>{entry.disposition} · {entry.reason}</small></div>
            ))}
          </div>}
        </details>
        <details className="context-audit-card">
          <summary><span><ChevronDown size={13} /><strong>外发记录</strong></span><small>{snapshot.outboundRecords.length} 条</small></summary>
          <div className="context-entry-list">
            {snapshot.outboundRecords.length === 0 && <p>还没有外发记录；只有实际准备或调用 Provider 后才会出现。</p>}
            {snapshot.outboundRecords.map((record) => (
              <div key={record.id}>
                <span>{record.status}</span>
                <strong>{record.providerId ?? '未指定供应商'}</strong>
                <small>
                  {record.dataTypes.join(' · ') || '无数据'} · {record.imageCount} 张 · {record.imageBytes === null ? '历史字节未计量' : `${record.imageBytes} bytes`} · {record.approvalId === null ? '按策略执行' : '用户已批准'} · {record.reason}
                </small>
              </div>
            ))}
          </div>
        </details>
      </div>
    </section>
  )
}
