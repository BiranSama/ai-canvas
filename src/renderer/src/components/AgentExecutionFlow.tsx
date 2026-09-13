import { Check, ChevronDown, CircleAlert, Clock3, RotateCcw, Settings2, Square } from 'lucide-react'
import type { AgentExecutionFlow, AgentExecutionStage } from '../agent/agent-execution-flow'
import { formatTimeLimit } from '../../../shared/execution-timing'

interface AgentExecutionFlowProps {
  readonly flow: AgentExecutionFlow
  readonly expanded: boolean
  readonly onToggle: () => void
  readonly onCancel: () => void
  readonly onRestoreRequest: () => void
  readonly showCancel?: boolean
}

const STATE_COPY: Readonly<Record<AgentExecutionStage['state'], string>> = {
  queued: '待开始',
  running: '正在进行',
  waiting: '等待继续',
  completed: '已完成',
  failed: '未完成',
  cancelled: '已停止'
}

function durationCopy(durationMs: number | null): string | null {
  if (durationMs === null) return null
  if (durationMs < 1_000) return `${durationMs} 毫秒`
  return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)} 秒`
}

function compactDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.floor(durationMs / 1_000))
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  return `${minutes} 分 ${seconds % 60} 秒`
}

function StageNode({ stage }: { readonly stage: AgentExecutionStage }): React.JSX.Element {
  const duration = durationCopy(stage.durationMs)
  return (
    <li
      className={`agent-execution-stage kind-${stage.kind} state-${stage.state}`}
      aria-current={stage.state === 'running' || stage.state === 'waiting' ? 'step' : undefined}
      data-stage-kind={stage.kind}
      data-stage-state={stage.state}
    >
      <span className="execution-stage-node" aria-hidden="true">
        {stage.state === 'completed' ? <Check size={12} /> : stage.state === 'failed' ? <CircleAlert size={12} /> : <span />}
      </span>
      <span className="execution-stage-copy">
        <span className="execution-stage-title">
          {stage.categoryLabel !== null && <small>{stage.categoryLabel}</small>}
          <strong>{stage.label}</strong>
        </span>
        <span>{stage.detail}</span>
        {(stage.scopeLabel !== null || duration !== null) && (
          <small className="execution-stage-meta">
            {stage.scopeLabel !== null && <span>{stage.scopeLabel}</span>}
            {duration !== null && <span><Clock3 size={10} />{duration}</span>}
          </small>
        )}
      </span>
      <small className="execution-stage-state">{STATE_COPY[stage.state]}</small>
    </li>
  )
}

export function AgentExecutionFlowView({ flow, expanded, onToggle, onCancel, onRestoreRequest, showCancel = true }: AgentExecutionFlowProps): React.JSX.Element {
  const stallAnnouncement = flow.stallLevel === 'long'
    ? '模型响应等待时间较长。不操作会继续等待，也可以停止。'
    : flow.stallLevel === 'slow'
      ? '模型响应比平时慢，仍在等待。'
      : flow.stallLevel === 'terminal'
        ? '模型请求已经超时，没有自动重新提交。'
        : ''
  return (
    <section
      className={`agent-execution-flow state-${flow.state} stall-${flow.stallLevel}`}
      data-testid="agent-live-plan"
      aria-label="本轮创作流"
    >
      <header>
        <span className="execution-flow-heading">
          <small>创作流</small>
          <strong>{flow.headline}</strong>
          <span className={`execution-status state-${flow.state}`}>{flow.statusLabel}</span>
        </span>
        <span className="execution-flow-actions">
          {flow.canCancel && showCancel && <button type="button" className="execution-stop" aria-label="停止当前操作" onClick={onCancel}><Square size={12} />停止</button>}
          {(flow.stallLevel === 'long' || flow.stallLevel === 'terminal' || flow.state === 'failed') && (
            <button type="button" className="execution-settings" onClick={() => window.dispatchEvent(new CustomEvent('ai-canvas:open-provider-settings', { detail: { providerId: 'openai-compatible-llm' } }))}><Settings2 size={12} />检查设置</button>
          )}
          {flow.canRestoreRequest && <button type="button" className="execution-restore" title="只填回输入框，不发送请求；再次发送将创建新请求并可能产生费用。" onClick={onRestoreRequest}><RotateCcw size={12} />恢复要求</button>}
          <button type="button" className="execution-expand" aria-expanded={expanded} aria-label={expanded ? '简洁显示' : '展开详情'} onClick={onToggle}>
            {expanded ? '简洁显示' : '展开详情'}<ChevronDown size={12} />
          </button>
        </span>
      </header>
      <p className="execution-flow-summary">{flow.summary}</p>
      <div className="execution-flow-live-facts" aria-label="当前执行事实">
        <span><small>总等待</small><strong>{compactDuration(flow.elapsedMs)}</strong></span>
        <span><small>最近真实进展</small><strong>{flow.lastProgressAgeMs < 1_000 ? '刚刚' : `${compactDuration(flow.lastProgressAgeMs)}前`}</strong></span>
        {flow.remainingWallTimeMs !== null && <span><small>本轮剩余</small><strong>{compactDuration(flow.remainingWallTimeMs)}</strong></span>}
        {flow.providerSummary !== null && <span className="execution-provider-fact"><small>文字模型</small><strong>{flow.providerSummary}</strong></span>}
      </div>
      <p className="execution-time-policy">{flow.timeLimitMs == null ? '旧任务未记录可核对的整轮时限。'
        : `本轮总时限 ${formatTimeLimit(flow.timeLimitMs)}；自开始计时，包含等待决定和图片。修改配置或重启不会延长本轮。`}</p>
      <div className="execution-stall-announcement" aria-live="polite">{stallAnnouncement}</div>
      {flow.hiddenStageCount > 0 && <p className="execution-hidden-note">此前还有 {flow.hiddenStageCount} 个已记录阶段</p>}
      <ol className="agent-execution-stages">
        {flow.stages.map((stage) => <StageNode key={stage.id} stage={stage} />)}
      </ol>
      <footer>
        <span>{flow.totalStageCount} 个真实阶段</span>
        <small>{flow.stallLevel === 'terminal' ? '没有自动重新提交' : '只显示已发生的动作'}</small>
      </footer>
    </section>
  )
}
