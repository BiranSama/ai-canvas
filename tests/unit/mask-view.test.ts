import { afterEach, expect, it } from 'vitest'
import { useMaskState, withMaskViewSetAside } from '../../src/renderer/src/canvas/mask-state'

afterEach(() => useMaskState.setState({ editing: null, view: null }))

it('sets a mask shown alone aside while the picture is read, then shows it again', async () => {
  useMaskState.getState().setView('20000000-0000-4000-8000-000000000011', 'alone')
  const seen = await withMaskViewSetAside(() => useMaskState.getState().view)
  expect(seen).toBeNull()
  expect(useMaskState.getState().view).toEqual({ elementId: '20000000-0000-4000-8000-000000000011', mode: 'alone' })

  // A view the person picks meanwhile is kept, and a failure still brings the old one back.
  await expect(withMaskViewSetAside(() => { throw new Error('read failed') })).rejects.toThrow('read failed')
  expect(useMaskState.getState().view?.mode).toBe('alone')
  await withMaskViewSetAside(() => useMaskState.getState().setView('20000000-0000-4000-8000-000000000012', 'overlay'))
  expect(useMaskState.getState().view).toEqual({ elementId: '20000000-0000-4000-8000-000000000012', mode: 'overlay' })
})
