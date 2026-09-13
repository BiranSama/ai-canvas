import type { AgentMode } from '../../shared/agent-harness'
import {
  agentPermissionProfileSchema,
  agentToolApprovalRecordSchema,
  type AgentPermissionProfile,
  type AgentToolApprovalRecord,
  type AgentToolDefinitionSnapshot
} from '../../shared/agent-tools'

const PRODUCT_TOOL_ALLOWLIST = [
  'project.get_context', 'scene.get_summary', 'scene.get_elements', 'scene.render_preview',
  'assets.get_metadata', 'generation.get_jobs', 'generation.get_results', 'memory.search',
  'capability.load', 'scene.apply_batch', 'scene.set_canvas', 'scene.create_elements',
  'scene.update_elements', 'scene.reorder_elements', 'scene.group_elements', 'scene.remove_elements',
  'result.place_on_canvas', 'history.undo_batch', 'memory.propose_candidate',
  'memory.commit_confirmed', 'directive.update_confirmed', 'generation.prepare_job',
  'generation.create_job', 'generation.cancel_job', 'generation.subscribe_job',
  'generation.place_result'
] as const

export function localMockPermissionProfile(): AgentPermissionProfile {
  return agentPermissionProfileSchema.parse({
    id: 'ah1-local-mock-v1',
    version: 1,
    label: 'Offline compatibility',
    permissions: [
      'project.read', 'scene.read', 'scene.write', 'asset.read', 'generation.read',
      'generation.cancel', 'memory.read'
    ],
    allowedTools: [
      'project.get_context', 'scene.get_summary', 'scene.get_elements', 'scene.render_preview',
      'assets.get_metadata', 'generation.get_jobs', 'generation.get_results', 'memory.search',
      'capability.load', 'scene.apply_batch', 'generation.cancel_job'
    ],
    allowExternal: false,
    allowDangerous: false,
    maxCostCny: 0
  })
}

export function ownerFullPermissionProfile(): AgentPermissionProfile {
  return agentPermissionProfileSchema.parse({
    id: 'owner-full-v1',
    version: 1,
    label: 'Owner Full',
    permissions: [
      'project.read', 'scene.read', 'scene.write', 'asset.read', 'generation.read',
      'generation.create', 'generation.cancel', 'memory.read', 'memory.write',
      'directive.write', 'external.image'
    ],
    allowedTools: PRODUCT_TOOL_ALLOWLIST,
    allowExternal: true,
    // Product V1 deliberately excludes arbitrary OS, shell and unscoped file tools.
    allowDangerous: false,
    maxCostCny: 20
  })
}
export interface AgentToolPolicyInput {
  readonly definition: AgentToolDefinitionSnapshot
  readonly mode: AgentMode
  readonly profile: AgentPermissionProfile
  readonly broadSceneMutation: boolean
  readonly explicitTurnAuthorization: boolean
}

function record(input: AgentToolApprovalRecord): AgentToolApprovalRecord {
  return agentToolApprovalRecordSchema.parse(input)
}

export class AgentToolPolicy {
  evaluate(input: AgentToolPolicyInput): AgentToolApprovalRecord {
    const permissions = new Set(input.profile.permissions)
    if (!input.profile.allowedTools.includes(input.definition.name)) {
      return record({
        effect: 'deny', source: 'hard_policy', code: 'TOOL_NOT_ALLOWLISTED',
        explanation: `${input.definition.name} is not allowed by the active local profile.`
      })
    }
    if (input.definition.requiredPermissions.some((permission) => !permissions.has(permission))) {
      return record({
        effect: 'deny', source: 'hard_policy', code: 'TOOL_PERMISSION_DENIED',
        explanation: 'The active profile does not grant every permission required by this tool.'
      })
    }
    if ((input.definition.risk === 'dangerous' && !input.profile.allowDangerous)
      || (input.definition.risk === 'external' && !input.profile.allowExternal)) {
      return record({
        effect: 'deny', source: 'hard_policy', code: 'TOOL_RISK_DENIED',
        explanation: 'The active permission profile does not authorize this tool risk.'
      })
    }
    if (input.definition.risk === 'dangerous') {
      return record({
        effect: 'ask', source: 'mode_policy', code: 'DANGEROUS_CONFIRMATION_REQUIRED',
        explanation: 'Dangerous actions always require a separate, explicit confirmation.'
      })
    }
    if (input.mode === 'review' && input.definition.risk !== 'read') {
      return record({
        effect: 'ask', source: 'mode_policy', code: 'REVIEW_CONFIRMATION_REQUIRED',
        explanation: 'Review mode requires confirmation after preview and before a write.'
      })
    }
    if (input.mode === 'collaboration' && input.broadSceneMutation) {
      if (input.explicitTurnAuthorization) {
        return record({
          effect: 'allow', source: 'explicit_turn_request', code: 'EXPLICIT_TURN_AUTHORIZATION',
          explanation: 'The user explicitly started this scoped turn; the reversible batch remains visible and undoable.'
        })
      }
      return record({
        effect: 'ask', source: 'mode_policy', code: 'BROAD_SCENE_CONFIRMATION_REQUIRED',
        explanation: 'A broad reorder, removal, grouping, or canvas change requires a user decision in collaboration mode.'
      })
    }
    return record({
      effect: 'allow', source: 'mode_policy', code: 'MODE_POLICY_ALLOW',
      explanation: 'The tool is allowed by the active mode, scope, and local permission profile.'
    })
  }
}
