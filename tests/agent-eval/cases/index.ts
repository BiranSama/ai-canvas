import { defineAgentEvalCases } from '../../../src/main/agent/eval'
import { DIRECTIVE_MEMORY_CASES } from './directive-memory'
import { GENERATE_PLACE_CASES } from './generate-place'
import { LOCAL_EDIT_CASES } from './local-edit'
import { LOOK_ADVISE_CASES } from './look-advise'
import { MULTI_TURN_CASES } from './multi-turn'
import { NEW_LAYOUT_CASES } from './new-layout'
import { SAFETY_CASES } from './safety'

/** The Phase 1 agent eval set: 24 real tasks, validated against the case schema at import. */
export const AGENT_EVAL_CASES = defineAgentEvalCases([
  ...NEW_LAYOUT_CASES,
  ...LOCAL_EDIT_CASES,
  ...MULTI_TURN_CASES,
  ...DIRECTIVE_MEMORY_CASES,
  ...LOOK_ADVISE_CASES,
  ...GENERATE_PLACE_CASES,
  ...SAFETY_CASES
])
