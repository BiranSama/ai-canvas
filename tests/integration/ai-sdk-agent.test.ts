import { describe, expect, it, vi } from 'vitest'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { createAiSdkToolLoopAgent } from '../../src/main/agent'

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 10, text: 10, reasoning: undefined }
}

describe('AI SDK Core agent adapter', () => {
  it('executes the same validated tool boundary through ToolLoopAgent', async () => {
    const elementId = '00000000-0000-4000-8000-000000000111'
    const execute = vi.fn().mockImplementation(async (input: { readonly kind: string }) => input.kind === 'read_scene'
      ? { elements: [{ id: elementId, name: '主标题', type: 'text' }] }
      : { committed: true })
    const model = new MockLanguageModelV4({
      doGenerate: [
        {
          content: [{
            type: 'tool-call',
            toolCallId: 'call-read',
            toolName: 'readScene',
            input: JSON.stringify({ kind: 'read_scene', elementIds: [elementId] })
          }],
          finishReason: { unified: 'tool-calls', raw: undefined },
          usage,
          warnings: []
        },
        {
          content: [{
            type: 'tool-call',
            toolCallId: 'call-1',
            toolName: 'applySceneBatch',
            input: JSON.stringify({
              kind: 'scene_batch',
              summary: '调整画布',
              commands: [{
                kind: 'scene.set-canvas',
                canvas: { aspectWidth: 1, aspectHeight: 1, outputWidth: 1024, outputHeight: 1024, backgroundColor: '#FFFFFF', transparent: false, globalStyle: '' }
              }]
            })
          }],
          finishReason: { unified: 'tool-calls', raw: undefined },
          usage,
          warnings: []
        },
        {
          content: [{ type: 'text', text: '画布已调整。' }],
          finishReason: { unified: 'stop', raw: undefined },
          usage,
          warnings: []
        }
      ]
    })
    const agent = createAiSdkToolLoopAgent(model, execute, 4)
    const result = await agent.generate({ prompt: '改成方形画布' })

    expect(result.text).toBe('画布已调整。')
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ kind: 'read_scene', elementIds: [elementId] }), expect.any(AbortSignal))
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ kind: 'scene_batch', summary: '调整画布' }), expect.any(AbortSignal))
    expect(model.doGenerateCalls).toHaveLength(3)
  })

  it('exposes a deterministic streaming path without a network provider', async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: 'text-start', id: 'text-1' },
            { type: 'text-delta', id: 'text-1', delta: '布局' },
            { type: 'text-delta', id: 'text-1', delta: '已创建' },
            { type: 'text-end', id: 'text-1' },
            { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage }
          ]
        })
      })
    })
    const agent = createAiSdkToolLoopAgent(model, async () => ({ ok: true }))
    const result = await agent.stream({ prompt: '创建布局' })
    let text = ''
    for await (const delta of result.textStream) text += delta
    expect(text).toBe('布局已创建')
  })
})
