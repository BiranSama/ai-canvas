import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('AH1 S4 renderer authority boundary', () => {
  it('contains no renderer CommandBus, Agent executor or full-snapshot polling bridge', async () => {
    const [workspaceStore, agentClient, bridge, creationBar, conversationView, generateView, preload] = await Promise.all([
      readFile('src/renderer/src/store/workspace-store.ts', 'utf8'),
      readFile('src/renderer/src/agent/agent-client.ts', 'utf8'),
      readFile('src/renderer/src/agent/AgentRuntimeBridge.tsx', 'utf8'),
      readFile('src/renderer/src/components/CreationBar.tsx', 'utf8'),
      readFile('src/renderer/src/components/ConversationView.tsx', 'utf8'),
      readFile('src/renderer/src/components/GenerateView.tsx', 'utf8'),
      readFile('src/preload/index.ts', 'utf8')
    ])

    expect(workspaceStore).not.toMatch(/\bCommandBus\b/)
    expect(workspaceStore).not.toMatch(/executeAuthorizedAgent|rollbackAuthorizedAgent/)
    expect(agentClient).not.toMatch(/executeAgentPlan|executeAgentSceneTool|enqueueGenerationProfile|editFromCanvas/)
    expect(bridge).not.toMatch(/setInterval|getConversationSnapshot|claimAgentPlan|executeAgentPlan/)
    expect(bridge).toMatch(/onAgentEvent|replayAgentEvents/)
    expect(creationBar).not.toMatch(/setInterval/)
    expect(conversationView).not.toMatch(/setInterval/)
    expect(generateView).toMatch(/placeGenerationResult/)
    expect(generateView).not.toMatch(/createElementForTool|addElement\s*\(/)
    expect(preload).not.toMatch(/commitWorkspaceScene|rendererSessionId/)
    expect(preload).not.toMatch(/claimAgentPlan|reportAgentToolStarted|executeAgentSceneTool|completeAgentRun/)
  })
})
