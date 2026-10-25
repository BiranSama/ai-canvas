import { act, fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type { SceneElement } from '../../src/domain'
import { ImageBlendSection } from '../../src/renderer/src/components/ImageBlendSection'

const IMAGE = {
  id: '50000000-0000-4000-8000-000000000001', version: 1, type: 'image', name: '主体', description: '',
  transform: { x: 0.2, y: 0.2, width: 0.5, height: 0.5, rotation: 0 }, zIndex: 0, opacity: 1, blendMode: 'normal', visible: true, locked: false,
  groupId: null, semanticRole: 'content', referencePolicy: 'include', assetId: '50000000-0000-4000-8000-000000000002',
  crop: { x: 0, y: 0, width: 1, height: 1 }, fit: 'fill', referenceRole: 'general'
} as Extract<SceneElement, { type: 'image' }>

it('measures tone in Main and sets feather and shadow as layer effects', async () => {
  const colorMatch = { gain: [1, 1, 1] as [number, number, number], offset: [-10, 0, 12] as [number, number, number] }
  const matchImageTone = vi.fn(async () => ({ colorMatch, opaque: true }))
  Object.defineProperty(window, 'desktop', { configurable: true, value: { matchImageTone } })
  const onChange = vi.fn()
  const { rerender } = render(<ImageBlendSection element={IMAGE} onChange={onChange} />)

  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '色调往周围靠：中' })) })
  expect(matchImageTone).toHaveBeenCalledWith({ elementId: IMAGE.id, strength: 0.4 })
  expect(onChange).toHaveBeenLastCalledWith({ colorMatch, feather: 0, shadow: null })

  const withTone = { ...IMAGE, effects: { colorMatch, feather: 0, shadow: null } }
  rerender(<ImageBlendSection element={withTone} onChange={onChange} />)
  fireEvent.change(screen.getByRole('slider', { name: '边缘羽化' }), { target: { value: '0.05' } })
  expect(onChange).toHaveBeenLastCalledWith({ colorMatch, feather: 0.05, shadow: null })
  fireEvent.change(screen.getByRole('slider', { name: '投影' }), { target: { value: '1' } })
  expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ shadow: expect.objectContaining({ opacity: 0.55 }) }))
  fireEvent.click(screen.getByRole('button', { name: '还原' }))
  expect(onChange).toHaveBeenLastCalledWith({ colorMatch: null, feather: 0, shadow: null })

  matchImageTone.mockResolvedValueOnce(null as never)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '色调往周围靠：强' })) })
  expect(screen.getByRole('alert')).toHaveTextContent('量不了这张图周围的颜色')
})
