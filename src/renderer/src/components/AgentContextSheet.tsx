import { BookOpen, Files, LockKeyhole, Send, ShieldCheck, X } from 'lucide-react'
import { useMemo, useRef } from 'react'
import { useModalScope } from '../interaction/use-modal-scope'
import type { AgentHarnessSnapshot } from '../../../shared/agent-harness'
import type { ContextDisposition, ProjectKnowledgeSnapshot } from '../../../shared/agent-context'

interface AgentContextSheetProps {
  readonly harness: AgentHarnessSnapshot | null
  readonly knowledge: ProjectKnowledgeSnapshot | null
  readonly onClose: () => void
}

const DISPOSITION_COPY: Record<ContextDisposition, string> = {
  inline: '本轮已采用',
  tool_available: '需要时读取',
  outbound: '允许外发',
  excluded: '明确排除'
}

const POLICY_COPY: Record<ProjectKnowledgeSnapshot['outboundPolicy'], string> = {
  minimal: '最小外发',
  review_each_image: '逐图确认',
  local_only: '仅本地',
  custom: '自定义边界'
}

function shortText(value: string, limit = 96): string {
  return value.length <= limit ? value : `${value.slice(0, limit).trim()}…`
}

export function AgentContextSheet({ harness, knowledge, onClose }: AgentContextSheetProps): React.JSX.Element {
  const closeRef = useRef<HTMLButtonElement>(null)
  const modalRef = useRef<HTMLElement>(null)
  useModalScope(modalRef, onClose, { initialFocus: closeRef })
  const manifest = knowledge?.latestManifest ?? null
  const entriesByDisposition = useMemo(() => {
    const counts: Record<ContextDisposition, number> = { inline: 0, tool_available: 0, outbound: 0, excluded: 0 }
    for (const entry of manifest?.entries ?? []) counts[entry.disposition] += 1
    return counts
  }, [manifest])
  const activeDirectives = (knowledge?.directives ?? []).filter((directive) => directive.enabled)
  const activeMemories = (knowledge?.memories ?? []).filter((memory) => memory.status === 'active')
  const excluded = (manifest?.entries ?? []).filter((entry) => entry.disposition === 'excluded')
  const outbound = knowledge?.outboundRecords.slice(0, 3) ?? []

  return (
    <div className="agent-context-scrim" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <section
        ref={modalRef}
        tabIndex={-1}
        className="agent-context-sheet glass-surface"
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-context-title"
      >
        <header>
          <div>
            <span>可核对的工作边界</span>
            <h2 id="agent-context-title">本轮上下文</h2>
            <p>这里展示 Harness 实际采用、按需读取和排除的内容，不展示内部推理。</p>
          </div>
          <button ref={closeRef} type="button" aria-label="关闭本轮上下文" onClick={onClose}><X size={15} /></button>
        </header>

        <div className="context-sheet-overview">
          <article>
            <ShieldCheck size={14} />
            <span>运行模式</span>
            <strong>{harness?.activeGoal?.mode === 'review' ? '审阅' : harness?.activeGoal?.mode === 'auto' ? '自动' : '协作'}</strong>
          </article>
          <article>
            <Files size={14} />
            <span>Scene 版本</span>
            <strong>{manifest === null ? '尚未构建' : `r${manifest.sceneRevision}`}</strong>
          </article>
          <article>
            <Send size={14} />
            <span>外发策略</span>
            <strong>{POLICY_COPY[knowledge?.outboundPolicy ?? 'minimal']}</strong>
          </article>
          <article>
            <LockKeyhole size={14} />
            <span>真实调用</span>
            <strong>按 Owner 策略</strong>
          </article>
        </div>

        <div className="context-sheet-columns">
          <section>
            <header><span><BookOpen size={13} />已采用</span><small>{entriesByDisposition.inline} 项</small></header>
            <div className="context-sheet-list">
              {activeDirectives.slice(0, 3).map((directive) => (
                <article key={directive.id}><span>项目规则</span><p>{shortText(directive.text)}</p></article>
              ))}
              {activeMemories.slice(0, 3).map((memory) => (
                <article key={memory.id}><span>已确认记忆</span><p>{shortText(memory.content)}</p></article>
              ))}
              {activeDirectives.length + activeMemories.length === 0 && <p className="context-sheet-empty">当前没有项目规则或已确认记忆。</p>}
            </div>
          </section>

          <section>
            <header><span><Send size={13} />外发与排除</span><small>{entriesByDisposition.outbound} 外发 · {entriesByDisposition.excluded} 排除</small></header>
            <div className="context-sheet-list">
              {outbound.map((record) => (
                <article key={record.id}>
                  <span>{record.status === 'sent' ? '已发送' : record.status === 'blocked' ? '已阻止' : '已准备'}</span>
                  <p>{record.providerId ?? '本地'} · {record.imageCount} 图 · {record.textBytes} B</p>
                </article>
              ))}
              {outbound.length === 0 && <p className="context-sheet-empty">尚无 Provider 外发记录；每次外发都会在这里留下范围与状态。</p>}
              {excluded.slice(0, 3).map((entry) => (
                <article key={entry.id}><span>{DISPOSITION_COPY[entry.disposition]}</span><p>{shortText(entry.reason)}</p></article>
              ))}
            </div>
          </section>
        </div>

        <footer>
          <span>{manifest === null ? '开始一轮后会生成可追溯清单' : `${manifest.entries.length} 项来源 · ${manifest.estimatedTextBytes} B 文本 · ${manifest.imageCount} 张图片`}</span>
          <span>规则、记忆、Scene 与外发记录均来自本地 Ledger</span>
        </footer>
      </section>
    </div>
  )
}
