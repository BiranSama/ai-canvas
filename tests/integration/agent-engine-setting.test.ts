import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { InMemorySecretVault } from '../../src/main/agent/eval'
import { GenerationRuntime } from '../../src/main/generation/generation-runtime'

async function runtime(userData: string, agentEngine?: 'plan-once' | 'multi-step') {
  return GenerationRuntime.create(userData, {
    projectLibraryDirectory: join(userData, 'library'),
    secretVault: new InMemorySecretVault(),
    ...(agentEngine === undefined ? {} : { agentEngine })
  })
}

describe('agent engine', () => {
  it('plans locally until a text model is set up, then works step by step from the next project open', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'ai-canvas-engine-'))
    const value = await runtime(userData)
    try {
      expect(value.getAgentEngine()).toEqual({ active: 'plan-once', forcedByEnvironment: false })
      await value.setProviderSecret({ providerId: 'openai-compatible-llm', apiKey: 'sk-engine-fixture-0123456789' })
      // The open project keeps the engine it started with.
      expect(value.getAgentEngine()).toMatchObject({ active: 'plan-once' })
      await value.createProject(join(userData, 'library', 'second.aicanvas'), 'Second')
      expect(value.getAgentEngine()).toEqual({ active: 'multi-step', forcedByEnvironment: false })
    } finally {
      await value.close()
    }
  })

  it('reports an engine forced from outside the settings', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'ai-canvas-engine-forced-'))
    const forced = await runtime(userData, 'multi-step')
    try {
      expect(forced.getAgentEngine()).toEqual({ active: 'multi-step', forcedByEnvironment: true })
    } finally {
      await forced.close()
    }
  })
})
