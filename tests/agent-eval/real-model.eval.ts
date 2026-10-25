import { expect, it } from 'vitest'
import {
  MultiStepEvalEngine,
  PlanOnceEvalEngine,
  loadEvalModelConfig,
  loadEvalRunSettings,
  runAgentEval
} from '../../src/main/agent/eval'
import { AGENT_EVAL_CASES } from './cases'
import { AGENT_EVAL_SCENES } from './scenes'

// Manual, opt-in and paid: `pnpm eval:agent`. Never part of CI. Only text-model
// requests leave the process; image generation is answered by a local mock.
//
// Required: AI_CANVAS_EVAL_LLM_BASE_URL, AI_CANVAS_EVAL_LLM_MODEL,
//   AI_CANVAS_EVAL_LLM_PROTOCOL (ark-responses | openai-responses | openai-chat-completions | anthropic-messages),
//   AI_CANVAS_EVAL_LLM_API_KEY (environment only).
// Optional: AI_CANVAS_EVAL_LLM_REASONING_EFFORT, _TRANSPORT (auto|stream|buffered),
//   _TIMEOUT_MS, _MAX_OUTPUT_TOKENS, _VISION (default on), _INPUT_CNY_PER_MTOK and
//   _OUTPUT_CNY_PER_MTOK (token pricing for spend), AI_CANVAS_EVAL_RUNS (default 3),
//   AI_CANVAS_EVAL_CASES (ids or categories), AI_CANVAS_EVAL_OUTPUT_DIR (default
//   test-results/agent-eval/<time>), AI_CANVAS_EVAL_RECORD (default on),
//   AI_CANVAS_EVAL_TURN_TIMEOUT_MS, AI_CANVAS_EVAL_CONFIG (JSON file for the
//   non-secret fields; .ai-canvas/agent-eval.json is read when present),
//   AI_CANVAS_EVAL_ENGINE (plan-once, the default, or multi-step).
it('runs the agent eval set against the configured text model', async () => {
  const config = await loadEvalModelConfig(process.env)
  const settings = loadEvalRunSettings(process.env)
  const output = await runAgentEval({
    cases: AGENT_EVAL_CASES,
    engine: process.env.AI_CANVAS_EVAL_ENGINE === 'multi-step' ? new MultiStepEvalEngine() : new PlanOnceEvalEngine(),
    scenes: AGENT_EVAL_SCENES,
    mode: { kind: 'live', config, record: settings.record },
    runs: settings.runs,
    caseFilter: settings.caseFilter,
    outputDirectory: settings.outputDirectory,
    turnTimeoutMs: settings.turnTimeoutMs,
    onProgress: (message) => console.log(`[agent-eval] ${message}`)
  })
  const { report } = output
  console.log([
    `[agent-eval] ${report.passedRuns}/${report.runCount} runs passed (${report.passRate}%), ${report.passedScenarios}/${report.scenarioCount} cases passed every run`,
    `[agent-eval] safety floor violations: ${report.safetyFloor.total}; model calls: ${report.externalRequests}; estimated spend: CNY ${report.actualCostCny.toFixed(4)}`,
    `[agent-eval] report: ${output.files?.markdown ?? 'not written'}`
  ].join('\n'))
  // The run itself succeeding is the test; pass rates are read from the report.
  expect(report.runCount).toBeGreaterThan(0)
})
