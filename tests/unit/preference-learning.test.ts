import { describe, expect, it, vi } from 'vitest'
import { createScene, type Scene, type SceneElement } from '../../src/domain'
import {
  describeManualEdits,
  isAutoProjectName,
  looksLikeFeedback,
  parseProjectName,
  parseSummary,
  PreferenceLearner,
  summaryPrompt
} from '../../src/main/user/preference-learning'
import type { PreferenceSignal } from '../../src/shared/user-memory'

const NOW = '2026-11-14T00:00:00.000Z'

function text(id: string, changes: Partial<Extract<SceneElement, { type: 'text' }>> = {}): SceneElement {
  return {
    id, version: 1, type: 'text', name: '标题', description: '', transform: { x: 0.1, y: 0.1, width: 0.5, height: 0.1, rotation: 0 },
    zIndex: 0, opacity: 1, blendMode: 'normal', visible: true, locked: false, groupId: null, semanticRole: 'title', referencePolicy: 'include',
    content: '晨雾', fontFamily: 'Noto Sans SC', fontSize: 48, fontWeight: 600, fill: '#1F2328', align: 'center', letterSpacing: 0, lineHeight: 1.2,
    ...changes
  } as SceneElement
}

function scene(elements: readonly SceneElement[]): Scene {
  return { ...createScene({ id: '00000000-0000-4000-8000-000000000001', projectId: '00000000-0000-4000-8000-000000000002', now: NOW }), elements: [...elements] }
}

describe('preference learning helpers', () => {
  it('knows the names a project has before anyone names it', () => {
    expect(isAutoProjectName('Untitled')).toBe(true)
    expect(isAutoProjectName('未命名创作 3')).toBe(true)
    expect(isAutoProjectName('晨雾新品海报')).toBe(false)
  })

  it('reads remarks about the work as feedback, and plain requests as not', () => {
    expect(looksLikeFeedback('太花了')).toBe(true)
    expect(looksLikeFeedback('我喜欢简洁一点的')).toBe(true)
    expect(looksLikeFeedback('把标题移到左上角')).toBe(false)
  })

  it('describes what the person changed by hand on the Agent\'s layers, and only those', () => {
    const before = scene([text('a'), text('b', { content: '自己写的' })])
    const after = scene([text('a', { fontFamily: 'Noto Serif SC', fill: '#AA3300', fontSize: 40 }), text('b', { content: '自己写的', fontFamily: 'Songti' })])
    expect(describeManualEdits(before, after, new Set(['a']))).toEqual([
      '把 Agent 写的文字「晨雾」的字体从 Noto Sans SC 换成 Noto Serif SC',
      '把 Agent 写的文字「晨雾」的颜色从 #1F2328 换成 #AA3300',
      '把 Agent 写的文字「晨雾」的字号从 48 调到 40'
    ])
    expect(describeManualEdits(before, scene([text('b')]), new Set(['a']))).toEqual(['删掉了 Agent 加的「晨雾」'])
    // Moving a layer says nothing about taste.
    expect(describeManualEdits(before, scene([text('a', { transform: { x: 0.3, y: 0.3, width: 0.5, height: 0.1, rotation: 0 } }), text('b')]), new Set(['a']))).toEqual([])
  })

  it('reads a summary reply leniently and caps it', () => {
    expect(parseSummary('好的：{"preferences":["标题用衬线体","留白多一些","偏冷色调","第四条"]}')).toEqual(['标题用衬线体', '留白多一些', '偏冷色调'])
    expect(parseSummary('没有足够的证据')).toEqual([])
    expect(parseSummary('{"preferences":"不对"}')).toEqual([])
  })

  it('takes a short clean project name, or none', () => {
    expect(parseProjectName('「晨雾新品海报」')).toBe('晨雾新品海报')
    expect(parseProjectName('名字：秋季咖啡菜单\n')).toBe('秋季咖啡菜单')
    expect(parseProjectName('海')).toBeNull()
    expect(parseProjectName('这是一个非常非常长而且完全不像文件名的名字')).toBeNull()
    expect(parseProjectName('Untitled')).toBeNull()
  })

  it('sends the signals and what is already kept, in words only', () => {
    const signals: PreferenceSignal[] = [{ kind: 'said', text: '太花了', at: NOW }, { kind: 'edited', text: '把标题字体换成宋体', at: NOW }]
    const prompt = summaryPrompt(signals, ['留白多一些'])
    expect(prompt).toContain('- 说过：太花了')
    expect(prompt).toContain('- 手动修改：把标题字体换成宋体')
    expect(prompt).toContain('已经记下或提过的：\n- 留白多一些')
  })
})

describe('preference learner', () => {
  function learner(options: { readonly due?: boolean; readonly reply?: string | null; readonly enabled?: boolean } = {}) {
    const store = {
      recordSignal: vi.fn(async () => options.due ?? false),
      summaryInput: vi.fn(async () => ({ signals: [{ kind: 'said' as const, text: '太花了', at: NOW }], kept: [], enabled: options.enabled ?? true })),
      summarized: vi.fn(async (candidates: readonly { readonly content: string }[]) => candidates.map((candidate) => ({ id: 'c', kind: 'preference' as const, content: candidate.content, source: 'learned' as const, status: 'pending' as const, createdAt: NOW })))
    }
    const model = { complete: vi.fn(async () => options.reply === null ? null : { text: options.reply ?? '{"preferences":["喜欢简洁"]}', served: 'fast' as const, inputTokens: 1, outputTokens: 1, estimatedCostCny: null }) }
    return { store, model, learner: new PreferenceLearner({ store, model, delayMs: 5 }) }
  }

  it('sums up once a summary falls due, and files what the model offers', async () => {
    const { store, model, learner: subject } = learner({ due: true })
    await subject.record('said', '太花了')
    await vi.waitFor(() => expect(store.summarized).toHaveBeenCalledWith([{ kind: 'preference', content: '喜欢简洁' }]))
    expect(model.complete).toHaveBeenCalledTimes(1)
    subject.close()
  })

  it('leaves the signals waiting when no model can answer, and asks nothing while learning is off', async () => {
    const quiet = learner({ reply: null })
    await expect(quiet.learner.summarize()).resolves.toEqual([])
    expect(quiet.store.summarized).not.toHaveBeenCalled()
    const off = learner({ enabled: false })
    await expect(off.learner.summarize()).resolves.toEqual([])
    expect(off.model.complete).not.toHaveBeenCalled()
  })

  it('runs one summary at a time', async () => {
    const { model, learner: subject } = learner()
    await Promise.all([subject.summarize(), subject.summarize()])
    expect(model.complete).toHaveBeenCalledTimes(1)
  })
})
