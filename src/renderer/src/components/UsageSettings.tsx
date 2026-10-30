import { useEffect, useState } from 'react'
import { cacheHitPercent, tokenCount } from '../../../shared/model-usage'
import { formatTimeLimit } from '../../../shared/execution-timing'
import { turnUsageRows, usageTotals, type TurnUsageRow } from '../agent/turn-usage'

function cost(value: number | null): string {
  if (value === null) return '未定价'
  return value > 0 && value < 0.01 ? '<¥0.01' : `¥${value.toFixed(2)}`
}

/** The text-model calls of the open project's latest turns, with how much of their input came from the provider's cache. */
export function UsageSettings(): React.JSX.Element {
  const [rows, setRows] = useState<readonly TurnUsageRow[] | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  useEffect(() => {
    let mounted = true
    void window.desktop.getAgentHarnessSnapshot()
      .then((snapshot) => { if (mounted) setRows(turnUsageRows(snapshot, Date.now())) })
      .catch((error: unknown) => { if (mounted) setProblem(error instanceof Error ? error.message : '没有读到用量。') })
    return () => { mounted = false }
  }, [])
  const totals = rows === null ? null : usageTotals(rows)

  return (
    <section className="settings-section-summary usage-settings" aria-label="用量">
      <span className="settings-kicker">用量</span>
      <h2>文字模型用量</h2>
      <p>当前项目最近 20 轮对话里文字模型的调用。估算按「供应商」里填的单价计算，没填单价的只显示 token。缓存命中率越高，同样的对话越便宜、越快。</p>
      {problem !== null && <p role="alert">{problem}</p>}
      {rows === null && problem === null && <p>正在读取…</p>}
      {totals !== null && <div className="usage-totals" data-testid="usage-totals">
        <span><small>调用</small><strong>{totals.calls} 次</strong></span>
        <span><small>输入</small><strong>{tokenCount(totals.inputTokens)}</strong></span>
        <span><small>缓存命中</small><strong>{cacheHitPercent(totals)}%</strong></span>
        <span><small>输出</small><strong>{tokenCount(totals.outputTokens)}</strong></span>
        <span><small>估算费用</small><strong>{cost(totals.estimatedCostCny)}{totals.partlyUnpriced ? ' 起' : ''}</strong></span>
      </div>}
      {rows !== null && rows.length === 0 && <p>这个项目还没有对话。</p>}
      {rows !== null && rows.length > 0 && <table className="usage-table">
        <thead><tr><th>开始</th><th>要求</th><th>调用</th><th>输入</th><th>命中</th><th>输出</th><th>估算</th><th>用时</th></tr></thead>
        <tbody>{rows.map((row) => <tr key={row.turnId}>
          <td>{new Date(row.startedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
          <td title={row.request}>{row.request === '' ? '—' : row.request}</td>
          {row.usage === null
            ? <td colSpan={5} className="usage-local">没有调用文字模型</td>
            : <>
              <td>{row.usage.calls}</td>
              <td>{tokenCount(row.usage.inputTokens)}</td>
              <td>{cacheHitPercent(row.usage)}%</td>
              <td>{tokenCount(row.usage.outputTokens)}</td>
              <td>{cost(row.usage.estimatedCostCny)}</td>
            </>}
          <td>{formatTimeLimit(row.durationMs)}</td>
        </tr>)}</tbody>
      </table>}
    </section>
  )
}
