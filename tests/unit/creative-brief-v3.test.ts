import { describe, expect, it } from 'vitest'
import {
  authorCreativeBriefV3,
  creativeBriefSchema,
  creativeBriefV2Schema,
  creativeDesignContractSchema,
  newCreativeBriefV3Schema,
  reviseCreativeBriefToV3,
  type CreativeBriefV1,
  type CreativeBriefV2
} from '../../src/domain'

const ID = {
  brief1: '62000000-0000-4000-8000-000000000001',
  brief2: '62000000-0000-4000-8000-000000000002',
  brief3: '62000000-0000-4000-8000-000000000003',
  subject: '62000000-0000-4000-8000-000000000010',
  criterion: '62000000-0000-4000-8000-000000000020',
  direction: '62000000-0000-4000-8000-000000000030'
} as const

function v1(): CreativeBriefV1 {
  return {
    version: 1,
    id: ID.brief1,
    originalRequirement: '制作一张安静的山海封面。',
    intent: '建立安静的山海视觉',
    theme: 'general',
    media: ['封面'],
    mood: ['安静'],
    usage: '出版封面',
    aspectPreference: { width: 4, height: 5 },
    subjects: [{ id: ID.subject, name: '远山', description: '雾中远山', pose: '', position: 'center', prominence: 'primary' }],
    text: [],
    composition: [],
    palette: ['#E9EEF5'],
    lighting: [],
    constraints: ['保留大面积留白'],
    generationIntent: 'none'
  }
}

function v2(): CreativeBriefV2 {
  return creativeBriefV2Schema.parse({
    version: 2,
    id: ID.brief2,
    originalRequirement: '制作一张安静的山海封面。',
    purpose: '出版封面',
    intent: '建立安静的山海视觉',
    theme: 'landscape',
    media: ['结构化草图', '封面'],
    mood: ['安静'],
    usage: '出版封面',
    aspectPreference: { width: 4, height: 5 },
    subjects: [{ id: ID.subject, name: '远山', description: '雾中远山', pose: '', position: 'center', prominence: 'primary' }],
    text: [],
    composition: [],
    compositionNotes: ['保留天空留白'],
    style: ['东方克制'],
    palette: ['#E9EEF5'],
    lighting: [],
    keep: ['大面积留白'],
    prohibitions: ['不要霓虹'],
    constraints: ['元素保持可编辑'],
    ambiguities: [],
    precision: 'precise',
    generationIntent: 'none'
  })
}

function direction(briefId: string) {
  return {
    version: 1 as const,
    id: ID.direction,
    briefId,
    capabilityPackId: 'landscape-cover',
    title: '雾层远山',
    recommended: true,
    composition: '近中远景依次展开。',
    subject: '山海雾独立。',
    typography: '文字位于天空留白。',
    palette: ['#E9EEF5'],
    lighting: '低反差漫射光。',
    localSketchCost: 'no-cost' as const,
    difference: '安静克制。'
  }
}

describe('Creative Brief v3 Decision A contracts', () => {
  it('reads historical v1 and v2 documents byte-for-structure without an implicit upgrade', () => {
    for (const legacy of [v1(), v2()]) {
      const before = JSON.stringify(legacy)
      const parsed = creativeBriefSchema.parse(legacy)
      expect(JSON.stringify(parsed)).toBe(before)
      expect(parsed.version).toBe(legacy.version)
      expect('createdAt' in parsed).toBe(false)
    }
  })

  it('creates an attributed v3 Brief and rejects the migration sentinel for new work', () => {
    const brief = authorCreativeBriefV3({
      brief: v2(),
      id: ID.brief3,
      createdAt: '2026-08-30T12:00:00.000+08:00',
      supersedesId: null,
      audience: ['偏爱安静编辑视觉的读者'],
      acceptanceCriteria: [{ id: ID.criterion, criterion: '必须保留大面积天空留白', priority: 'must' }],
      defaultEvidence: '用户要求制作一张安静的山海封面。',
      fieldSources: [{ path: '/originalRequirement', source: 'user', sourceId: null, evidence: '制作一张安静的山海封面。' }]
    })

    expect(brief).toMatchObject({ version: 3, supersedesId: null, audience: ['偏爱安静编辑视觉的读者'] })
    expect(brief.fieldSources.find((source) => source.path === '/originalRequirement')).toMatchObject({ source: 'user' })
    const illegal = {
      ...brief,
      fieldSources: brief.fieldSources.map((source) => source.path === '/intent' ? { ...source, source: 'legacy_unattributed' as const } : source)
    }
    expect(newCreativeBriefV3Schema.safeParse(illegal).success).toBe(false)
    expect(creativeBriefSchema.safeParse(illegal).success).toBe(true)
  })

  it('upgrades a legacy Brief only through an explicit revision and records honest lineage', () => {
    const revised = reviseCreativeBriefToV3(v1(), {
      id: ID.brief3,
      createdAt: '2026-08-30T12:05:00.000+08:00',
      changes: {
        originalRequirement: '制作一张安静的山海封面。\n修订：面向独立出版读者，标题更轻盈。',
        audience: ['独立出版读者'],
        acceptanceCriteria: [{ id: ID.criterion, criterion: '标题作为轻盈的排版参考，不压过主体', priority: 'must' }]
      },
      evidence: '面向独立出版读者，标题更轻盈。'
    })

    expect(revised).toMatchObject({ version: 3, id: ID.brief3, supersedesId: ID.brief1 })
    expect(revised.fieldSources.find((source) => source.path === '/purpose')).toMatchObject({ source: 'legacy_unattributed' })
    expect(revised.fieldSources.find((source) => source.path === '/audience')).toMatchObject({ source: 'user' })
  })

  it('rejects ambiguous v3 lineage and attribution records', () => {
    const brief = authorCreativeBriefV3({
      brief: v2(),
      id: ID.brief3,
      createdAt: '2026-08-30T12:00:00.000+08:00',
      supersedesId: null,
      audience: ['独立出版读者'],
      acceptanceCriteria: [{ id: ID.criterion, criterion: '必须保留天空留白', priority: 'must' }]
    })

    expect(creativeBriefSchema.safeParse({ ...brief, supersedesId: brief.id }).success).toBe(false)
    expect(creativeBriefSchema.safeParse({
      ...brief,
      acceptanceCriteria: [...brief.acceptanceCriteria, brief.acceptanceCriteria[0]]
    }).success).toBe(false)
    expect(creativeBriefSchema.safeParse({
      ...brief,
      fieldSources: [...brief.fieldSources, brief.fieldSources[0]]
    }).success).toBe(false)
    expect(creativeBriefSchema.safeParse({
      ...brief,
      fieldSources: brief.fieldSources.map((source, index) => index === 0 ? { ...source, path: 'originalRequirement' } : source)
    }).success).toBe(false)
  })

  it('keeps Creative Design Contract v1 meaning intact and adds v2 for a v3 Brief', () => {
    const legacyContract = {
      version: 1 as const,
      brief: v2(),
      directions: [direction(ID.brief2)],
      selectedDirectionId: ID.direction,
      capabilityPackIds: ['landscape-cover']
    }
    expect(creativeDesignContractSchema.parse(legacyContract)).toEqual(legacyContract)

    const brief = authorCreativeBriefV3({
      brief: v2(),
      id: ID.brief3,
      createdAt: '2026-08-30T12:00:00.000+08:00',
      supersedesId: null
    })
    expect(creativeDesignContractSchema.parse({
      ...legacyContract,
      version: 2,
      brief,
      directions: [direction(brief.id)]
    })).toMatchObject({ version: 2, brief: { version: 3 } })
  })
})
