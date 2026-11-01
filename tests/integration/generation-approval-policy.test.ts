import { expect, it } from 'vitest'
import { ProductGenerationPolicy } from '../../src/main/generation/generation-runtime'
import { agentPlanSchema, type AgentRequest } from '../../src/shared/agent'
import { DEFAULT_PROVIDER_EXECUTION_POLICY, type ProviderExecutionPolicy } from '../../src/shared/provider-settings'
import { createScene } from '../../src/domain'
import { fixtureAgentRequest } from '../helpers/semantic-fixtures'

const scene = createScene({ id: '61000000-0000-4000-8000-000000000001', projectId: '61000000-0000-4000-8000-000000000002', now: '2026-11-01T00:00:00.000Z' })
const realGeneration = agentPlanSchema.parse({ summary: '生成', response: '生成一张。', nextAction: null, tools: [
  { kind: 'generation', request: { prompt: '咖啡杯', providerId: 'image-provider', model: 'real-model', count: 1, outputWidth: 512, outputHeight: 640, aspectWidth: 4, aspectHeight: 5 } }
] })

function asks(approval: Pick<ProviderExecutionPolicy, 'approvalMode' | 'autoGenerate'>, text: string, autoGenerate: boolean): boolean {
  const policy = new ProductGenerationPolicy(() => ({ ...DEFAULT_PROVIDER_EXECUTION_POLICY, ...approval }))
  const request: AgentRequest = { ...fixtureAgentRequest(scene, text), autoGenerate }
  return policy.requiresConfirmation(request, realGeneration)
}

it('asks before every real generation whenever 「生图前先问我」 shows on, an explicit 「生成」 included', () => {
  // Off is the one pair the switch reads as off.
  expect(asks({ approvalMode: 'session', autoGenerate: true }, '现在生成一张图片', true)).toBe(false)
  expect(asks({ approvalMode: 'session', autoGenerate: true }, '先不要生成图片，排一下版', true)).toBe(true)
  // Every other pair shows on, so it asks, including the older session-without-auto pair.
  expect(asks({ approvalMode: 'session', autoGenerate: false }, '现在生成一张图片', false)).toBe(true)
  expect(asks({ approvalMode: 'confirm_each', autoGenerate: true }, '现在生成一张图片', true)).toBe(true)
  expect(asks({ approvalMode: 'confirm_each', autoGenerate: false }, '现在生成一张图片', false)).toBe(true)
})
