import { ChevronDown, MessageSquare } from 'lucide-react'
import { useRef } from 'react'
import type { CreativeBrief } from '../../../domain'

interface CreativeBriefSummaryProps {
  readonly brief: CreativeBrief
  onRevise(): void
}

function joined(values: readonly string[], fallback = '未单独说明'): string {
  const content = values.map((value) => value.trim()).filter(Boolean).join(' · ')
  return content || fallback
}

const SOURCE_COPY = {
  user: '用户明确提供',
  scene: '当前画布事实',
  agent_inference: 'Agent 推断',
  legacy_unattributed: '旧版未归因'
} as const

export function CreativeBriefSummary({ brief, onRevise }: CreativeBriefSummaryProps): React.JSX.Element {
  const detailsRef = useRef<HTMLDetailsElement>(null)
  const purpose = brief.version === 1 ? brief.intent : brief.purpose
  const styles = brief.version === 1 ? [] : brief.style
  const keep = brief.version === 1 ? brief.constraints : brief.keep
  const prohibitions = brief.version === 1 ? [] : brief.prohibitions
  const ambiguities = brief.version === 1 ? [] : brief.ambiguities
  const title = brief.originalRequirement
  const audience = brief.version === 3 ? brief.audience : []
  const acceptanceCriteria = brief.version === 3 ? brief.acceptanceCriteria : []
  const sources = brief.version === 3
    ? Object.entries(brief.fieldSources.reduce<Record<string, number>>((counts, source) => {
        counts[source.source] = (counts[source.source] ?? 0) + 1
        return counts
      }, {})).map(([source, count]) => `${SOURCE_COPY[source as keyof typeof SOURCE_COPY]} ${count}`)
    : []
  const detail = [...brief.mood, ...styles].slice(0, 4)

  return (
    <details ref={detailsRef} className="creative-brief-summary">
      <summary className="creative-brief-ribbon" aria-label="查看当前创作简报">
        <span>创作简报</span>
        <strong>{title}</strong>
        <small>{joined(detail, `${brief.subjects.length} 个主体 · ${brief.text.length} 处文字`)}</small>
        <ChevronDown size={12} aria-hidden="true" />
      </summary>
      <section className="creative-brief-detail" aria-label="当前创作简报详情">
        <header>
          <span>当前要求</span>
          <strong>{brief.originalRequirement}</strong>
        </header>
        <div className="creative-brief-facts">
          <article><span>目的</span><p>{purpose}</p></article>
          <article><span>画面意图</span><p>{brief.intent}</p></article>
          <article><span>主体</span><p>{joined(brief.subjects.map((subject) => `${subject.name}：${subject.description || subject.pose}`))}</p></article>
          <article><span>文字参考</span><p>{joined(brief.text.map((text) => `${text.content}（${text.mode === 'exact-overlay' ? '最终可编辑文字' : text.mode === 'image-text' ? 'AI 生成字效' : '排版与字效参考'}）`), '没有文字要求')}</p></article>
          {brief.version === 3 && <article><span>受众</span><p>{joined(audience, '未限定特定受众')}</p></article>}
          <article><span>保持</span><p>{joined(keep)}</p></article>
          <article><span>避免</span><p>{joined(prohibitions)}</p></article>
          {brief.version === 3 && <article><span>字段来源</span><p>{joined(sources, '尚无来源记录')}</p></article>}
        </div>
        {acceptanceCriteria.length > 0 && (
          <div className="creative-brief-criteria">
            <span>验收标准</span>
            {acceptanceCriteria.map((criterion) => (
              <p key={criterion.id}><b>{criterion.priority === 'must' ? '必须' : '优先'}</b>{criterion.criterion}</p>
            ))}
          </div>
        )}
        {ambiguities.length > 0 && (
          <div className="creative-brief-ambiguities">
            <span>仍待确认</span>
            {ambiguities.map((ambiguity) => <p key={ambiguity.id}>{ambiguity.question}</p>)}
          </div>
        )}
        <footer>
          <span>{brief.version === 3 ? `当前为可追溯简报；创建于 ${new Date(brief.createdAt).toLocaleString('zh-CN')}。` : '当前为兼容读取的旧版简报；只有明确修正时才会生成可追溯新版本。'} 修正会作为新一轮明确要求提交，不会静默改写。</span>
          <button type="button" onClick={() => { detailsRef.current?.removeAttribute('open'); onRevise() }}><MessageSquare size={13} />用对话修正</button>
        </footer>
      </section>
    </details>
  )
}
