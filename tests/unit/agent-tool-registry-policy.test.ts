import { describe, expect, it } from 'vitest'
import {
  AgentToolPolicy,
  AgentToolRegistry,
  localMockPermissionProfile,
  ownerFullPermissionProfile
} from '../../src/main/agent'

describe('AH1 S2 static tool registry and policy', () => {
  it('publishes a stable versioned allowlist without shell, file, URL, provider-config or publish tools', () => {
    const registry = new AgentToolRegistry()
    const snapshot = registry.list()
    expect(snapshot.find((tool) => tool.name === 'scene.apply_batch')).toMatchObject({
      version: 1,
      risk: 'local_reversible',
      requiredPermissions: ['scene.write'],
      supportsPreview: true,
      idempotency: 'required',
      implementation: 'available'
    })
    expect(snapshot.find((tool) => tool.name === 'generation.create_job')).toMatchObject({
      risk: 'external',
      implementation: 'available'
    })
    expect(snapshot.map((tool) => tool.name)).not.toEqual(expect.arrayContaining([
      'shell.exec', 'file.read', 'file.write', 'url.fetch', 'provider.configure', 'project.publish'
    ]))
  })

  it('uses the same policy engine for review, collaboration and auto modes', () => {
    const definition = new AgentToolRegistry().require('scene.apply_batch')
    const profile = localMockPermissionProfile()
    const policy = new AgentToolPolicy()

    expect(policy.evaluate({
      definition, profile, mode: 'review', broadSceneMutation: false, explicitTurnAuthorization: true
    })).toMatchObject({ effect: 'ask', code: 'REVIEW_CONFIRMATION_REQUIRED' })
    expect(policy.evaluate({
      definition, profile, mode: 'collaboration', broadSceneMutation: false, explicitTurnAuthorization: false
    })).toMatchObject({ effect: 'allow', code: 'MODE_POLICY_ALLOW' })
    expect(policy.evaluate({
      definition, profile, mode: 'collaboration', broadSceneMutation: true, explicitTurnAuthorization: false
    })).toMatchObject({ effect: 'ask', code: 'BROAD_SCENE_CONFIRMATION_REQUIRED' })
    expect(policy.evaluate({
      definition, profile, mode: 'collaboration', broadSceneMutation: true, explicitTurnAuthorization: true
    })).toMatchObject({ effect: 'allow', source: 'explicit_turn_request' })
    expect(policy.evaluate({
      definition, profile, mode: 'auto', broadSceneMutation: true, explicitTurnAuthorization: false
    })).toMatchObject({ effect: 'allow', code: 'MODE_POLICY_ALLOW' })
  })

  it('hard-denies external tools under the zero-cost local/Mock profile', () => {
    const definition = new AgentToolRegistry().require('generation.create_job')
    const decision = new AgentToolPolicy().evaluate({
      definition,
      profile: { ...localMockPermissionProfile(), allowedTools: [...localMockPermissionProfile().allowedTools, definition.name] },
      mode: 'auto',
      broadSceneMutation: false,
      explicitTurnAuthorization: true
    })
    expect(decision).toMatchObject({ effect: 'deny', source: 'hard_policy' })
  })

  it('grants Product V1 project, memory and external image capabilities to Owner Full', () => {
    const registry = new AgentToolRegistry()
    const profile = ownerFullPermissionProfile()
    const decision = new AgentToolPolicy().evaluate({
      definition: registry.require('generation.create_job'),
      profile,
      mode: 'auto',
      broadSceneMutation: false,
      explicitTurnAuthorization: true
    })

    expect(profile).toMatchObject({
      id: 'owner-full-v1',
      allowExternal: true,
      allowDangerous: false
    })
    expect(profile.permissions).toEqual(expect.arrayContaining([
      'scene.write', 'generation.create', 'memory.write', 'directive.write', 'external.image'
    ]))
    expect(decision).toMatchObject({ effect: 'allow', code: 'MODE_POLICY_ALLOW' })
  })

  it('keeps dangerous capabilities denied unless both the permission and profile flag exist', () => {
    const registry = new AgentToolRegistry()
    const external = registry.require('generation.create_job')
    const dangerous = {
      ...external,
      name: 'product.dangerous-test',
      risk: 'dangerous' as const,
      requiredPermissions: ['dangerous' as const]
    }
    const owner = ownerFullPermissionProfile()
    const denied = new AgentToolPolicy().evaluate({
      definition: dangerous,
      profile: { ...owner, allowedTools: [...owner.allowedTools, dangerous.name] },
      mode: 'auto',
      broadSceneMutation: false,
      explicitTurnAuthorization: true
    })
    const confirmed = new AgentToolPolicy().evaluate({
      definition: dangerous,
      profile: {
        ...owner,
        permissions: [...owner.permissions, 'dangerous'],
        allowedTools: [...owner.allowedTools, dangerous.name],
        allowDangerous: true
      },
      mode: 'auto',
      broadSceneMutation: false,
      explicitTurnAuthorization: true
    })

    expect(denied).toMatchObject({ effect: 'deny', code: 'TOOL_PERMISSION_DENIED' })
    expect(confirmed).toMatchObject({ effect: 'ask', code: 'DANGEROUS_CONFIRMATION_REQUIRED' })
  })
})
