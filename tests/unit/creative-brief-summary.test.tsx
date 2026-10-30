import { render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import { createScene } from '../../src/domain'
import { CreativeBriefSummary } from '../../src/renderer/src/components/CreativeBriefSummary'
import { createSemanticFixtureScene, SEMANTIC_FIXTURES } from '../helpers/semantic-fixtures'

it('shows each mood and style word of the brief once', async () => {
  const base = createScene({ id: '38100000-0000-4000-8000-000000000001', projectId: '38100000-0000-4000-8000-000000000002', now: '2026-08-14T00:00:00.000Z' })
  const { scene } = await createSemanticFixtureScene(base, SEMANTIC_FIXTURES[0])
  const brief = scene.creativeContext!.brief
  // The local planner writes its mood words as the style as well.
  expect(brief.version === 1 ? [] : brief.style).toEqual(brief.mood)
  render(<CreativeBriefSummary brief={brief} onRevise={() => undefined} />)
  expect(screen.getByLabelText('查看当前创作简报').querySelector('small')?.textContent).toBe(brief.mood.join(' · '))
})
