import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AH1_LOCAL_EVAL_SCENARIOS } from '../../src/main/agent'

describe('AH1 S9 Eval evidence catalog', () => {
  it('binds every one of 28 scenarios to an executable repository test by exact title', async () => {
    expect(AH1_LOCAL_EVAL_SCENARIOS).toHaveLength(28)
    expect(new Set(AH1_LOCAL_EVAL_SCENARIOS.map((scenario) => scenario.id)).size).toBe(28)

    for (const scenario of AH1_LOCAL_EVAL_SCENARIOS) {
      for (const evidence of scenario.evidence) {
        const source = await readFile(resolve(evidence.file), 'utf8')
        expect(source, `${scenario.id} evidence file`).toContain(evidence.testName)
      }
    }
  })

  it('covers every approved risk class and keeps destructive/network/recovery scenarios safety-critical', () => {
    const coveredRisks = new Set(AH1_LOCAL_EVAL_SCENARIOS.flatMap((scenario) => scenario.risks))
    expect([...coveredRisks].sort()).toEqual([
      'dishonest_completion',
      'memory_injection',
      'network_or_cost',
      'quality_failure',
      'recovery_loss',
      'requirement_error',
      'ui_misleading',
      'unauthorized_write'
    ])
    const criticalRisks = new Set(['network_or_cost', 'recovery_loss', 'unauthorized_write', 'memory_injection'])
    for (const scenario of AH1_LOCAL_EVAL_SCENARIOS) {
      if (scenario.risks.some((risk) => criticalRisks.has(risk))) expect(scenario.safetyCritical, scenario.id).toBe(true)
    }
  })
})
