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

describe('agent engine setting', () => {
  it('stores the owner choice and applies it from the next project open', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'ai-canvas-engine-'))
    const first = await runtime(userData)
    try {
      expect(await first.getAgentEngine()).toEqual({ selected: 'plan-once', active: 'plan-once', forcedByEnvironment: false })
      expect(await first.setAgentEngine('multi-step')).toEqual({ selected: 'multi-step', active: 'plan-once', forcedByEnvironment: false })
      await first.createProject(join(userData, 'library', 'second.aicanvas'), 'Second')
      expect(await first.getAgentEngine()).toMatchObject({ active: 'multi-step' })
    } finally {
      await first.close()
    }
    const reopened = await runtime(userData)
    try {
      expect(await reopened.getAgentEngine()).toEqual({ selected: 'multi-step', active: 'multi-step', forcedByEnvironment: false })
    } finally {
      await reopened.close()
    }
  })

  it('reports an engine forced from outside the settings', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'ai-canvas-engine-forced-'))
    const forced = await runtime(userData, 'multi-step')
    try {
      expect(await forced.getAgentEngine()).toEqual({ selected: 'multi-step', active: 'multi-step', forcedByEnvironment: true })
    } finally {
      await forced.close()
    }
  })
})
