import { describe, expect, it } from 'vitest'
import { agentPlanSchema, agentRequestSchema, type AgentPlan } from '../../src/shared/agent'
import { SUBJECT_ISOLATION, validateChatPlan } from '../../src/main/agent/ark-agent-planner'
import { receiptItem } from '../../src/main/agent/agent-runtime'
import { resolvePlannedResult, type PlannerInput } from '../../src/main/agent/planner-adapter'
import { summarizeScene } from '../../src/renderer/src/agent/agent-client'
import { IDS, makeAllElementTypesScene } from '../fixtures/scene-fixtures'

const resultId = '90000000-0000-4000-8000-000000000001'
const jobId = '90000000-0000-4000-8000-000000000002'
function request() {
  return agentRequestSchema.parse({ text: '生成并替换当前图片', sceneSummary: summarizeScene(makeAllElementTypesScene()), selectedIds: [], selectedElements: [] })
}
function plan(tools: unknown[]): AgentPlan {
  return agentPlanSchema.parse({ summary: '修改作品', response: '操作完成', nextAction: null, tools })
}
const generation = { kind: 'generation', request: { prompt: '青绿香水瓶', providerId: 'mock', model: 'mock-balanced', count: 1, outputWidth: 256, outputHeight: 320, aspectWidth: 4, aspectHeight: 5 } }

describe('chat flow planning contracts', () => {
  it('retains real text metrics and image identity through the request schema', () => {
    const value = request()
    expect(value.sceneSummary.elements.find(e => e.id === IDS.text)).toMatchObject({ fontSize: 84, fontFamily: 'Segoe UI Variable', fontWeight: 300, align: 'center', fill: '#EAF0F5' })
    expect(value.sceneSummary.elements.find(e => e.id === IDS.image)).toMatchObject({ assetId: IDS.asset, hasEditMask: true })
  })
  it('rejects maskless edits before approval, and treats raw image references as visual', () => {
    const req = request()
    req.sceneSummary.elements = req.sceneSummary.elements.map(e => ({ ...e, hasEditMask: false }))
    expect(() => validateChatPlan(plan([{ kind: 'canvas_edit', targetElementId: IDS.image, prompt: '修改背景' }]), req)).toThrow('没有可用修改蒙版')
    const corrected = validateChatPlan(plan([{ ...generation, request: { ...generation.request, referenceMode: 'hybrid', references: [{ assetId: IDS.asset, intent: 'subject' }] } }]), req)
    expect(corrected.tools[0]).toMatchObject({ request: { referenceMode: 'visual', references: [{ assetId: IDS.asset }] } })
  })
  it('validates deferred placement order and refuses ambiguous multiple outputs', () => {
    const req = request()
    const place = { kind: 'place_generation_result', resultId: 'generated:0', targetElementId: IDS.placeholder }
    expect(validateChatPlan(plan([generation, place]), req).tools).toHaveLength(2)
    expect(() => validateChatPlan(plan([place, generation]), req)).toThrow('更早的生图工具')
    expect(() => validateChatPlan(plan([{ ...generation, request: { ...generation.request, count: 2 } }, place]), req)).toThrow('只生成1张')
    expect(() => validateChatPlan(plan([generation, place]), { ...req, selectedIds: [IDS.text] })).toThrow('不在本轮选区')
  })
  it('asks for the subject alone on a plain background when the picture goes into a placeholder that is cut out', () => {
    const req = request()
    const place = { kind: 'place_generation_result', resultId: 'generated:0', targetElementId: IDS.placeholder }
    const isolated = validateChatPlan(plan([generation, place]), req).tools[0]!
    expect(isolated.kind === 'generation' && isolated.request.prompt).toBe(`青绿香水瓶\n\n${SUBJECT_ISOLATION}`)
    // A placeholder kept with its background, a plain picture and a generation placed nowhere are left as written.
    const framed = { ...req, sceneSummary: { ...req.sceneSummary, elements: req.sceneSummary.elements.map(e => e.id === IDS.placeholder ? { ...e, cutout: false } : e) } }
    expect(validateChatPlan(plan([generation, place]), framed).tools[0]).toMatchObject({ request: { prompt: '青绿香水瓶' } })
    expect(validateChatPlan(plan([generation]), req).tools[0]).toMatchObject({ request: { prompt: '青绿香水瓶' } })
  })
  it('leaves a scene placeholder as the model wrote it, and keeps a long request within the limit', () => {
    const req = request()
    const place = { kind: 'place_generation_result', resultId: 'generated:0', targetElementId: IDS.placeholder }
    const reshaped = (changes: Record<string, unknown>) => ({ ...req, sceneSummary: { ...req.sceneSummary, elements: req.sceneSummary.elements.map(e => e.id === IDS.placeholder ? { ...e, ...changes } : e) } })
    // A landscape, and a placeholder filling the canvas, are scenes: placement does not cut them out.
    expect(validateChatPlan(plan([generation, place]), reshaped({ visualKind: 'landscape' })).tools[0]).toMatchObject({ request: { prompt: '青绿香水瓶' } })
    expect(validateChatPlan(plan([generation, place]), reshaped({ transform: { x: 0, y: 0, width: 1, height: 0.9, rotation: 0 } })).tools[0]).toMatchObject({ request: { prompt: '青绿香水瓶' } })
    // A request already at the limit is cut short to leave room for the ask.
    const long = { ...generation, request: { ...generation.request, prompt: '瓶'.repeat(8_000) } }
    const isolated = validateChatPlan(plan([long, place]), req).tools[0]!
    if (isolated.kind !== 'generation') throw new Error('Expected the generation to stay first.')
    expect(isolated.request.prompt.length).toBeLessThanOrEqual(8_000)
    expect(isolated.request.prompt.endsWith(SUBJECT_ISOLATION)).toBe(true)
  })
  it('resolves only a completed same-plan job, never an unrelated earlier result', () => {
    const activePlan = plan([generation, { kind: 'place_generation_result', resultId: 'generated:0', targetElementId: IDS.placeholder }])
    const req = request()
    req.generationResults = [{ resultId, jobId, assetId: IDS.asset, providerId: 'mock', model: 'mock-balanced', width: 256, height: 320 }]
    const input = { request: req, activePlan, nextToolIndex: 1, items: [
      { id: 'plan', type: 'plan', status: 'completed', payload: { plan: activePlan } },
      { id: 'tool', type: 'tool_result', status: 'completed', payload: { planItemId: 'plan', outcome: { ok: true, jobId, toolIndex: 0 } } }
    ] } as unknown as PlannerInput
    expect(resolvePlannedResult(activePlan.tools[1]!, input)).toMatchObject({ resultId, targetElementId: IDS.placeholder })
    expect(() => resolvePlannedResult(activePlan.tools[1]!, { ...input, items: input.items.slice(0, 1) })).toThrow('唯一可用图片')
    expect(() => resolvePlannedResult(activePlan.tools[1]!, { ...input, request: { ...req, generationResults: [{ ...req.generationResults![0]!, jobId: 'other-job' }] } })).toThrow('唯一可用图片')
  })
  it('reports atomic layout work as scene work rather than cancellation', () => {
    const tool = plan([{ kind: 'scene.update_elements', expectedSceneRevision: 0, summary: '缩小标题', updates: [{ elementId: IDS.text, changes: { fontSize: 96 } }] }]).tools[0]!
    expect(receiptItem(tool, { toolIndex: 0, ok: true, batchId: null, jobId: null, affectedElementIds: [IDS.text], message: '已修改' })).toEqual({ object: '1 个元素', action: '缩小标题', impact: '画布修改已提交，可撤销' })
  })
})
