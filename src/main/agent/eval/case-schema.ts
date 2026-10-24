import { z } from 'zod'
import { taskRelationSchema } from '../../../shared/agent-harness'
import { agentModelEvalCategorySchema, type AgentModelEvalCategory } from '../../../shared/agent-eval'

/**
 * The real-model eval set is data. Every assertion reads only engine-neutral
 * evidence: the final project state, persisted turn items and the provider
 * request log. Nothing here may refer to a planner's internal plan format.
 */

export const AGENT_EVAL_CATEGORY_LABELS: Readonly<Record<AgentModelEvalCategory, string>> = {
  new_layout: '新建版式',
  local_edit: '局部修改',
  multi_turn: '多轮与指代',
  directive_memory: '规则与记忆',
  look_advise: '看图与建议',
  generate_place: '生成与放回',
  safety: '安全与拒绝'
}

export const AGENT_EVAL_CATEGORY_COUNTS: Readonly<Record<AgentModelEvalCategory, number>> = {
  new_layout: 6,
  local_edit: 6,
  multi_turn: 4,
  directive_memory: 2,
  look_advise: 2,
  generate_place: 2,
  safety: 2
}

const elementTypeSchema = z.enum(['image', 'text', 'sketch', 'shape', 'placeholder', 'light', 'mask', 'group'])

/** Matches elements by stable, user-meaningful facts. Every given field must match. */
export const elementSelectorSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(160).optional(),
  nameIncludes: z.string().trim().min(1).max(160).optional(),
  type: elementTypeSchema.optional(),
  role: z.string().trim().min(1).max(120).optional(),
  text: z.string().min(1).max(400).optional(),
  textIncludes: z.string().min(1).max(400).optional()
}).strict().refine((selector) => Object.keys(selector).length > 0, 'An element selector needs at least one field.')

/** A list means "any of these selectors". */
const selectionSchema = z.union([elementSelectorSchema, z.array(elementSelectorSchema).min(1).max(8)])

export const sceneBaselineSchema = z.union([
  z.enum(['case_start', 'before_turn']),
  z.object({ afterSetupTurn: z.number().int().nonnegative().max(5) }).strict()
])

const boundsSchema = z.object({
  min: z.number().finite().optional(),
  max: z.number().finite().optional()
}).strict().refine((range) => range.min !== undefined || range.max !== undefined, 'A range needs min or max.')

const countSchema = z.object({
  min: z.number().int().nonnegative().optional(),
  max: z.number().int().nonnegative().optional()
}).strict()

const note = { note: z.string().trim().min(1).max(200).optional() }

export const agentEvalAssertionSchema = z.discriminatedUnion('kind', [
  // Canvas state
  z.object({ kind: z.literal('canvas_aspect'), width: z.number().int().positive(), height: z.number().int().positive(), ...note }).strict(),
  z.object({ kind: z.literal('text_present'), text: z.string().min(1).max(400), exact: z.boolean().default(false), ...note }).strict(),
  z.object({ kind: z.literal('text_absent'), text: z.string().min(1).max(400), ...note }).strict(),
  z.object({ kind: z.literal('element_exists'), select: selectionSchema, min: z.number().int().nonnegative().default(1), max: z.number().int().nonnegative().optional(), ...note }).strict(),
  z.object({ kind: z.literal('element_removed'), select: selectionSchema, baseline: sceneBaselineSchema.default('before_turn'), ...note }).strict(),
  z.object({
    kind: z.literal('no_overlap'),
    a: selectionSchema,
    b: selectionSchema,
    maxOverlap: z.number().min(0).max(1).default(0.02),
    ifPresent: z.boolean().default(false),
    ...note
  }).strict(),
  z.object({
    kind: z.literal('unchanged_except'),
    allow: z.array(elementSelectorSchema).max(20).default([]),
    allowCanvas: z.boolean().default(false),
    baseline: sceneBaselineSchema.default('before_turn'),
    ...note
  }).strict(),
  z.object({
    kind: z.literal('font_size_ratio'),
    select: selectionSchema,
    ratio: z.number().positive().max(10),
    tolerance: z.number().positive().max(1).default(0.03),
    baseline: sceneBaselineSchema.default('before_turn'),
    ...note
  }).strict(),
  z.object({
    kind: z.literal('property_matches'),
    select: selectionSchema,
    property: z.string().regex(/^[a-zA-Z]{1,40}$/),
    pattern: z.string().min(1).max(400),
    ...note
  }).strict(),
  z.object({
    kind: z.literal('transform_delta'),
    select: selectionSchema,
    baseline: sceneBaselineSchema.default('before_turn'),
    dx: boundsSchema.optional(),
    dy: boundsSchema.optional(),
    dw: boundsSchema.optional(),
    dh: boundsSchema.optional(),
    ...note
  }).strict(),
  z.object({
    kind: z.literal('transform_preserved'),
    select: selectionSchema,
    baseline: sceneBaselineSchema.default('before_turn'),
    tolerance: z.number().min(0).max(1).default(0.02),
    ...note
  }).strict(),
  z.object({ kind: z.literal('scene_changed'), baseline: sceneBaselineSchema.default('before_turn'), ...note }).strict(),
  z.object({ kind: z.literal('scene_unchanged'), baseline: sceneBaselineSchema.default('before_turn'), ...note }).strict(),
  z.object({
    kind: z.literal('replaced_with_image'),
    target: elementSelectorSchema,
    baseline: sceneBaselineSchema.default('before_turn'),
    tolerance: z.number().min(0).max(1).default(0.02),
    ...note
  }).strict(),
  // Process
  z.object({ kind: z.literal('paid_generation_requests'), ...countSchema.shape, ...note }).strict(),
  z.object({ kind: z.literal('generation_jobs'), ...countSchema.shape, ...note }).strict(),
  z.object({ kind: z.literal('confirmation_before_generation'), ...note }).strict(),
  z.object({ kind: z.literal('directive_present'), pattern: z.string().min(1).max(400), ...note }).strict(),
  // Reply text
  z.object({ kind: z.literal('reply_min_length'), chars: z.number().int().positive().max(2_000), ...note }).strict(),
  z.object({ kind: z.literal('reply_matches'), pattern: z.string().min(1).max(400), ...note }).strict()
])

export const agentEvalTurnSchema = z.object({
  text: z.string().trim().min(1).max(2_000),
  select: z.array(elementSelectorSchema).max(10).default([]),
  autoGenerate: z.boolean().default(false),
  taskRelation: taskRelationSchema.optional()
}).strict()

export const agentEvalCaseSchema = z.object({
  id: z.string().regex(/^[a-z]+(?:-[a-z]+)*-\d{2}$/),
  category: agentModelEvalCategorySchema,
  title: z.string().trim().min(1).max(160),
  /** Where the scenario and scene come from, for review. */
  source: z.string().trim().min(1).max(300),
  /** Key into the scene registry the runner receives. */
  scene: z.string().regex(/^[a-z0-9]+(?:[-:][a-z0-9]+)*$/),
  setup: z.object({
    /** Finished local mock results present before the first turn (zero cost, no HTTP). */
    generationResults: z.array(z.object({ prompt: z.string().trim().min(1).max(400) }).strict()).max(2).default([]),
    /** Earlier conversation turns, executed through the same engine before the evaluated request. */
    turns: z.array(agentEvalTurnSchema).max(3).default([])
  }).strict().default({ generationResults: [], turns: [] }),
  request: agentEvalTurnSchema,
  expectsGeneration: z.boolean().default(false),
  /** How the simulated user answers a generation confirmation. Other decisions take their default option. */
  decisions: z.object({ generation: z.enum(['approve', 'decline']).default('decline') }).strict().default({ generation: 'decline' }),
  limits: z.object({
    maxToolSteps: z.number().int().nonnegative().max(50),
    maxModelCalls: z.number().int().positive().max(30),
    maxSpendCny: z.number().positive().max(20)
  }).strict(),
  assertions: z.array(agentEvalAssertionSchema).min(1).max(30)
}).strict().superRefine((value, context) => {
  if (value.expectsGeneration && value.decisions.generation !== 'approve') {
    context.addIssue({ code: 'custom', path: ['decisions', 'generation'], message: 'A case that expects generation must approve the confirmation.' })
  }
  for (const [index, assertion] of value.assertions.entries()) {
    const paidMin = assertion.kind === 'paid_generation_requests' ? assertion.min ?? 0 : 0
    if (!value.expectsGeneration && paidMin > 0) {
      context.addIssue({ code: 'custom', path: ['assertions', index], message: 'Only a case that expects generation may require paid requests.' })
    }
    const baseline = 'baseline' in assertion ? assertion.baseline : undefined
    if (typeof baseline === 'object' && baseline.afterSetupTurn >= value.setup.turns.length) {
      context.addIssue({ code: 'custom', path: ['assertions', index, 'baseline'], message: 'The baseline refers to a setup turn that does not exist.' })
    }
  }
})

export type ElementSelector = z.infer<typeof elementSelectorSchema>
export type ElementSelection = z.infer<typeof selectionSchema>
export type SceneBaseline = z.infer<typeof sceneBaselineSchema>
export type AgentEvalAssertion = z.infer<typeof agentEvalAssertionSchema>
export type AgentEvalTurn = z.infer<typeof agentEvalTurnSchema>
export type AgentEvalCase = z.infer<typeof agentEvalCaseSchema>
export type AgentEvalCaseInput = z.input<typeof agentEvalCaseSchema>

export function defineAgentEvalCases(values: readonly AgentEvalCaseInput[]): readonly AgentEvalCase[] {
  const cases = values.map((value) => agentEvalCaseSchema.parse(value))
  const ids = new Set<string>()
  for (const entry of cases) {
    if (ids.has(entry.id)) throw new Error(`Duplicate agent eval case id ${entry.id}.`)
    ids.add(entry.id)
  }
  return cases
}
