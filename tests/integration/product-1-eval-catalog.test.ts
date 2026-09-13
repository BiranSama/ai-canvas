import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  PRODUCT_1_E2E_FILES,
  PRODUCT_1_EVAL_SCENARIOS,
  PRODUCT_1_VITEST_FILES
} from '../helpers/product-1-eval-catalog'

describe('Product 1.0 unified offline Eval catalog', () => {
  it('keeps all twelve numbered tasks present exactly once and in order', () => {
    expect(PRODUCT_1_EVAL_SCENARIOS.map((scenario) => scenario.id)).toEqual(
      Array.from({ length: 12 }, (_, index) => `EVAL-${String(index + 1).padStart(2, '0')}`)
    )
    expect(new Set(PRODUCT_1_EVAL_SCENARIOS.map((scenario) => scenario.id)).size).toBe(12)
  })

  it('binds every task to exact executable evidence included by the dedicated gate', async () => {
    const includedFiles = new Set<string>([...PRODUCT_1_VITEST_FILES, ...PRODUCT_1_E2E_FILES])

    for (const scenario of PRODUCT_1_EVAL_SCENARIOS) {
      expect(scenario.evidence.length, `${scenario.id} evidence count`).toBeGreaterThan(0)
      expect(scenario.manualBoundary, `${scenario.id} manual boundary`).not.toHaveLength(0)

      for (const evidence of scenario.evidence) {
        expect(includedFiles.has(evidence.file), `${scenario.id} gate includes ${evidence.file}`).toBe(true)
        const source = await readFile(resolve(evidence.file), 'utf8')
        expect(source, `${scenario.id} exact evidence title`).toContain(evidence.testName)
      }
    }
  })

  it('uses only offline test sources and never packaged or real-provider suites', () => {
    const files = [...PRODUCT_1_VITEST_FILES, ...PRODUCT_1_E2E_FILES]
    expect(files.every((file) => file.startsWith('tests/'))).toBe(true)
    expect(files.every((file) => !/packaged|real-provider|live-provider/i.test(file))).toBe(true)
    expect(PRODUCT_1_EVAL_SCENARIOS.every((scenario) => scenario.manualBoundary.length > 0)).toBe(true)
  })
})
