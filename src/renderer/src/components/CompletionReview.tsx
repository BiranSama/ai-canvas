import type { CompletionFacts } from '../../../shared/design-capability'

export function CompletionReview({ facts, sceneRevision, busy, onAccept }: {
  readonly facts: CompletionFacts
  readonly sceneRevision: number
  readonly busy: boolean
  readonly onAccept: () => void
}): React.JSX.Element {
  const current = facts.scope?.sceneRevision === sceneRevision && facts.scopeUnavailableReason == null
  const accepted = facts.userAcceptance !== null
  return <section className="completion-review" aria-label="完成与验收事实">
    <div className="completion-fact-status">
      <span>{facts.operationStatus === 'completed' ? '操作已执行' : facts.operationStatus === 'missing' ? '请求尚未执行' : '本轮为说明'}</span>
      <span>{facts.structureStatus === 'passed' ? '结构检查通过' : facts.structureStatus === 'failed' ? '结构仍需处理' : '未进行结构检查'}</span>
      {facts.visualStatus === 'needs_user_review' && <span>{accepted ? current ? '你已接受这版作品' : '此前版本已接受' : '视觉效果待复核'}</span>}
    </div>
    {facts.unverifiedMust.length > 0 && <details className="completion-review-requirements">
      <summary>{facts.unverifiedMust.length} 项必要要求待人工核对</summary>
      <ul>{facts.unverifiedMust.map((item) => <li key={item.id}><strong>{item.label}</strong><span>{item.reason}</span></li>)}</ul>
    </details>}
    {facts.visualStatus === 'needs_user_review' && <footer>
      <p>{facts.scope === null ? '历史分数不代表视觉验收；请重新检查当前版本。'
        : facts.scopeUnavailableReason != null ? facts.scopeUnavailableReason
        : !current ? `这份记录对应画布 r${facts.scope.sceneRevision}。作品已修改，接受记录不会延伸到当前版本。`
        : accepted ? '接受只对应这版画布和本轮结果；继续修改后需要重新核对。'
        : '请检查当前画布和本轮结果。接受将保留你的决定，未自动验证的要求仍按人工判断记录。'}</p>
      {current && !accepted && facts.operationStatus === 'completed' && <button type="button" disabled={busy} onClick={onAccept}>{busy ? '正在记录…' : '接受这版作品'}</button>}
    </footer>}
  </section>
}
