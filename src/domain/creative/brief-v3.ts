import {
  creativeBriefV2Schema,
  creativeBriefV3Schema,
  newCreativeBriefV3Schema,
  type CreativeBrief,
  type CreativeBriefAcceptanceCriterion,
  type CreativeBriefFieldSource,
  type CreativeBriefV2,
  type CreativeBriefV3
} from './schema'

export const CREATIVE_BRIEF_V3_SOURCE_PATHS = [
  '/originalRequirement',
  '/purpose',
  '/intent',
  '/theme',
  '/media',
  '/mood',
  '/usage',
  '/aspectPreference',
  '/subjects',
  '/text',
  '/composition',
  '/compositionNotes',
  '/style',
  '/palette',
  '/lighting',
  '/keep',
  '/prohibitions',
  '/constraints',
  '/ambiguities',
  '/precision',
  '/generationIntent',
  '/audience',
  '/acceptanceCriteria'
] as const

type CreativeBriefV3SourcePath = typeof CREATIVE_BRIEF_V3_SOURCE_PATHS[number]

type CreativeBriefV3MutableFields = Omit<
  CreativeBriefV3,
  'version' | 'id' | 'fieldSources' | 'supersedesId' | 'createdAt'
>

export interface CreativeBriefV3Metadata {
  readonly id: string
  readonly createdAt: string
  readonly supersedesId: string | null
}

export interface AuthorCreativeBriefV3Input extends CreativeBriefV3Metadata {
  readonly brief: CreativeBriefV2
  readonly audience?: readonly string[]
  readonly acceptanceCriteria?: readonly CreativeBriefAcceptanceCriterion[]
  readonly defaultSourceId?: string | null
  readonly defaultEvidence?: string | null
  readonly fieldSources?: readonly CreativeBriefFieldSource[]
}

export interface ReviseCreativeBriefV3Input {
  readonly id: string
  readonly createdAt: string
  readonly changes: Partial<CreativeBriefV3MutableFields>
  readonly sourceId?: string | null
  readonly evidence?: string | null
}

function boundedEvidence(value: string | null | undefined): string | null {
  const normalized = value?.trim().slice(0, 1_000) ?? ''
  return normalized.length === 0 ? null : normalized
}

function topLevelPath(key: keyof CreativeBriefV3MutableFields): CreativeBriefV3SourcePath {
  return `/${key}` as CreativeBriefV3SourcePath
}

function sourceMap(
  fallback: CreativeBriefFieldSource,
  overrides: readonly CreativeBriefFieldSource[]
): CreativeBriefFieldSource[] {
  const byPath = new Map<string, CreativeBriefFieldSource>()
  for (const path of CREATIVE_BRIEF_V3_SOURCE_PATHS) byPath.set(path, { ...fallback, path })
  for (const source of overrides) byPath.set(source.path, source)
  return [...byPath.values()]
}

/**
 * Loss-minimising structural projection used only when a persisted v1 Brief is
 * explicitly revised. It does not mutate or rewrite the stored v1 document.
 */
export function projectLegacyBriefToV2(brief: Exclude<CreativeBrief, CreativeBriefV3>): CreativeBriefV2 {
  if (brief.version === 2) return brief
  return creativeBriefV2Schema.parse({
    version: 2,
    id: brief.id,
    originalRequirement: brief.originalRequirement,
    purpose: brief.usage ?? brief.intent,
    intent: brief.intent,
    theme: brief.theme,
    media: brief.media,
    mood: brief.mood,
    usage: brief.usage,
    aspectPreference: brief.aspectPreference,
    subjects: brief.subjects,
    text: brief.text,
    composition: brief.composition,
    compositionNotes: [],
    style: [],
    palette: brief.palette,
    lighting: brief.lighting,
    keep: brief.constraints,
    prohibitions: [],
    constraints: brief.constraints,
    ambiguities: [],
    precision: 'ambiguous',
    generationIntent: brief.generationIntent
  })
}

/** Creates a new, fully attributed v3 Brief. Migration sentinels are rejected. */
export function authorCreativeBriefV3(input: AuthorCreativeBriefV3Input): CreativeBriefV3 {
  const defaultEvidence = boundedEvidence(input.defaultEvidence)
  const baseSource: CreativeBriefFieldSource = {
    path: '/intent',
    source: 'agent_inference',
    sourceId: input.defaultSourceId ?? null,
    evidence: defaultEvidence
  }
  return newCreativeBriefV3Schema.parse({
    ...input.brief,
    version: 3,
    id: input.id,
    audience: [...(input.audience ?? [])],
    acceptanceCriteria: [...(input.acceptanceCriteria ?? [])],
    fieldSources: sourceMap(baseSource, input.fieldSources ?? []),
    supersedesId: input.supersedesId,
    createdAt: input.createdAt
  })
}

/**
 * Explicitly upgrades and revises any historical Brief. Unchanged legacy
 * fields remain honestly unattributed; only changed fields receive a new
 * user/scene/Agent source. Reading alone never calls this function.
 */
export function reviseCreativeBriefToV3(brief: CreativeBrief, input: ReviseCreativeBriefV3Input): CreativeBriefV3 {
  const base = brief.version === 3
    ? brief
    : {
        ...projectLegacyBriefToV2(brief),
        audience: [],
        acceptanceCriteria: [],
        fieldSources: sourceMap({
          path: '/intent',
          source: 'legacy_unattributed',
          sourceId: null,
          evidence: null
        }, []),
        supersedesId: null,
        createdAt: input.createdAt
      }
  const changedSources = Object.keys(input.changes).map((key) => ({
    path: topLevelPath(key as keyof CreativeBriefV3MutableFields),
    source: 'user' as const,
    sourceId: input.sourceId ?? null,
    evidence: boundedEvidence(input.evidence)
  }))
  const sources = new Map(base.fieldSources.map((source) => [source.path, source]))
  for (const source of changedSources) sources.set(source.path, source)
  return creativeBriefV3Schema.parse({
    ...base,
    ...input.changes,
    version: 3,
    id: input.id,
    fieldSources: [...sources.values()],
    supersedesId: brief.id,
    createdAt: input.createdAt
  })
}

