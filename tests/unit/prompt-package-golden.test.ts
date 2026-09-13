import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createScene } from '../../src/domain'
import { compilePromptIr, compilePromptPackage } from '../../src/main/reference'
import { promptPackageSchema } from '../../src/shared/reference'
import { createSemanticFixtureScene, deterministicFixtureIds, SEMANTIC_FIXTURES } from '../helpers/semantic-fixtures'

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

describe('Prompt Package deterministic golden', () => {
  it('compiles the complete normalized package without provider-specific Scene mutation', async () => {
    const fixture = SEMANTIC_FIXTURES[0]
    const base = createScene({
      id: '38000000-0000-4000-8000-000000000001',
      projectId: '38000000-0000-4000-8000-000000000002',
      now: '2026-08-14T00:00:00.000Z'
    })
    const created = await createSemanticFixtureScene(base, fixture)
    const sceneBefore = structuredClone(created.scene)
    const ir = compilePromptIr(created.scene, fixture.request, '2026-08-14T01:02:03.000Z')
    const compile = () => compilePromptPackage(created.scene, ir, {
      appearanceCompositeAssetId: '38000000-0000-4000-8000-000000000003',
      semanticSheetAssetId: '38000000-0000-4000-8000-000000000004'
    }, {
      idFactory: deterministicFixtureIds('39'),
      compiledAt: '2026-08-14T01:02:03.000Z',
      renderTier: 'mock-draft',
      providerId: 'mock',
      model: 'mock-fast-draft',
      capabilities: { imageReferences: true, multipleReferences: true, maskEditing: true }
    })
    const first = compile()
    expect(compile()).toEqual(first)
    expect(hash(first)).toBe('e2bac758898f2cf63740639050c12498ebbf72c07fd6cd16ef8cfddb70f1df17')
    expect(first).toMatchObject({
      sceneIntent: { purpose: '用于海报的可编辑视觉方向探索', originalRequirement: fixture.request },
      compositionContract: expect.arrayContaining([expect.stringContaining('4:5')]),
      elementBriefs: expect.arrayContaining([expect.objectContaining({
        semanticRole: 'subject',
        controlIntent: expect.objectContaining({ kind: 'subject', priority: 'must' }),
        provenance: expect.objectContaining({ origin: 'agent-local' })
      }), expect.objectContaining({
        type: 'group',
        semanticRole: 'subject-assembly',
        controlIntent: expect.objectContaining({ kind: 'group', priority: 'prefer' })
      })]),
      referenceMode: 'hybrid',
      textContract: [{ content: fixture.title, accuracy: 'balanced', mode: 'reference', visualWeight: 'secondary' }],
      referenceManifest: [
        { assetId: '38000000-0000-4000-8000-000000000003', role: 'appearance-composite', weight: .82, sourceElementId: null },
        { assetId: '38000000-0000-4000-8000-000000000004', role: 'semantic-sheet', weight: .72, sourceElementId: null }
      ],
      renderTier: 'mock-draft',
      generationProfile: { providerId: 'mock', model: 'mock-fast-draft', multipleReferences: true },
      provenance: {
        sceneId: created.scene.id,
        sceneRevision: created.scene.revision,
        directionId: created.scene.creativeContext?.selectedDirectionId,
        compiledAt: '2026-08-14T01:02:03.000Z'
      }
    })
    expect(created.scene).toEqual(sceneBefore)

    const legacyProvenance = Object.fromEntries(
      Object.entries(first.provenance).filter(([key]) => key !== 'directionId')
    )
    expect(promptPackageSchema.parse({
      ...first,
      provenance: legacyProvenance
    }).provenance.directionId).toBeUndefined()
  })
})
