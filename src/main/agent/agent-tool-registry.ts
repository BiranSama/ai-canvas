import {
  agentToolDefinitionSnapshotSchema,
  type AgentPermission,
  type AgentToolDefinitionSnapshot,
  type AgentToolRisk
} from '../../shared/agent-tools'

interface DefinitionInput {
  readonly name: string
  readonly risk: AgentToolRisk
  readonly permissions: readonly AgentPermission[]
  readonly preview?: boolean
  readonly cancel?: boolean
  readonly idempotency?: 'required' | 'not_applicable'
  readonly implementation?: 'available' | 'planned'
}

function define(input: DefinitionInput): AgentToolDefinitionSnapshot {
  return agentToolDefinitionSnapshotSchema.parse({
    name: input.name,
    version: 1,
    risk: input.risk,
    requiredPermissions: input.permissions,
    supportsPreview: input.preview ?? false,
    supportsCancel: input.cancel ?? false,
    idempotency: input.idempotency ?? (input.risk === 'read' ? 'not_applicable' : 'required'),
    implementation: input.implementation ?? 'planned'
  })
}

const DEFINITIONS = [
  define({ name: 'project.get_context', risk: 'read', permissions: ['project.read'] }),
  define({ name: 'scene.get_summary', risk: 'read', permissions: ['scene.read'], implementation: 'available' }),
  define({ name: 'scene.get_elements', risk: 'read', permissions: ['scene.read'], implementation: 'available' }),
  define({ name: 'scene.render_preview', risk: 'read', permissions: ['scene.read'] }),
  define({ name: 'assets.get_metadata', risk: 'read', permissions: ['asset.read'] }),
  define({ name: 'generation.get_jobs', risk: 'read', permissions: ['generation.read'] }),
  define({ name: 'generation.get_results', risk: 'read', permissions: ['generation.read'] }),
  define({ name: 'memory.search', risk: 'read', permissions: ['memory.read'] }),
  define({ name: 'capability.load', risk: 'read', permissions: ['project.read'] }),
  define({
    name: 'scene.apply_batch', risk: 'local_reversible', permissions: ['scene.write'],
    preview: true, implementation: 'available'
  }),
  define({ name: 'scene.set_canvas', risk: 'local_reversible', permissions: ['scene.write'], preview: true, implementation: 'available' }),
  define({ name: 'scene.create_elements', risk: 'local_reversible', permissions: ['scene.write'], preview: true, implementation: 'available' }),
  define({ name: 'scene.update_elements', risk: 'local_reversible', permissions: ['scene.write'], preview: true, implementation: 'available' }),
  define({ name: 'scene.reorder_elements', risk: 'local_reversible', permissions: ['scene.write'], preview: true, implementation: 'available' }),
  define({ name: 'scene.group_elements', risk: 'local_reversible', permissions: ['scene.write'], preview: true, implementation: 'available' }),
  define({ name: 'scene.remove_elements', risk: 'local_reversible', permissions: ['scene.write'], preview: true, implementation: 'available' }),
  define({ name: 'result.place_on_canvas', risk: 'local_reversible', permissions: ['scene.write'], preview: true, implementation: 'available' }),
  define({ name: 'history.undo_batch', risk: 'local_reversible', permissions: ['scene.write'], preview: true, implementation: 'available' }),
  define({ name: 'memory.propose_candidate', risk: 'persistent_reversible', permissions: ['memory.write'], preview: true, implementation: 'available' }),
  define({ name: 'memory.commit_confirmed', risk: 'persistent_reversible', permissions: ['memory.write'], preview: true }),
  define({ name: 'directive.update_confirmed', risk: 'persistent_reversible', permissions: ['directive.write'], preview: true, implementation: 'available' }),
  define({ name: 'generation.prepare_job', risk: 'external', permissions: ['generation.create', 'external.image'], preview: true, implementation: 'available' }),
  define({ name: 'generation.create_job', risk: 'external', permissions: ['generation.create', 'external.image'], preview: true, cancel: true, implementation: 'available' }),
  define({ name: 'generation.cancel_job', risk: 'external', permissions: ['generation.cancel'], cancel: true, implementation: 'available' }),
  define({ name: 'generation.subscribe_job', risk: 'read', permissions: ['generation.read'], implementation: 'available' }),
  define({ name: 'generation.place_result', risk: 'local_reversible', permissions: ['scene.write'], preview: true, implementation: 'available' })
] as const

export class AgentToolRegistry {
  readonly #definitions = new Map(DEFINITIONS.map((definition) => [definition.name, definition]))

  list(): readonly AgentToolDefinitionSnapshot[] {
    return [...this.#definitions.values()].map((definition) => ({
      ...definition,
      requiredPermissions: [...definition.requiredPermissions]
    }))
  }

  get(name: string): AgentToolDefinitionSnapshot | null {
    const definition = this.#definitions.get(name)
    return definition === undefined ? null : {
      ...definition,
      requiredPermissions: [...definition.requiredPermissions]
    }
  }

  require(name: string): AgentToolDefinitionSnapshot {
    const definition = this.get(name)
    if (definition === null) throw new Error(`Agent tool ${name} is not registered.`)
    return definition
  }
}

export const STATIC_AGENT_TOOL_REGISTRY = new AgentToolRegistry()

/**
 * Planner-facing aliases are kept beside the authoritative runtime registry so
 * prompts, validation and recovery never maintain independent tool lists.
 */
export const PLANNER_TOOL_KIND_TO_REGISTRY_NAME = Object.freeze({
  scene_batch: 'scene.apply_batch',
  'scene.get_summary': 'scene.get_summary',
  'scene.get_elements': 'scene.get_elements',
  'scene.set_canvas': 'scene.set_canvas',
  'scene.create_elements': 'scene.create_elements',
  'scene.update_elements': 'scene.update_elements',
  'scene.reorder_elements': 'scene.reorder_elements',
  'scene.group_elements': 'scene.group_elements',
  'scene.remove_elements': 'scene.remove_elements',
  'history.undo_batch': 'history.undo_batch',
  'result.place_on_canvas': 'result.place_on_canvas',
  generation: 'generation.create_job',
  canvas_generation: 'generation.create_job',
  canvas_edit: 'generation.create_job',
  cancel_generation: 'generation.cancel_job',
  memory_candidate: 'memory.propose_candidate',
  directive_create: 'directive.update_confirmed',
  place_generation_result: 'generation.place_result'
} as const)

export type PlannerToolKind = keyof typeof PLANNER_TOOL_KIND_TO_REGISTRY_NAME

export function availablePlannerToolKinds(registry: AgentToolRegistry = STATIC_AGENT_TOOL_REGISTRY): readonly PlannerToolKind[] {
  return (Object.entries(PLANNER_TOOL_KIND_TO_REGISTRY_NAME) as [PlannerToolKind, string][])
    .filter(([, runtimeName]) => registry.get(runtimeName)?.implementation === 'available')
    .map(([kind]) => kind)
}
