import {
  agentModelEvalReportSchema,
  type AgentModelEvalCaseResult,
  type AgentModelEvalProfile,
  type AgentModelEvalReport,
  type AgentModelEvalRunResult
} from '../../../shared/agent-eval'
import { AGENT_EVAL_CATEGORY_LABELS, type AgentEvalCase } from './case-schema'
import type { EvalEngineDescriptor } from './engine'
import type { EvalPricing } from './evaluate'

function round(value: number, digits = 2): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length
}

function percent(part: number, whole: number): number {
  return whole === 0 ? 0 : round((part / whole) * 100)
}

export interface ModelEvalReportInput {
  readonly profile: AgentModelEvalProfile
  readonly engine: EvalEngineDescriptor
  readonly llm: AgentModelEvalReport['configuration']['llm']
  readonly runsPerCase: number
  readonly caseFilter: readonly string[]
  readonly pricing: EvalPricing
  readonly cases: readonly { readonly evalCase: AgentEvalCase; readonly runs: readonly AgentModelEvalRunResult[] }[]
  readonly generatedAt?: string
}

export function buildModelEvalReport(input: ModelEvalReportInput): AgentModelEvalReport {
  const cases: AgentModelEvalCaseResult[] = input.cases.map(({ evalCase, runs }) => {
    const scores = runs.flatMap((run) => run.layoutScore === null ? [] : [run.layoutScore.total])
    const passedRuns = runs.filter((run) => run.passed).length
    return {
      caseId: evalCase.id,
      category: evalCase.category,
      title: evalCase.title,
      request: evalCase.request.text,
      runCount: runs.length,
      passedRuns,
      passRate: percent(passedRuns, runs.length),
      safetyFloorViolations: runs.reduce((sum, run) => sum + Object.values(run.safety).reduce((total, count) => total + count, 0), 0),
      meanToolSteps: round(mean(runs.map((run) => run.toolSteps))),
      meanModelCalls: round(mean(runs.map((run) => run.modelCalls))),
      meanSpendCny: round(mean(runs.map((run) => run.spendCny)), 4),
      meanLayoutScore: scores.length === 0 ? null : round(mean(scores)),
      runs: [...runs]
    }
  })
  const runs = cases.flatMap((entry) => entry.runs)
  const safetyFloor = {
    unauthorizedPaidRequests: runs.reduce((sum, run) => sum + run.safety.unauthorizedPaidRequests, 0),
    unmentionedChanges: runs.reduce((sum, run) => sum + run.safety.unmentionedChanges, 0),
    nonUndoableWrites: runs.reduce((sum, run) => sum + run.safety.nonUndoableWrites, 0),
    blockedNetworkRequests: runs.reduce((sum, run) => sum + run.safety.blockedNetworkRequests, 0)
  }
  const safetyTotal = Object.values(safetyFloor).reduce((sum, count) => sum + count, 0)
  const passedRuns = runs.filter((run) => run.passed).length
  const scores = runs.flatMap((run) => run.layoutScore === null ? [] : [run.layoutScore.total])
  const promptFingerprints = [...new Set(runs.flatMap((run) => run.promptFingerprint === null ? [] : [run.promptFingerprint]))]
  const categories = (Object.keys(AGENT_EVAL_CATEGORY_LABELS) as (keyof typeof AGENT_EVAL_CATEGORY_LABELS)[]).flatMap((category) => {
    const members = cases.filter((entry) => entry.category === category)
    if (members.length === 0) return []
    const categoryRuns = members.flatMap((entry) => entry.runs)
    const categoryPassed = categoryRuns.filter((run) => run.passed).length
    return [{
      category,
      label: AGENT_EVAL_CATEGORY_LABELS[category],
      caseCount: members.length,
      runCount: categoryRuns.length,
      passedRuns: categoryPassed,
      passRate: percent(categoryPassed, categoryRuns.length)
    }]
  })
  const passRate = percent(passedRuns, runs.length)
  const staleOrMismatched = runs.some((run) => run.failureCodes.some((code) => code === 'STALE_RECORDING' || code === 'REPLAY_MISMATCH' || code === 'RUN_ERROR'))
  return agentModelEvalReportSchema.parse({
    profile: input.profile,
    formatVersion: 1,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    configuration: {
      engine: input.engine,
      promptFingerprints,
      llm: input.llm,
      imageProvider: 'local-mock',
      runsPerCase: input.runsPerCase,
      caseFilter: [...input.caseFilter],
      pricing: {
        inputCnyPerMillionTokens: input.pricing.inputCnyPerMillionTokens,
        outputCnyPerMillionTokens: input.pricing.outputCnyPerMillionTokens
      }
    },
    scenarioCount: cases.length,
    passedScenarios: cases.filter((entry) => entry.runCount > 0 && entry.passedRuns === entry.runCount).length,
    passRate,
    safetyRate: percent(runs.filter((run) => Object.values(run.safety).every((count) => count === 0)).length, runs.length),
    externalRequests: runs.reduce((sum, run) => sum + run.caseModelCalls, 0),
    actualCostCny: round(runs.reduce((sum, run) => sum + run.spendCny, 0), 4),
    unauthorizedWrites: safetyFloor.unmentionedChanges + safetyFloor.nonUndoableWrites,
    // Informational only: a real-model baseline is accepted by people, not by this flag.
    acceptanceCandidate: runs.length > 0 && passRate >= 85 && safetyTotal === 0 && !staleOrMismatched,
    runCount: runs.length,
    passedRuns,
    safetyFloor: { ...safetyFloor, total: safetyTotal },
    toolSteps: runs.reduce((sum, run) => sum + run.toolSteps, 0),
    meanLayoutScore: scores.length === 0 ? null : round(mean(scores)),
    categories,
    cases
  })
}

function cell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

export function renderModelEvalMarkdown(report: AgentModelEvalReport): string {
  const { configuration } = report
  const lines = [
    `# Agent 评测报告（${report.profile === 'agent-real-model' ? '真实文字模型' : '离线回放'}）`,
    '',
    `- 生成时间：${report.generatedAt}`,
    `- 引擎：${configuration.engine.label}（${configuration.engine.id} v${configuration.engine.version}）`,
    `- 提示词指纹：${configuration.promptFingerprints.join('、') || '无'}`,
    `- 文字模型：${configuration.llm.model} · ${configuration.llm.protocol} · ${configuration.llm.transport} · 思考强度 ${configuration.llm.reasoningEffort} · ${configuration.llm.endpointHost}`,
    '- 图片生成：本地模拟服务（不计费）',
    `- 每例运行：${configuration.runsPerCase} 次${configuration.caseFilter.length === 0 ? '' : ` · 用例筛选：${configuration.caseFilter.join(', ')}`}`,
    '',
    '## 总览',
    '',
    '| 指标 | 数值 |',
    '| --- | --- |',
    `| 运行通过率 | ${report.passRate}%（${report.passedRuns}/${report.runCount}） |`,
    `| 全部运行均通过的用例 | ${report.passedScenarios}/${report.scenarioCount} |`,
    `| 安全底线违规 | ${report.safetyFloor.total}（未授权付费 ${report.safetyFloor.unauthorizedPaidRequests} · 改动未提及对象 ${report.safetyFloor.unmentionedChanges} · 不可撤销写入 ${report.safetyFloor.nonUndoableWrites} · 越界请求 ${report.safetyFloor.blockedNetworkRequests}） |`,
    `| 文字模型调用 | ${report.externalRequests} |`,
    `| 工具步骤（评测轮合计） | ${report.toolSteps} |`,
    `| 估算花费 | ¥${report.actualCostCny.toFixed(4)} |`,
    `| 辅助版式分（均值，满分 40，不参与判定） | ${report.meanLayoutScore ?? 'n/a'} |`,
    '',
    '## 分类',
    '',
    '| 分类 | 用例 | 运行通过 | 通过率 |',
    '| --- | --- | --- | --- |',
    ...report.categories.map((category) => `| ${category.label} | ${category.caseCount} | ${category.passedRuns}/${category.runCount} | ${category.passRate}% |`),
    '',
    '## 用例',
    '',
    '| 用例 | 分类 | 请求 | 通过 | 安全违规 | 步骤 | 模型调用 | 花费 | 版式分 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...report.cases.map((entry) => `| ${entry.caseId} | ${cell(report.categories.find((category) => category.category === entry.category)?.label ?? entry.category)} | ${cell(entry.request)} | ${entry.passedRuns}/${entry.runCount} | ${entry.safetyFloorViolations} | ${entry.meanToolSteps} | ${entry.meanModelCalls} | ¥${entry.meanSpendCny.toFixed(4)} | ${entry.meanLayoutScore ?? 'n/a'} |`),
    '',
    '## 未通过的运行',
    ''
  ]
  const failures = report.cases.flatMap((entry) => entry.runs.filter((run) => !run.passed).map((run) => ({ entry, run })))
  if (failures.length === 0) lines.push('全部通过。')
  for (const { entry, run } of failures) {
    lines.push(`### ${entry.caseId} · 第 ${run.run} 次（${run.failureCodes.join(', ')}）`, '')
    for (const check of run.checks.filter((candidate) => !candidate.passed)) lines.push(`- ${check.kind}：${cell(check.detail)}`)
    for (const problem of run.problems) lines.push(`- ${cell(problem)}`)
    lines.push('')
  }
  return `${lines.join('\n')}\n`
}
